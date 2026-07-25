import { ActivityType } from 'discord.js';
import { getDb, rememberUser } from '../db/database.js';
import { logger } from '../util/logger.js';
import { MINUTE } from '../util/time.js';

const HEARTBEAT_INTERVAL = MINUTE;

/** Names of games a presence is actively "Playing" (ignores Spotify, streaming, custom status). */
function playingGames(presence) {
  if (!presence) return [];
  return presence.activities
    .filter((a) => a.type === ActivityType.Playing && a.name)
    .map((a) => a.name);
}

function openGameSessions(userId) {
  return getDb()
    .prepare('SELECT * FROM game_sessions WHERE user_id = ? AND ended_at IS NULL')
    .all(userId);
}

function startGame(guildId, userId, name, at) {
  getDb()
    .prepare(
      `INSERT INTO game_sessions (guild_id, user_id, game_name, started_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guildId, userId, name, at, at);
  logger.info(`👁️ game start: ${userId} → "${name}"`);
}

function stopGame(sessionId, at, name, userId) {
  getDb().prepare('UPDATE game_sessions SET ended_at = ? WHERE id = ?').run(at, sessionId);
  if (name) logger.info(`👁️ game stop: ${userId} → "${name}"`);
}

/** discord.js presenceUpdate handler. */
export function handlePresenceUpdate(oldPresence, newPresence) {
  if (!newPresence) return;
  // Work off the presence's ids directly so a cold member cache can't drop events.
  const guildId = newPresence.guild?.id;
  const userId = newPresence.userId || newPresence.member?.id;
  const user = newPresence.user || newPresence.member?.user;
  if (!guildId || !userId || user?.bot) return;

  const before = new Set(playingGames(oldPresence));
  const after = new Set(playingGames(newPresence));
  logger.debug(
    `presenceUpdate ${userId}: [${[...before].join(', ')}] -> [${[...after].join(', ')}]`
  );
  if (before.size === 0 && after.size === 0) return;

  const now = Date.now();
  rememberUser(userId, user?.username || userId);

  const open = openGameSessions(userId);
  const openByName = new Map(open.map((s) => [s.game_name, s]));

  // Newly started games.
  for (const name of after) {
    if (!openByName.has(name)) startGame(guildId, userId, name, now);
  }
  // Games that stopped.
  for (const session of open) {
    if (!after.has(session.game_name)) stopGame(session.id, now, session.game_name, userId);
  }
}

export function reconcileGames(guild) {
  const now = Date.now();
  const db = getDb();
  const activeByUser = new Map(); // userId -> Set(gameNames)

  logger.info(`Reconcile: ${guild.presences.cache.size} presences in cache.`);
  // TEMP diagnostic: dump exactly what Discord sent for each cached presence.
  for (const p of guild.presences.cache.values()) {
    const acts =
      p.activities.map((a) => `"${a.name}"(type ${a.type})`).join(', ') || 'none';
    logger.info(`  • ${p.user?.username || p.userId} status=${p.status} activities=[${acts}]`);
  }
  for (const presence of guild.presences.cache.values()) {
    const userId = presence.userId || presence.member?.id;
    const user = presence.user || presence.member?.user;
    if (!userId || user?.bot) continue;
    const games = playingGames(presence);
    if (games.length === 0) continue;
    activeByUser.set(userId, new Set(games));
    rememberUser(userId, user?.username || userId);

    const open = openGameSessions(userId);
    const openNames = new Set(open.map((s) => s.game_name));
    for (const name of games) {
      if (!openNames.has(name)) startGame(guild.id, userId, name, now);
      else {
        const s = open.find((o) => o.game_name === name);
        db.prepare('UPDATE game_sessions SET last_seen_at = ? WHERE id = ?').run(now, s.id);
      }
    }
  }

  // Close any open game session that is no longer active, at its last-seen time.
  let closed = 0;
  const open = db.prepare('SELECT * FROM game_sessions WHERE ended_at IS NULL').all();
  for (const s of open) {
    const active = activeByUser.get(s.user_id);
    if (!active || !active.has(s.game_name)) {
      stopGame(s.id, s.last_seen_at);
      closed++;
    }
  }
  logger.info(`Games reconciled: ${activeByUser.size} players active, ${closed} orphaned sessions closed.`);
}

export function startGameHeartbeat(client) {
  const tick = () => {
    const now = Date.now();
    const db = getDb();
    const open = db.prepare('SELECT id, user_id, game_name FROM game_sessions WHERE ended_at IS NULL').all();
    for (const row of open) {
      let stillPlaying = false;
      for (const guild of client.guilds.cache.values()) {
        const presence = guild.presences.cache.get(row.user_id);
        if (presence && playingGames(presence).includes(row.game_name)) {
          stillPlaying = true;
          break;
        }
      }
      if (stillPlaying) {
        db.prepare('UPDATE game_sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
      }
    }
  };
  const handle = setInterval(tick, HEARTBEAT_INTERVAL);
  return () => clearInterval(handle);
}

export function closeAllOpenGameSessions() {
  const now = Date.now();
  const info = getDb().prepare('UPDATE game_sessions SET ended_at = ? WHERE ended_at IS NULL').run(now);
  if (info.changes) logger.info(`Closed ${info.changes} open game session(s) on shutdown.`);
}
