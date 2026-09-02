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

// ── Messages ───────────────────────────────────────────────────────────────
//
// Messages are point events, so their windows are a simple half-open range on
// sent_at. Hour-of-day is derived from sent_at in the server's local timezone.

const HOUR_OF_DAY = `CAST(strftime('%H', sent_at / 1000, 'unixepoch', 'localtime') AS INTEGER)`;

/**
 * Shared WHERE fragment for message/mention queries.
 * `fromHour` is inclusive and `toHour` exclusive; when fromHour > toHour the
 * range wraps past midnight (e.g. 22 → 4 means "late night").
 */
function messageFilter(window, { channelId, fromHour, toHour } = {}) {
  const clauses = ['sent_at >= @since', 'sent_at < @until'];
  const params = { since: window.since, until: window.until };

  if (channelId) {
    clauses.push('channel_id = @channelId');
    params.channelId = channelId;
  }
  if (fromHour != null || toHour != null) {
    const from = fromHour ?? 0;
    const to = toHour ?? 24;
    if (from !== to) {
      params.fromHour = from;
      params.toHour = to;
      clauses.push(
        from < to
          ? `${HOUR_OF_DAY} >= @fromHour AND ${HOUR_OF_DAY} < @toHour`
          : `(${HOUR_OF_DAY} >= @fromHour OR ${HOUR_OF_DAY} < @toHour)`
      );
    }
  }
  return { where: clauses.join(' AND '), params };
}

/** Who sent the most messages, optionally within a channel and hour range. */
export function messageLeaderboard(window, opts = {}, limit = 15) {
  const { where, params } = messageFilter(window, opts);
  return getDb()
    .prepare(
      `SELECT user_id, COUNT(*) AS messages, SUM(word_count) AS words
       FROM messages
       WHERE ${where}
       GROUP BY user_id
       ORDER BY messages DESC
       LIMIT @limit`
    )
    .all({ ...params, limit });
}

/** Totals for one user (or the whole server when userId is null). */
export function messageTotals(userId, window, opts = {}) {
  const { where, params } = messageFilter(window, opts);
  const scope = userId ? `${where} AND user_id = @userId` : where;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS messages,
              COALESCE(SUM(word_count), 0) AS words,
              COALESCE(SUM(char_count), 0) AS chars,
              COALESCE(SUM(attachments), 0) AS attachments,
              COALESCE(SUM(has_link), 0) AS links,
              COALESCE(SUM(is_reply), 0) AS replies,
              COUNT(DISTINCT user_id) AS people,
              MIN(sent_at) AS first_at,
              MAX(sent_at) AS last_at
       FROM messages
       WHERE ${scope}`
    )
    .get({ ...params, userId });
  return row;
}

/** Message counts bucketed by local hour-of-day (0–23). */
export function messageHourHistogram(window, opts = {}) {
  const { where, params } = messageFilter(window, opts);
  const scope = opts.userId ? `${where} AND user_id = @userId` : where;
  const rows = getDb()
    .prepare(
      `SELECT ${HOUR_OF_DAY} AS hour, COUNT(*) AS messages
       FROM messages
       WHERE ${scope}
       GROUP BY hour`
    )
    .all({ ...params, userId: opts.userId });
  const hours = new Array(24).fill(0);
  for (const r of rows) hours[r.hour] = r.messages;
  return hours;
}

/** A user's most-used channels. */
export function messageChannelBreakdown(userId, window, limit = 5) {
  const { where, params } = messageFilter(window);
  return getDb()
    .prepare(
      `SELECT channel_id, COUNT(*) AS messages
       FROM messages
       WHERE ${where} AND user_id = @userId
       GROUP BY channel_id
       ORDER BY messages DESC
       LIMIT @limit`
    )
    .all({ ...params, userId, limit });
}

// ── Mentions (who tags whom) ───────────────────────────────────────────────

/** Who tags `userId` the most. */
export function taggedByLeaderboard(userId, window, limit = 10) {
  const { where, params } = messageFilter(window);
  return getDb()
    .prepare(
      `SELECT from_user_id AS user_id, COUNT(*) AS tags
       FROM message_mentions
       WHERE ${where} AND to_user_id = @userId
       GROUP BY from_user_id
       ORDER BY tags DESC
       LIMIT @limit`
    )
    .all({ ...params, userId, limit });
}

/** Who `userId` tags the most. */
export function tagsGivenLeaderboard(userId, window, limit = 10) {
  const { where, params } = messageFilter(window);
  return getDb()
    .prepare(
      `SELECT to_user_id AS user_id, COUNT(*) AS tags
       FROM message_mentions
       WHERE ${where} AND from_user_id = @userId
       GROUP BY to_user_id
       ORDER BY tags DESC
       LIMIT @limit`
    )
    .all({ ...params, userId, limit });
}

/** Most-tagged people in the server. */
export function mostTagged(window, limit = 10) {
  const { where, params } = messageFilter(window);
  return getDb()
    .prepare(
      `SELECT to_user_id AS user_id, COUNT(*) AS tags,
              COUNT(DISTINCT from_user_id) AS taggers
       FROM message_mentions
       WHERE ${where}
       GROUP BY to_user_id
       ORDER BY tags DESC
       LIMIT @limit`
    )
    .all({ ...params, limit });
}

/** Biggest taggers in the server. */
export function biggestTaggers(window, limit = 10) {
  const { where, params } = messageFilter(window);
  return getDb()
    .prepare(
      `SELECT from_user_id AS user_id, COUNT(*) AS tags,
              COUNT(DISTINCT to_user_id) AS targets
       FROM message_mentions
       WHERE ${where}
       GROUP BY from_user_id
       ORDER BY tags DESC
       LIMIT @limit`
    )
    .all({ ...params, limit });
}

/** Strongest tagger → tagged pairs. */
export function topTagPairs(window, limit = 10) {
  const { where, params } = messageFilter(window);
  return getDb()
    .prepare(
      `SELECT from_user_id, to_user_id, COUNT(*) AS tags
       FROM message_mentions
       WHERE ${where}
       GROUP BY from_user_id, to_user_id
       ORDER BY tags DESC
       LIMIT @limit`
    )
    .all({ ...params, limit });
}

/** Tags exchanged between two specific people, in both directions. */
export function tagsBetween(aId, bId, window) {
  const { where, params } = messageFilter(window);
  const count = getDb().prepare(
    `SELECT COUNT(*) AS tags FROM message_mentions
     WHERE ${where} AND from_user_id = @from AND to_user_id = @to`
  );
  return {
    aToB: count.get({ ...params, from: aId, to: bId }).tags,
    bToA: count.get({ ...params, from: bId, to: aId }).tags,
  };
}

// ── Reactions (what was said back without saying anything) ─────────────────
//
// Point events on reacted_at, like messages on sent_at. A reaction taken back
// is deleted rather than marked, so every count here is of live reactions.

function reactionFilter(window, { channelId } = {}) {
  const clauses = ['reacted_at >= @since', 'reacted_at < @until'];
  const params = { since: window.since, until: window.until };
  if (channelId) {
    clauses.push('channel_id = @channelId');
    params.channelId = channelId;
  }
  return { where: clauses.join(' AND '), params };
}

/** Total live reactions in the window, and how many people gave them. */
export function reactionTotals(window) {
  const { where, params } = reactionFilter(window);
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS reactions,
              COUNT(DISTINCT user_id) AS reactors,
              COUNT(DISTINCT message_id) AS messages
       FROM message_reactions
       WHERE ${where} AND author_id != user_id`
    )
    .get(params);
}

/** Whose messages drew the most reactions. */
export function reactionsReceivedLeaderboard(window, limit = 15) {
  const { where, params } = reactionFilter(window);
  return getDb()
    .prepare(
      `SELECT author_id AS user_id, COUNT(*) AS reactions,
              COUNT(DISTINCT user_id) AS reactors,
              COUNT(DISTINCT message_id) AS messages
       FROM message_reactions
       WHERE ${where} AND author_id != user_id
       GROUP BY author_id
       ORDER BY reactions DESC
       LIMIT @limit`
    )
    .all({ ...params, limit });
}

/** Who hands out the most reactions. */
export function reactionsGivenLeaderboard(window, limit = 15) {
  const { where, params } = reactionFilter(window);
  return getDb()
    .prepare(
      `SELECT user_id, COUNT(*) AS reactions, COUNT(DISTINCT author_id) AS targets
       FROM message_reactions
       WHERE ${where} AND author_id != user_id
       GROUP BY user_id
       ORDER BY reactions DESC
       LIMIT @limit`
    )
    .all({ ...params, limit });
}

/** The server's most-used emoji. */
export function topEmoji(window, limit = 10, userId = null) {
  const { where, params } = reactionFilter(window);
  const scope = userId ? `${where} AND user_id = @userId` : where;
  return getDb()
    .prepare(
      `SELECT emoji_name, emoji_id, COUNT(*) AS uses, COUNT(DISTINCT user_id) AS users
       FROM message_reactions
       WHERE ${scope}
       GROUP BY emoji_name, emoji_id
       ORDER BY uses DESC
       LIMIT @limit`
    )
    .all({ ...params, userId, limit });
}

/** The most-reacted messages of the window, best first. */
export function topReactedMessages(window, limit = 5) {
  const { where, params } = reactionFilter(window);
  return getDb()
    .prepare(
      `SELECT message_id, channel_id, author_id,
              COUNT(*) AS reactions, COUNT(DISTINCT user_id) AS reactors
       FROM message_reactions
       WHERE ${where} AND author_id != user_id
       GROUP BY message_id
       ORDER BY reactions DESC, reactors DESC
       LIMIT @limit`
    )
    .all({ ...params, limit });
}

/** Reaction totals for one person, both directions. */
export function reactionTotalsForUser(userId, window) {
  const { where, params } = reactionFilter(window);
  const db = getDb();
  const received = db
    .prepare(
      `SELECT COUNT(*) AS reactions, COUNT(DISTINCT user_id) AS people,
              COUNT(DISTINCT message_id) AS messages
       FROM message_reactions
       WHERE ${where} AND author_id = @userId AND author_id != user_id`
    )
    .get({ ...params, userId });
  const given = db
    .prepare(
      `SELECT COUNT(*) AS reactions, COUNT(DISTINCT author_id) AS people
       FROM message_reactions
       WHERE ${where} AND user_id = @userId AND author_id != user_id`
    )
    .get({ ...params, userId });
  return { received, given };
}

/** Who reacts to this person the most. */
export function reactionFansOf(userId, window, limit = 5) {
  const { where, params } = reactionFilter(window);
  return getDb()
    .prepare(
      `SELECT user_id, COUNT(*) AS reactions
       FROM message_reactions
       WHERE ${where} AND author_id = @userId AND author_id != user_id
       GROUP BY user_id
       ORDER BY reactions DESC
       LIMIT @limit`
    )
    .all({ ...params, userId, limit });
}

/** Whose messages this person reacts to the most. */
export function reactionTargetsOf(userId, window, limit = 5) {
  const { where, params } = reactionFilter(window);
  return getDb()
    .prepare(
      `SELECT author_id AS user_id, COUNT(*) AS reactions
       FROM message_reactions
       WHERE ${where} AND user_id = @userId AND author_id != user_id
       GROUP BY author_id
       ORDER BY reactions DESC
       LIMIT @limit`
    )
    .all({ ...params, userId, limit });
}

// ── Presence on the record ───────────────────────────────────────────────

/**
 * When each person was last observed doing anything at all — in voice, in
 * chat, at play, or reacting — and which of those it was. Open sessions
 * count as "now". Only people with something on file appear; someone the bot
 * has never seen has no last-seen to report.
 */
export function lastSeenByUser() {
  const now = Date.now();
  // SQLite's bare-column rule: with a lone MAX(), the other columns come from
  // the row that supplied the maximum, so `source` is the source of the
  // latest sighting.
  return getDb()
    .prepare(
      `SELECT user_id, MAX(at) AS last_seen, source FROM (
         SELECT user_id, MAX(COALESCE(left_at, @now)) AS at, 'in voice' AS source
           FROM voice_sessions GROUP BY user_id
         UNION ALL
         SELECT user_id, MAX(sent_at), 'in chat' FROM messages GROUP BY user_id
         UNION ALL
         SELECT user_id, MAX(COALESCE(ended_at, @now)), 'at play'
           FROM game_sessions GROUP BY user_id
         UNION ALL
         SELECT user_id, MAX(reacted_at), 'reacting' FROM message_reactions GROUP BY user_id
       )
       GROUP BY user_id`
    )
    .all({ now });
}
