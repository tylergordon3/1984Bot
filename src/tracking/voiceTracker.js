import { getDb, rememberUser, logName } from '../db/database.js';
import { logger } from '../util/logger.js';
import { MINUTE } from '../util/time.js';

const HEARTBEAT_INTERVAL = MINUTE; // how often we refresh last_seen_at

function getOpenSessions(userId) {
  return getDb()
    .prepare('SELECT * FROM voice_sessions WHERE user_id = ? AND left_at IS NULL ORDER BY joined_at')
    .all(userId);
}

function openSession(guildId, userId, channelId, at) {
  getDb()
    .prepare(
      `INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guildId, userId, channelId, at, at);
  logger.debug(`voice: ${logName(userId)} joined ${channelId}`);
}

function closeSession(sessionId, at) {
  getDb().prepare('UPDATE voice_sessions SET left_at = ? WHERE id = ?').run(at, sessionId);
}

/**
 * Ensure the user has exactly one open session, matching `channelId` (or none if
 * they've left). Closes any extras — this makes tracking idempotent and self-heals
 * duplicate sessions that older buggy events may have created. Returns true if a
 * session for `channelId` is already open (so the caller shouldn't open another).
 */
function reconcileUserSessions(userId, channelId, at) {
  const open = getOpenSessions(userId);
  const keep = channelId ? open.find((s) => s.channel_id === channelId) : undefined;
  for (const s of open) {
    if (!keep || s.id !== keep.id) closeSession(s.id, at);
  }
  return Boolean(keep);
}

// ── Flag (streaming / muted / deafened / video) mini-sessions ───────────────

/** Which states are active for a voice state. Deafened supersedes muted. */
function flagsOf(state) {
  const active = new Set();
  if (!state || !state.channelId) return active;
  if (state.deaf) active.add('deafened');
  else if (state.mute) active.add('muted'); // muted-but-not-deafened
  if (state.streaming) active.add('streaming');
  if (state.selfVideo) active.add('video');
  return active;
}

function getOpenFlags(userId) {
  return getDb()
    .prepare('SELECT * FROM voice_flags WHERE user_id = ? AND ended_at IS NULL')
    .all(userId);
}

function openFlag(guildId, userId, channelId, flag, at) {
  getDb()
    .prepare(
      `INSERT INTO voice_flags (guild_id, user_id, channel_id, flag, started_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(guildId, userId, channelId, flag, at, at);
  logger.debug(`flag on: ${logName(userId)} ${flag}`);
}

function closeFlag(id, at) {
  getDb().prepare('UPDATE voice_flags SET ended_at = ? WHERE id = ?').run(at, id);
}

function closeUserFlags(userId, at) {
  for (const f of getOpenFlags(userId)) closeFlag(f.id, at);
}

/** Reconcile a user's open flag rows against their currently-active flags. */
function syncFlags(guildId, userId, channelId, active, at) {
  const open = getOpenFlags(userId);
  const openNames = new Set(open.map((o) => o.flag));
  for (const flag of active) {
    if (!openNames.has(flag)) openFlag(guildId, userId, channelId, flag, at);
  }
  for (const o of open) {
    if (!active.has(o.flag)) closeFlag(o.id, at);
  }
}

/**
 * discord.js voiceStateUpdate handler.
 *
 * Driven by the DB's actual open-session state rather than `oldState.channelId`,
 * which can come back null after a gateway reconnect and would otherwise spawn a
 * duplicate concurrent session. Guarantees at most one open session per user.
 */
export function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return; // never track bots (including ourselves)

  const now = Date.now();
  const newChannel = newState.channelId;

  rememberUser(member.id, member.user.username);

  if (!newChannel) {
    // Left voice entirely: close session(s) and flags.
    reconcileUserSessions(member.id, null, now);
    closeUserFlags(member.id, now);
    return;
  }

  // In a channel: keep/collapse to a single open session for it, opening one if needed.
  const alreadyOpen = reconcileUserSessions(member.id, newChannel, now);
  if (!alreadyOpen) {
    closeUserFlags(member.id, now); // fresh session (join or move) — flags re-sync below
    openSession(newState.guild.id, member.id, newChannel, now);
  }

  // Flag transitions — also fires for same-channel mute/deafen/stream/video toggles.
  syncFlags(newState.guild.id, member.id, newChannel, flagsOf(newState), now);
}

/**
 * On startup: adopt sessions for anyone already connected, and close sessions
 * orphaned by a crash at their last-seen time (best estimate of when we lost them).
 */
export function reconcileVoice(guild) {
  const now = Date.now();
  const db = getDb();
  const connected = new Set();

  for (const state of guild.voiceStates.cache.values()) {
    const member = state.member;
    if (!state.channelId || !member || member.user.bot) continue;
    connected.add(member.id);
    rememberUser(member.id, member.user.username);

    // Collapse to a single open session for their current channel; close extras /
    // moved sessions at their last-seen time (best estimate of the real end).
    const open = getOpenSessions(member.id);
    const keep = open.find((s) => s.channel_id === state.channelId);
    for (const s of open) {
      if (!keep || s.id !== keep.id) closeSession(s.id, s.last_seen_at);
    }
    if (keep) {
      db.prepare('UPDATE voice_sessions SET last_seen_at = ? WHERE id = ?').run(now, keep.id);
    } else {
      openSession(guild.id, member.id, state.channelId, now);
    }
    // Adopt current flag states (opens new flag rows, keeps matching ones).
    syncFlags(guild.id, member.id, state.channelId, flagsOf(state), now);
    db.prepare(
      'UPDATE voice_flags SET last_seen_at = ? WHERE user_id = ? AND ended_at IS NULL'
    ).run(now, member.id);
  }

  // Anyone with an open session who is NOT currently connected left while we were down.
  const orphans = db
    .prepare('SELECT id, last_seen_at FROM voice_sessions WHERE left_at IS NULL')
    .all();
  let closed = 0;
  for (const row of orphans) {
    // The above loop only touched still-connected users; the rest are orphans.
    const stillOpen = db
      .prepare('SELECT user_id FROM voice_sessions WHERE id = ? AND left_at IS NULL')
      .get(row.id);
    if (stillOpen && !connected.has(stillOpen.user_id)) {
      closeSession(row.id, row.last_seen_at);
      closed++;
    }
  }

  // Close flag rows orphaned by a crash (user no longer connected).
  for (const f of db.prepare('SELECT * FROM voice_flags WHERE ended_at IS NULL').all()) {
    if (!connected.has(f.user_id)) closeFlag(f.id, f.last_seen_at);
  }
  logger.info(`Voice reconciled: ${connected.size} active, ${closed} orphaned sessions closed.`);
}

/** Periodic heartbeat so crash recovery has a recent "last seen" to close against. */
export function startVoiceHeartbeat(client) {
  const tick = () => {
    const now = Date.now();
    const db = getDb();
    const open = db.prepare('SELECT id, user_id FROM voice_sessions WHERE left_at IS NULL').all();
    for (const row of open) {
      // Only refresh if the user is genuinely still in a voice channel somewhere.
      let present = false;
      for (const guild of client.guilds.cache.values()) {
        const state = guild.voiceStates.cache.get(row.user_id);
        if (state && state.channelId) {
          present = true;
          break;
        }
      }
      if (present) {
        db.prepare('UPDATE voice_sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
        db.prepare(
          'UPDATE voice_flags SET last_seen_at = ? WHERE user_id = ? AND ended_at IS NULL'
        ).run(now, row.user_id);
      }
    }
  };
  const handle = setInterval(tick, HEARTBEAT_INTERVAL);
  return () => clearInterval(handle);
}

/** Graceful shutdown: close every open session and flag at "now". */
export function closeAllOpenVoiceSessions() {
  const now = Date.now();
  const info = getDb()
    .prepare('UPDATE voice_sessions SET left_at = ? WHERE left_at IS NULL')
    .run(now);
  const flags = getDb()
    .prepare('UPDATE voice_flags SET ended_at = ? WHERE ended_at IS NULL')
    .run(now);
  if (info.changes || flags.changes) {
    logger.info(
      `Closed ${info.changes} open voice session(s) and ${flags.changes} flag(s) on shutdown.`
    );
  }
}
