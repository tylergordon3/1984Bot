// Detection of milestones worth announcing. Everything here is a pure read of
// the session tables: each check returns award objects, and the watcher decides
// which of them are new. Two flavours:
//
//   thresholds — a running total crossing a round number ("100 hours in voice").
//                Only the highest un-awarded threshold is ever emitted, so a
//                jump past several at once posts one line, not five.
//   records    — a single best-ever value ("longest voice session"), stored
//                with its holder and re-announced when beaten.
import { getDb, displayName } from '../db/database.js';
import { formatDuration, resolvePeriod, HOUR, MINUTE } from '../util/time.js';
import {
  voiceLeaderboard,
  gamePlayerLeaderboard,
  messageLeaderboard,
  voiceCompanions,
  reactionsReceivedLeaderboard,
  reactionsGivenLeaderboard,
  topReactedMessages,
} from '../stats/queries.js';
import { allStreaks } from '../stats/streaks.js';

const VOICE_HOURS = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000];
const GAME_HOURS = [25, 50, 100, 250, 500, 1000, 2500, 5000];
const GAME_TITLE_HOURS = [50, 100, 250, 500, 1000];
const ALONE_HOURS = [25, 50, 100, 250, 500, 1000];
const DUO_HOURS = [25, 50, 100, 250, 500, 1000];
const MESSAGE_COUNTS = [500, 1000, 5000, 10000, 25000, 50000, 100000];
const REACTIONS_RECEIVED = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const REACTIONS_GIVEN = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const STREAK_DAYS = [7, 14, 30, 60, 100, 200, 365, 500, 1000];

// A game has to be played this long before it counts as having been seen here,
// so a launcher opened for thirty seconds isn't a "first sighting".
const NEW_GAME_MIN_MS = 10 * MINUTE;
// Floors below which a record isn't interesting enough to announce.
const MIN_SESSION_RECORD = HOUR;
const MIN_MESSAGE_DAY_RECORD = 20;
const MIN_REACTED_MESSAGE_RECORD = 3;
// Short streaks end constantly; only a real run is worth an obituary.
const MIN_ENDED_STREAK = 7;
// Only the busiest voice users can top alone-time or a duo total.
const DEEP_VOICE_USERS = 12;

const ALL_TIME = () => resolvePeriod('all');
const hours = (ms) => ms / HOUR;

/** The largest threshold this value has reached, or null. */
function highestCrossed(thresholds, value) {
  let best = null;
  for (const t of thresholds) if (value >= t) best = t;
  return best;
}

/** Local calendar date for a timestamp, e.g. "2026-08-29". */
function dateKey(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

// ── Threshold checks ───────────────────────────────────────────────────────

function timeThresholds(rows, { kind, thresholds, title, verb }) {
  const awards = [];
  for (const row of rows) {
    const crossed = highestCrossed(thresholds, hours(row.ms));
    if (!crossed) continue;
    awards.push({
      key: `${kind}:${row.user_id}:${crossed}`,
      kind,
      userId: row.user_id,
      value: crossed,
      title,
      describe: () =>
        `**${displayName(row.user_id)}** has now ${verb} for **${crossed.toLocaleString()} hours**. ` +
        `Total on file: ${formatDuration(row.ms)}.`,
    });
  }
  return awards;
}

function messageThresholds() {
  const awards = [];
  for (const row of messageLeaderboard(ALL_TIME(), {}, 200)) {
    const crossed = highestCrossed(MESSAGE_COUNTS, row.messages);
    if (!crossed) continue;
    awards.push({
      key: `messages:${row.user_id}:${crossed}`,
      kind: 'messages',
      userId: row.user_id,
      value: crossed,
      title: '🗣️ Statements on file',
      describe: () =>
        `**${displayName(row.user_id)}** has now made **${crossed.toLocaleString()}** statements ` +
        `on the record (${row.messages.toLocaleString()} total, ` +
        `${Number(row.words || 0).toLocaleString()} words).`,
    });
  }
  return awards;
}

/** Per-user, per-game totals — the hours sunk into one specific title. */
function gameTitleThresholds() {
  const min = GAME_TITLE_HOURS[0] * HOUR;
  const rows = getDb()
    .prepare(
      `SELECT user_id, game_name,
              SUM(MAX(0, COALESCE(ended_at, @now) - started_at)) AS ms
       FROM game_sessions
       GROUP BY user_id, game_name
       HAVING ms >= @min`
    )
    .all({ now: Date.now(), min });

  const awards = [];
  for (const row of rows) {
    const crossed = highestCrossed(GAME_TITLE_HOURS, hours(row.ms));
    if (!crossed) continue;
    awards.push({
      key: `game_title_hours:${row.user_id}:${row.game_name}:${crossed}`,
      kind: 'game_title_hours',
      userId: row.user_id,
      detail: row.game_name,
      value: crossed,
      title: '🎮 Devotion to a single title',
      describe: () =>
        `**${displayName(row.user_id)}** has spent **${crossed.toLocaleString()} hours** ` +
        `in *${row.game_name}* (${formatDuration(row.ms)} on file).`,
    });
  }
  return awards;
}

/** Alone-time and pair-time, from the same interval sweep. Expensive; hourly. */
function companionThresholds() {
  const window = ALL_TIME();
  const awards = [];
  const pairs = new Map(); // "a|b" (sorted) -> ms

  for (const row of voiceLeaderboard(window, DEEP_VOICE_USERS)) {
    const { aloneMs, companions } = voiceCompanions(row.user_id, window, 25);

    const alone = highestCrossed(ALONE_HOURS, hours(aloneMs));
    if (alone) {
      awards.push({
        key: `alone_hours:${row.user_id}:${alone}`,
        kind: 'alone_hours',
        userId: row.user_id,
        value: alone,
        title: '🕯️ Alone, but never unobserved',
        describe: () =>
          `**${displayName(row.user_id)}** has spent **${alone.toLocaleString()} hours** ` +
          `alone in a voice channel (${formatDuration(aloneMs)} on file).`,
      });
    }
    for (const c of companions) {
      const key = [row.user_id, c.user_id].sort().join('|');
      if ((pairs.get(key) || 0) < c.ms) pairs.set(key, c.ms);
    }
  }

  for (const [key, ms] of pairs) {
    const crossed = highestCrossed(DUO_HOURS, hours(ms));
    if (!crossed) continue;
    const [a, b] = key.split('|');
    awards.push({
      key: `duo_hours:${a}:${b}:${crossed}`,
      kind: 'duo_hours',
      value: crossed,
      detail: key,
      title: '👥 A known association',
      describe: () =>
        `**${displayName(a)}** and **${displayName(b)}** have now shared ` +
        `**${crossed.toLocaleString()} hours** of voice time (${formatDuration(ms)} on file). ` +
        `The connection is noted.`,
    });
  }
  return awards;
}

// ── Record checks ──────────────────────────────────────────────────────────
//
// Only closed sessions are considered: an open one keeps growing, and a record
// that updates every five minutes is noise, not news.

function sessionRecords() {
  const db = getDb();
  const awards = [];

  const voice = db
    .prepare(
      `SELECT user_id, channel_id, left_at - joined_at AS ms
       FROM voice_sessions
       WHERE left_at IS NOT NULL
       ORDER BY ms DESC LIMIT 1`
    )
    .get();
  if (voice && voice.ms >= MIN_SESSION_RECORD) {
    awards.push({
      key: 'record:voice_session',
      kind: 'record',
      isRecord: true,
      userId: voice.user_id,
      value: voice.ms,
      title: '🏆 New record: longest voice session',
      describe: (previous) =>
        `**${displayName(voice.user_id)}** stayed in voice for **${formatDuration(voice.ms)}** ` +
        `without leaving` +
        (previous?.value
          ? ` — beating the previous record of ${formatDuration(previous.value)}` +
            (previous.user_id ? ` held by **${displayName(previous.user_id)}**` : '') +
            '.'
          : '.'),
    });
  }

  const game = db
    .prepare(
      `SELECT user_id, game_name, ended_at - started_at AS ms
       FROM game_sessions
       WHERE ended_at IS NOT NULL
       ORDER BY ms DESC LIMIT 1`
    )
    .get();
  if (game && game.ms >= MIN_SESSION_RECORD) {
    awards.push({
      key: 'record:game_session',
      kind: 'record',
      isRecord: true,
      userId: game.user_id,
      detail: game.game_name,
      value: game.ms,
      title: '🏆 New record: longest unbroken session',
      describe: (previous) =>
        `**${displayName(game.user_id)}** played *${game.game_name}* for ` +
        `**${formatDuration(game.ms)}** straight` +
        (previous?.value ? ` — the previous record was ${formatDuration(previous.value)}.` : '.'),
    });
  }

  // Busiest single day for one person. Today is excluded: it isn't over, and a
  // record that ratchets up with every message would announce all afternoon.
  const day = db
    .prepare(
      `SELECT user_id,
              strftime('%Y-%m-%d', sent_at / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS messages
       FROM messages
       GROUP BY user_id, day
       HAVING day != @today AND messages >= @min
       ORDER BY messages DESC LIMIT 1`
    )
    .get({ today: dateKey(Date.now()), min: MIN_MESSAGE_DAY_RECORD });
  if (day) {
    awards.push({
      key: 'record:message_day',
      kind: 'record',
      isRecord: true,
      userId: day.user_id,
      detail: day.day,
      value: day.messages,
      title: '🏆 New record: most said in one day',
      describe: (previous) =>
        `**${displayName(day.user_id)}** sent **${day.messages.toLocaleString()} messages** ` +
        `on ${day.day}` +
        (previous?.value ? ` — past the old high of ${previous.value.toLocaleString()}.` : '.'),
    });
  }

  return awards;
}

/** Games never recorded here before. `minMs` is 0 when taking the baseline. */
function firstSightings(minMs) {
  const rows = getDb()
    .prepare(
      `SELECT game_name,
              SUM(MAX(0, COALESCE(ended_at, @now) - started_at)) AS ms,
              COUNT(DISTINCT user_id) AS players,
              MIN(started_at) AS first_at
       FROM game_sessions
       GROUP BY game_name
       HAVING ms >= @min`
    )
    .all({ now: Date.now(), min: minMs });

  const firstPlayer = getDb().prepare(
    `SELECT user_id FROM game_sessions WHERE game_name = ? ORDER BY started_at LIMIT 1`
  );

  return rows.map((row) => ({
    key: `first_game:${row.game_name}`,
    kind: 'first_game',
    detail: row.game_name,
    value: row.ms,
    title: '🔎 First sighting',
    describe: () => {
      const who = firstPlayer.get(row.game_name);
      const name = who ? `**${displayName(who.user_id)}**` : 'Someone';
      return (
        `${name} has been playing *${row.game_name}* — a title with no prior entry ` +
        `in this server's records. A file has been opened.`
      );
    },
  }));
}

/** Reactions collected and reactions handed out. */
function reactionThresholds() {
  const window = ALL_TIME();
  const awards = [];

  for (const row of reactionsReceivedLeaderboard(window, 200)) {
    const crossed = highestCrossed(REACTIONS_RECEIVED, row.reactions);
    if (!crossed) continue;
    awards.push({
      key: `reactions_received:${row.user_id}:${crossed}`,
      kind: 'reactions_received',
      userId: row.user_id,
      value: crossed,
      title: '⭐ Approval on file',
      describe: () =>
        `**${displayName(row.user_id)}** has now drawn **${crossed.toLocaleString()} reactions** ` +
        `from ${row.reactors} ${row.reactors === 1 ? 'person' : 'people'} ` +
        `(${row.reactions.toLocaleString()} total).`,
    });
  }

  for (const row of reactionsGivenLeaderboard(window, 200)) {
    const crossed = highestCrossed(REACTIONS_GIVEN, row.reactions);
    if (!crossed) continue;
    awards.push({
      key: `reactions_given:${row.user_id}:${crossed}`,
      kind: 'reactions_given',
      userId: row.user_id,
      value: crossed,
      title: '🙌 A generous critic',
      describe: () =>
        `**${displayName(row.user_id)}** has handed out **${crossed.toLocaleString()} reactions** ` +
        `across ${row.targets} ${row.targets === 1 ? 'person' : 'people'}.`,
    });
  }

  const [best] = topReactedMessages(window, 1);
  if (best && best.reactions >= MIN_REACTED_MESSAGE_RECORD) {
    awards.push({
      key: 'record:reacted_message',
      kind: 'record',
      isRecord: true,
      userId: best.author_id,
      detail: `${best.channel_id}/${best.message_id}`,
      value: best.reactions,
      title: '🏆 New record: best-received message',
      describe: (previous) =>
        `**${displayName(best.author_id)}** drew **${best.reactions} reactions** on one message ` +
        `from ${best.reactors} ${best.reactors === 1 ? 'person' : 'people'}` +
        (previous?.value ? ` — past the old high of ${previous.value}.` : '.'),
    });
  }
  return awards;
}

/**
 * Attendance streaks: milestones for a run in progress, an obituary when a
 * real one lapses, and the server record over finished runs only.
 */
function streakAwards() {
  const awards = [];
  let record = null;

  for (const s of allStreaks()) {
    if (s.current > 0) {
      const crossed = highestCrossed(STREAK_DAYS, s.current);
      if (crossed) {
        // The start date is in the key, so a later streak of the same length
        // is a fresh achievement rather than a duplicate of the old one.
        awards.push({
          key: `streak_days:${s.user_id}:${s.start}:${crossed}`,
          kind: 'streak_days',
          userId: s.user_id,
          detail: s.start,
          value: crossed,
          title: '📆 Perfect attendance',
          describe: () =>
            `**${displayName(s.user_id)}** has been present every day for ` +
            `**${crossed} days** — unbroken since ${s.start}.`,
        });
      }
    }

    if (s.ended && s.ended.length >= MIN_ENDED_STREAK) {
      awards.push({
        key: `streak_ended:${s.user_id}:${s.ended.start}`,
        kind: 'streak_ended',
        userId: s.user_id,
        detail: s.ended.end,
        value: s.ended.length,
        title: '💀 A streak has ended',
        describe: () =>
          `**${displayName(s.user_id)}**'s run of **${s.ended.length} consecutive days** ended ` +
          `on ${s.ended.end}. The absence has been noted.`,
      });
    }

    if (s.longestCompleted > 0 && (!record || s.longestCompleted > record.longestCompleted)) {
      record = s;
    }
  }

  if (record) {
    const run = record.longestCompletedRun;
    awards.push({
      key: 'record:streak',
      kind: 'record',
      isRecord: true,
      userId: record.user_id,
      detail: `${run.start}..${run.end}`,
      value: record.longestCompleted,
      title: '🏆 New record: longest completed streak',
      describe: (previous) =>
        `**${displayName(record.user_id)}** put together **${record.longestCompleted} ` +
        `consecutive days** (${run.start} to ${run.end})` +
        (previous?.value ? ` — the previous best was ${previous.value}.` : '.'),
    });
  }
  return awards;
}

/**
 * Every milestone currently true of the data.
 *
 * @param {object} opts
 * @param {boolean} opts.deep    include the interval-sweep checks (alone / duo)
 * @param {boolean} opts.seeding take the baseline: no minimum on first sightings
 */
export function currentAwards({ deep = false, seeding = false } = {}) {
  const window = ALL_TIME();
  const awards = [
    ...timeThresholds(voiceLeaderboard(window, 200), {
      kind: 'voice_hours',
      thresholds: VOICE_HOURS,
      title: '🎙️ Hours under observation',
      verb: 'been recorded in voice',
    }),
    ...timeThresholds(gamePlayerLeaderboard(window, 200), {
      kind: 'game_hours',
      thresholds: GAME_HOURS,
      title: '🎮 Hours at play',
      verb: 'been observed playing',
    }),
    ...gameTitleThresholds(),
    ...messageThresholds(),
    ...reactionThresholds(),
    ...streakAwards(),
    ...firstSightings(seeding ? 0 : NEW_GAME_MIN_MS),
    ...sessionRecords(),
  ];
  if (deep || seeding) awards.push(...companionThresholds());
  return awards;
}
