// Bookkeeping for milestone announcements: what has been awarded, and what the
// standing records are. An award's `key` is its identity, so nothing is ever
// announced twice; record keys are updated in place as they're beaten.
import { getDb } from '../db/database.js';

const SEED_KEY = '__seeded__';

/**
 * Has the baseline been taken? Until it has, everything already achieved
 * counts as history and is recorded silently rather than announced.
 */
export function isSeeded() {
  return !!getDb().prepare('SELECT 1 FROM milestones_awarded WHERE key = ?').get(SEED_KEY);
}

export function markSeeded() {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO milestones_awarded (key, kind, awarded_at) VALUES (?, 'meta', ?)`
    )
    .run(SEED_KEY, Date.now());
}

export function hasAward(key) {
  return !!getDb().prepare('SELECT 1 FROM milestones_awarded WHERE key = ?').get(key);
}

/** The stored value for a key (records), or null if it has never been set. */
export function awardValue(key) {
  return getDb().prepare('SELECT * FROM milestones_awarded WHERE key = ?').get(key) || null;
}

/**
 * Record an award. Records overwrite in place; one-shot awards insert once.
 * `at` is 0 for baseline rows, which is what keeps the history taken on first
 * run out of "recently filed".
 */
export function record({ key, kind, userId = null, detail = null, value = null, at = Date.now() }) {
  getDb()
    .prepare(
      `INSERT INTO milestones_awarded (key, kind, user_id, detail, value, awarded_at)
       VALUES (@key, @kind, @userId, @detail, @value, @at)
       ON CONFLICT(key) DO UPDATE SET
         user_id = excluded.user_id,
         detail  = excluded.detail,
         value   = excluded.value,
         awarded_at = excluded.awarded_at`
    )
    .run({ key, kind, userId, detail, value, at });
}

/** Most recently announced milestones, newest first. Baseline rows (awarded_at
 *  0) were never announced, so they never appear here. */
export function recentAwards(limit = 10) {
  return getDb()
    .prepare(
      `SELECT * FROM milestones_awarded
       WHERE kind != 'meta' AND awarded_at > 0
       ORDER BY awarded_at DESC
       LIMIT ?`
    )
    .all(limit);
}

/** The standing records, in the order they're worth reading. */
export function standingRecords() {
  return getDb()
    .prepare(`SELECT * FROM milestones_awarded WHERE key LIKE 'record:%' ORDER BY key`)
    .all();
}
