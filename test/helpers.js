// Shared fixtures: a fresh in-memory database per test, and seed helpers that
// write rows the way the trackers do. Timestamps are milliseconds, like the
// schema; most tests build them relative to `now` so they land inside the
// windows resolvePeriod() produces.
import { initDatabase, closeDatabase, getDb, rememberUser } from '../src/db/database.js';
import { MINUTE, HOUR, DAY } from '../src/util/time.js';

export { MINUTE, HOUR, DAY };
export const GUILD = 'guild';

/** Throw away whatever the last test left and start from an empty schema. */
export function freshDb() {
  closeDatabase();
  return initDatabase();
}

export function seedVoice({ user, channel = 'c1', joined, left = null }) {
  rememberUser(user, user);
  getDb()
    .prepare(
      `INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at, left_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(GUILD, user, channel, joined, left, left ?? joined);
}

export function seedGame({ user, game = 'Tetris', started, ended = null }) {
  rememberUser(user, user);
  getDb()
    .prepare(
      `INSERT INTO game_sessions (guild_id, user_id, game_name, started_at, ended_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(GUILD, user, game, started, ended, ended ?? started);
}

let messageSeq = 0;

export function seedMessage({ user, channel = 'general', at, words = 3, id = null }) {
  rememberUser(user, user);
  const messageId = id ?? `m${++messageSeq}`;
  getDb()
    .prepare(
      `INSERT INTO messages (message_id, guild_id, channel_id, user_id, sent_at, char_count, word_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(messageId, GUILD, channel, user, at, words * 5, words);
  return messageId;
}

/** `n` messages from one user, spread a minute apart ending at `at`. */
export function seedMessages(user, n, at) {
  for (let i = 0; i < n; i++) seedMessage({ user, at: at - i * MINUTE });
}

export function seedReaction({ message, author, user, emoji = '👍', at }) {
  rememberUser(user, user);
  getDb()
    .prepare(
      `INSERT INTO message_reactions
         (message_id, guild_id, channel_id, author_id, user_id, emoji_name, emoji_id, reacted_at)
       VALUES (?, ?, 'general', ?, ?, ?, '', ?)`
    )
    .run(message, GUILD, author, user, emoji, at);
}

/** A stand-in for a discord.js Guild: only the member cache the code reads. */
export function fakeGuild(members) {
  const cache = new Map();
  for (const [id, opts] of Object.entries(members)) {
    cache.set(id, { id, user: { id, bot: Boolean(opts?.bot) } });
  }
  return { id: GUILD, members: { cache } };
}

/** Local-time timestamp for "yesterday at HH:MM", safely inside a week window. */
export function yesterdayAt(hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** Assert two durations agree to within a couple of seconds of clock drift. */
export function closeTo(actual, expected, tolerance = 2000) {
  return Math.abs(actual - expected) <= tolerance;
}

/** The embed field whose name starts with a prefix, or undefined. */
export function fieldOf(embed, prefix) {
  return embed.toJSON().fields?.find((f) => f.name.startsWith(prefix));
}
