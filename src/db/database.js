import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

// Schema. All timestamps are Unix epoch milliseconds.
// The two *_sessions tables are the single source of truth; every statistic
// (leaderboards, co-presence, time-of-day) is derived from them at query time,
// so nothing is lost across restarts as long as sessions are reconciled on boot.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS voice_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  channel_id   TEXT    NOT NULL,
  joined_at    INTEGER NOT NULL,
  left_at      INTEGER,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_user   ON voice_sessions (user_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_voice_chan   ON voice_sessions (channel_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_voice_open   ON voice_sessions (left_at) WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS game_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  game_name    TEXT    NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_user  ON game_sessions (user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_game_name  ON game_sessions (game_name, started_at);
CREATE INDEX IF NOT EXISTS idx_game_open  ON game_sessions (ended_at) WHERE ended_at IS NULL;

-- Per-flag mini-sessions within voice: streaming / muted / deafened / video.
-- Each active flag is its own open row, closed when the flag clears or the user
-- leaves. Aggregated the same clamped way as voice_sessions.
CREATE TABLE IF NOT EXISTS voice_flags (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  channel_id   TEXT    NOT NULL,
  flag         TEXT    NOT NULL,   -- 'streaming' | 'muted' | 'deafened' | 'video'
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flag_user ON voice_flags (user_id, flag, started_at);
CREATE INDEX IF NOT EXISTS idx_flag_name ON voice_flags (flag, started_at);
CREATE INDEX IF NOT EXISTS idx_flag_open ON voice_flags (ended_at) WHERE ended_at IS NULL;

-- One row per tracked message. Discrete events rather than sessions, so stats
-- are plain counts over a window; hour-of-day is derived at query time from
-- sent_at so nothing is denormalised.
CREATE TABLE IF NOT EXISTS messages (
  message_id    TEXT PRIMARY KEY,
  guild_id      TEXT    NOT NULL,
  channel_id    TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  sent_at       INTEGER NOT NULL,
  char_count    INTEGER NOT NULL DEFAULT 0,
  word_count    INTEGER NOT NULL DEFAULT 0,
  attachments   INTEGER NOT NULL DEFAULT 0,
  has_link      INTEGER NOT NULL DEFAULT 0,
  mention_count INTEGER NOT NULL DEFAULT 0,
  is_reply      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages (user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_msg_chan ON messages (channel_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_msg_time ON messages (sent_at);

-- Who tagged whom. At most one row per (message, target): an @mention and a
-- reply-ping to the same person collapse into a single tag, with the kind
-- column recording which one it was, so counts are never double-inflated.
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id   TEXT    NOT NULL,
  guild_id     TEXT    NOT NULL,
  channel_id   TEXT    NOT NULL,
  from_user_id TEXT    NOT NULL,
  to_user_id   TEXT    NOT NULL,
  kind         TEXT    NOT NULL,   -- 'mention' | 'reply'
  sent_at      INTEGER NOT NULL,
  PRIMARY KEY (message_id, to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_mention_to   ON message_mentions (to_user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_mention_from ON message_mentions (from_user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_mention_pair ON message_mentions (from_user_id, to_user_id);

-- NWS alerts already posted to Discord, so restarts don't repost an active
-- warning. One row per (alert, watched location), since one storm system can
-- cover two locations. Rows are pruned after a week; ids aren't reused sooner.
CREATE TABLE IF NOT EXISTS weather_alerts_sent (
  alert_id TEXT NOT NULL,
  location TEXT NOT NULL,
  event    TEXT NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (alert_id, location)
);

-- Watched weather locations, managed by the /weather command (seeded once
-- from WEATHER_LOCATIONS in .env if the table is empty at boot).
CREATE TABLE IF NOT EXISTS weather_locations (
  name       TEXT PRIMARY KEY COLLATE NOCASE,
  lat        TEXT NOT NULL,
  lon        TEXT NOT NULL,
  added_by   TEXT NOT NULL,   -- user id, or 'env' for seeded rows
  created_at INTEGER NOT NULL
);

-- Who gets pinged when a watched location gets a warning.
CREATE TABLE IF NOT EXISTS weather_subscribers (
  location_name TEXT NOT NULL COLLATE NOCASE,
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (location_name, user_id)
);

-- Discord user → SmiteSource player-page UUID, linked via /smite link, so
-- SMITE session announcements can point at the member's live profile.
CREATE TABLE IF NOT EXISTS smite_players (
  user_id     TEXT PRIMARY KEY,
  player_uuid TEXT NOT NULL,
  linked_at   INTEGER NOT NULL
);

-- Lightweight cache of display names so reports don't need live fetches.
CREATE TABLE IF NOT EXISTS users (
  user_id   TEXT PRIMARY KEY,
  username  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Same idea for channels, so message reports can print #the-resources.
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

let db;

export function initDatabase() {
  const dbPath = config.databasePath;
  const dir = path.dirname(dbPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Early builds keyed weather_alerts_sent on alert_id alone; drop so the
  // per-location schema below can take its place (only dedupe cache is lost).
  const weatherCols = db.pragma(`table_info(weather_alerts_sent)`).map((c) => c.name);
  if (weatherCols.length > 0 && !weatherCols.includes('location')) {
    db.exec('DROP TABLE weather_alerts_sent');
  }
  db.exec(SCHEMA);
  logger.info(`Database ready at ${dbPath}`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialised. Call initDatabase() first.');
  return db;
}

/** Upsert a display name into the users cache. */
export function rememberUser(userId, username) {
  getDb()
    .prepare(
      `INSERT INTO users (user_id, username, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, updated_at = excluded.updated_at`
    )
    .run(userId, username, Date.now());
}

/** Upsert a channel name into the channels cache. */
export function rememberChannel(channelId, name) {
  if (!channelId || !name) return;
  getDb()
    .prepare(
      `INSERT INTO channels (channel_id, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
    )
    .run(channelId, name, Date.now());
}

export function channelName(channelId) {
  const row = getDb().prepare('SELECT name FROM channels WHERE channel_id = ?').get(channelId);
  return row ? `#${row.name}` : `<#${channelId}>`;
}

export function displayName(userId) {
  const row = getDb().prepare('SELECT username FROM users WHERE user_id = ?').get(userId);
  return row ? row.username : `<@${userId}>`;
}

/** Like displayName but for plain-text logs: falls back to the raw id, no mention. */
export function logName(userId) {
  const row = getDb().prepare('SELECT username FROM users WHERE user_id = ?').get(userId);
  return row ? row.username : userId;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = undefined;
  }
}
