import { getDb } from '../db/database.js';

// Every session's counted duration is clamped to the query window:
//   contribution = max(0, min(end, until) - max(start, since))
// where `end` for an open (still-running) session is `now`.

// ── Voice: leaderboards & totals ───────────────────────────────────────────

export function voiceLeaderboard(window, limit = 15) {
  const { since, until } = window;
  const now = Date.now();
  return getDb()
    .prepare(
      `SELECT user_id,
              SUM(MAX(0, MIN(COALESCE(left_at, @now), @until) - MAX(joined_at, @since))) AS ms
       FROM voice_sessions
       WHERE joined_at < @until AND COALESCE(left_at, @now) > @since
       GROUP BY user_id
       HAVING ms > 0
       ORDER BY ms DESC
       LIMIT @limit`
    )
    .all({ now, since, until, limit });
}

export function voiceTotalForUser(userId, window) {
  const { since, until } = window;
  const now = Date.now();
  const row = getDb()
    .prepare(
      `SELECT SUM(MAX(0, MIN(COALESCE(left_at, @now), @until) - MAX(joined_at, @since))) AS ms
       FROM voice_sessions
       WHERE user_id = @userId AND joined_at < @until AND COALESCE(left_at, @now) > @since`
    )
    .get({ now, since, until, userId });
  return row?.ms || 0;
}

// ── Voice: co-presence (who they were with) + alone time ───────────────────

/**
 * Interval sweep over one user's voice time. Returns total time, time spent
 * alone (nobody else in the channel), and per-companion overlap totals.
 */
export function voiceCompanions(userId, window, limit = 10) {
  const { since, until } = window;
  const now = Date.now();
  const db = getDb();

  const mine = db
    .prepare(
      `SELECT channel_id,
              MAX(joined_at, @since) AS s,
              MIN(COALESCE(left_at, @now), @until) AS e
       FROM voice_sessions
       WHERE user_id = @userId AND joined_at < @until AND COALESCE(left_at, @now) > @since`
    )
    .all({ since, now, until, userId })
    .filter((r) => r.e > r.s);

  let totalMs = 0;
  let aloneMs = 0;
  const withUser = new Map();

  const othersStmt = db.prepare(
    `SELECT user_id,
            MAX(joined_at, @s) AS s,
            MIN(COALESCE(left_at, @now), @e) AS e
     FROM voice_sessions
     WHERE channel_id = @channel AND user_id != @userId
       AND joined_at < @e AND COALESCE(left_at, @now) > @s`
  );

  for (const iv of mine) {
    totalMs += iv.e - iv.s;
    const others = othersStmt
      .all({ s: iv.s, e: iv.e, now, channel: iv.channel_id, userId })
      .filter((r) => r.e > r.s);

    const points = new Set([iv.s, iv.e]);
    for (const o of others) {
      points.add(o.s);
      points.add(o.e);
      withUser.set(o.user_id, (withUser.get(o.user_id) || 0) + (o.e - o.s));
    }
    const sorted = [...points].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (b <= a) continue;
      const mid = (a + b) / 2;
      const anyone = others.some((o) => o.s <= mid && o.e > mid);
      if (!anyone) aloneMs += b - a;
    }
  }

  const companions = [...withUser.entries()]
    .map(([user_id, ms]) => ({ user_id, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);

  return { totalMs, aloneMs, companions };
}

// ── Voice: state flags (streaming / muted / deafened / video) ──────────────

export const FLAGS = ['streaming', 'muted', 'deafened', 'video'];

/** Per-flag totals (ms) for one user over the window. */
export function voiceFlagTotalsForUser(userId, window) {
  const { since, until } = window;
  const now = Date.now();
  const rows = getDb()
    .prepare(
      `SELECT flag,
              SUM(MAX(0, MIN(COALESCE(ended_at, @now), @until) - MAX(started_at, @since))) AS ms
       FROM voice_flags
       WHERE user_id = @userId AND started_at < @until AND COALESCE(ended_at, @now) > @since
       GROUP BY flag`
    )
    .all({ now, since, until, userId });
  const totals = Object.fromEntries(FLAGS.map((f) => [f, 0]));
  for (const r of rows) if (r.flag in totals) totals[r.flag] = r.ms || 0;
  return totals;
}

/** Leaderboard of who spent the most time in a given flag state. */
export function voiceFlagLeaderboard(flag, window, limit = 15) {
  const { since, until } = window;
  const now = Date.now();
  return getDb()
    .prepare(
      `SELECT user_id,
              SUM(MAX(0, MIN(COALESCE(ended_at, @now), @until) - MAX(started_at, @since))) AS ms
       FROM voice_flags
       WHERE flag = @flag AND started_at < @until AND COALESCE(ended_at, @now) > @since
       GROUP BY user_id
       HAVING ms > 0
       ORDER BY ms DESC
       LIMIT @limit`
    )
    .all({ now, since, until, flag, limit });
}

// ── Voice: time-of-day occupancy ───────────────────────────────────────────

/** Person-milliseconds of voice presence bucketed by local hour-of-day (0–23). */
export function voiceHourHistogram(window) {
  const { since, until } = window;
  const now = Date.now();
  const rows = getDb()
    .prepare(
      `SELECT joined_at, COALESCE(left_at, @now) AS left_at
       FROM voice_sessions
       WHERE joined_at < @until AND COALESCE(left_at, @now) > @since`
    )
    .all({ now, since, until });

  const hours = new Array(24).fill(0);
  for (const r of rows) {
    let start = Math.max(r.joined_at, since);
    const end = Math.min(r.left_at, until);
    while (start < end) {
      const d = new Date(start);
      const boundary = new Date(start);
      boundary.setMinutes(0, 0, 0);
      boundary.setHours(d.getHours() + 1);
      const sliceEnd = Math.min(end, boundary.getTime());
      hours[d.getHours()] += sliceEnd - start;
      start = sliceEnd;
    }
  }
  return hours;
}

// ── Games ──────────────────────────────────────────────────────────────────

export function userGameStats(userId, window, limit = 15) {
  const { since, until } = window;
  const now = Date.now();
  return getDb()
    .prepare(
      `SELECT game_name,
              SUM(MAX(0, MIN(COALESCE(ended_at, @now), @until) - MAX(started_at, @since))) AS ms
       FROM game_sessions
       WHERE user_id = @userId AND started_at < @until AND COALESCE(ended_at, @now) > @since
       GROUP BY game_name
       HAVING ms > 0
       ORDER BY ms DESC
       LIMIT @limit`
    )
    .all({ now, since, until, userId, limit });
}

export function userGameTotal(userId, window) {
  const { since, until } = window;
  const now = Date.now();
  const row = getDb()
    .prepare(
      `SELECT SUM(MAX(0, MIN(COALESCE(ended_at, @now), @until) - MAX(started_at, @since))) AS ms
       FROM game_sessions
       WHERE user_id = @userId AND started_at < @until AND COALESCE(ended_at, @now) > @since`
    )
    .get({ now, since, until, userId });
  return row?.ms || 0;
}

/** Guild-wide top games (total time + distinct player count). */
export function guildTopGames(window, limit = 15) {
  const { since, until } = window;
  const now = Date.now();
  return getDb()
    .prepare(
      `SELECT game_name,
              SUM(MAX(0, MIN(COALESCE(ended_at, @now), @until) - MAX(started_at, @since))) AS ms,
              COUNT(DISTINCT user_id) AS players
       FROM game_sessions
       WHERE started_at < @until AND COALESCE(ended_at, @now) > @since
       GROUP BY game_name
       HAVING ms > 0
       ORDER BY ms DESC
       LIMIT @limit`
    )
    .all({ now, since, until, limit });
}

/** Leaderboard of who logged the most total game time. */
export function gamePlayerLeaderboard(window, limit = 15) {
  const { since, until } = window;
  const now = Date.now();
  return getDb()
    .prepare(
      `SELECT user_id,
              SUM(MAX(0, MIN(COALESCE(ended_at, @now), @until) - MAX(started_at, @since))) AS ms
       FROM game_sessions
       WHERE started_at < @until AND COALESCE(ended_at, @now) > @since
       GROUP BY user_id
       HAVING ms > 0
       ORDER BY ms DESC
       LIMIT @limit`
    )
    .all({ now, since, until, limit });
}
