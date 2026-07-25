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

-- Lightweight cache of display names so reports don't need live fetches.
CREATE TABLE IF NOT EXISTS users (
  user_id   TEXT PRIMARY KEY,
  username  TEXT NOT NULL,
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

export function displayName(userId) {
  const row = getDb().prepare('SELECT username FROM users WHERE user_id = ?').get(userId);
  return row ? row.username : `<@${userId}>`;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = undefined;
  }
}
