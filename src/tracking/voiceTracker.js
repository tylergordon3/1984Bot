import { getDb, rememberUser } from '../db/database.js';
import { logger } from '../util/logger.js';
import { MINUTE } from '../util/time.js';

const HEARTBEAT_INTERVAL = MINUTE; // how often we refresh last_seen_at

function getOpenSession(userId) {
  return getDb()
    .prepare('SELECT * FROM voice_sessions WHERE user_id = ? AND left_at IS NULL')
    .get(userId);
}

function openSession(guildId, userId, channelId, at) {
  getDb()
    .prepare(
      `INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guildId, userId, channelId, at, at);
  logger.debug(`voice: ${userId} joined ${channelId}`);
}

function closeSession(sessionId, at) {
  getDb().prepare('UPDATE voice_sessions SET left_at = ? WHERE id = ?').run(at, sessionId);
}

/** Close whatever open session a user has (used on leave / channel move). */
function closeUserSession(userId, at) {
  const open = getOpenSession(userId);
  if (open) closeSession(open.id, at);
  return open;
}

/** discord.js voiceStateUpdate handler. */
export function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return; // never track bots (including ourselves)

  const now = Date.now();
  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;
  if (oldChannel === newChannel) return; // mute/deafen/stream toggle — not a move

  rememberUser(member.id, member.user.username);

  if (oldChannel) closeUserSession(member.id, now);
  if (newChannel) openSession(newState.guild.id, member.id, newChannel, now);
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

    const open = getOpenSession(member.id);
    if (open && open.channel_id === state.channelId) {
      db.prepare('UPDATE voice_sessions SET last_seen_at = ? WHERE id = ?').run(now, open.id);
    } else {
      if (open) closeSession(open.id, open.last_seen_at); // they moved during downtime
      openSession(guild.id, member.id, state.channelId, now);
    }
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
      }
    }
  };
  const handle = setInterval(tick, HEARTBEAT_INTERVAL);
  return () => clearInterval(handle);
}

/** Graceful shutdown: close every open session at "now". */
export function closeAllOpenVoiceSessions() {
  const now = Date.now();
  const info = getDb()
    .prepare('UPDATE voice_sessions SET left_at = ? WHERE left_at IS NULL')
    .run(now);
  if (info.changes) logger.info(`Closed ${info.changes} open voice session(s) on shutdown.`);
}
