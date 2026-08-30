// Streaks: consecutive local days on which someone joined a voice channel.
// Any time at all counts -- a minute is the same as ten hours -- but it has to
// be voice: chat and game time are tracked elsewhere and don't keep a streak
// alive. A day is the server's local calendar day, the same basis the hour
// histograms use.
//
// A streak is alive while its last day is today or yesterday: nobody's streak
// breaks at midnight, it breaks when a whole day passes without them. That
// also means a run ending before yesterday is finished, which is what makes
// "the streak has ended" detectable from the data alone.
import { getDb } from '../db/database.js';

// Guard against a corrupt session with an absurd end date turning the day
// expansion into an infinite loop.
const MAX_SESSION_DAYS = 400;

/** Local calendar day, e.g. "2026-08-29". */
export function dayKey(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

/** The day before a day key, via Date arithmetic so DST can't shift it. */
function previousDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 1);
  return dayKey(date.getTime());
}

function today() {
  return dayKey(Date.now());
}

/** Every day a voice session touched, midnight-spanning sessions included. */
function addVoiceDays(byUser) {
  const now = Date.now();
  const rows = getDb()
    .prepare('SELECT user_id, joined_at, COALESCE(left_at, ?) AS left_at FROM voice_sessions')
    .all(now);

  for (const row of rows) {
    const days = byUser.get(row.user_id) || new Set();
    const cursor = new Date(row.joined_at);
    cursor.setHours(0, 0, 0, 0);
    const end = Math.min(row.left_at, now);
    for (let guard = 0; cursor.getTime() <= end && guard < MAX_SESSION_DAYS; guard++) {
      days.add(dayKey(cursor.getTime()));
      cursor.setDate(cursor.getDate() + 1);
    }
    byUser.set(row.user_id, days);
  }
}

/** Consecutive runs within a set of day keys, oldest first. */
function runsOf(days) {
  const sorted = [...days].sort();
  const runs = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.end === previousDay(day)) {
      last.end = day;
      last.length += 1;
    } else {
      runs.push({ start: day, end: day, length: 1 });
    }
  }
  return runs;
}

/**
 * Streak state for one set of active days:
 *   current  length of the run in progress (0 if it has lapsed)
 *   start    first day of that run
 *   longest  the longest run ever, and when it happened
 *   ended    the run that just lapsed, when current is 0 -- otherwise null
 */
export function streakState(days) {
  const runs = runsOf(days);
  if (runs.length === 0) {
    return {
      current: 0,
      start: null,
      lastDay: null,
      longest: 0,
      longestRun: null,
      longestCompleted: 0,
      longestCompletedRun: null,
      ended: null,
    };
  }
  const last = runs[runs.length - 1];
  const alive = last.end === today() || last.end === previousDay(today());
  const longestRun = runs.reduce((best, r) => (r.length > best.length ? r : best), runs[0]);

  // A run still in progress keeps growing, so the server record is taken over
  // finished runs only -- otherwise the record holder would break their own
  // record every single day. Live streaks are celebrated by thresholds instead.
  const finished = alive ? runs.slice(0, -1) : runs;
  const longestCompletedRun = finished.length
    ? finished.reduce((best, r) => (r.length > best.length ? r : best), finished[0])
    : null;

  return {
    current: alive ? last.length : 0,
    start: alive ? last.start : null,
    lastDay: last.end,
    longest: longestRun.length,
    longestRun,
    longestCompleted: longestCompletedRun ? longestCompletedRun.length : 0,
    longestCompletedRun,
    ended: alive ? null : last,
  };
}

/** Streak state for everyone who has ever been in voice, keyed by user id. */
export function allStreaks() {
  const byUser = new Map();
  addVoiceDays(byUser);

  const out = [];
  for (const [user_id, days] of byUser) {
    out.push({ user_id, ...streakState(days) });
  }
  return out;
}

/** Live streaks, longest first. */
export function currentStreaks(limit = 15) {
  return allStreaks()
    .filter((s) => s.current > 0)
    .sort((a, b) => b.current - a.current)
    .slice(0, limit);
}

/** Longest streaks ever recorded, whether or not they're still running. */
export function longestStreaks(limit = 15) {
  return allStreaks()
    .filter((s) => s.longest > 0)
    .sort((a, b) => b.longest - a.longest)
    .slice(0, limit);
}

/** One person's streak state. */
export function streakForUser(userId) {
  return allStreaks().find((s) => s.user_id === userId) || streakState(new Set());
}
