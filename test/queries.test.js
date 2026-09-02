import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod } from '../src/util/time.js';
import {
  voiceTotalForUser,
  voiceLeaderboard,
  voiceCompanions,
  voiceHourHistogram,
  messageLeaderboard,
  messageTotals,
  messageHourHistogram,
  reactionTotals,
  lastSeenByUser,
} from '../src/stats/queries.js';
import {
  freshDb,
  seedVoice,
  seedGame,
  seedMessage,
  seedMessages,
  seedReaction,
  yesterdayAt,
  closeTo,
  MINUTE,
  HOUR,
  DAY,
} from './helpers.js';

beforeEach(() => freshDb());

test('voice time is clamped to the window, not the session', () => {
  const now = Date.now();
  // Two days long, but only its last day falls inside the past week.
  seedVoice({ user: 'alice', joined: now - 8 * DAY, left: now - 6 * DAY });
  const ms = voiceTotalForUser('alice', resolvePeriod('week'));
  assert.ok(closeTo(ms, DAY), `expected ~1d, got ${ms}`);
  // All-time sees the whole thing.
  assert.equal(voiceTotalForUser('alice', resolvePeriod('all')), 2 * DAY);
});

test('an open voice session counts up to now', () => {
  const now = Date.now();
  seedVoice({ user: 'alice', joined: now - 30 * MINUTE });
  const ms = voiceTotalForUser('alice', resolvePeriod('day'));
  assert.ok(closeTo(ms, 30 * MINUTE), `expected ~30m, got ${ms}`);
});

test('voice leaderboard sums every session per user, highest first', () => {
  const now = Date.now();
  seedVoice({ user: 'alice', joined: now - 3 * HOUR, left: now - 2 * HOUR });
  seedVoice({ user: 'alice', joined: now - 90 * MINUTE, left: now - HOUR });
  seedVoice({ user: 'bob', joined: now - 5 * HOUR, left: now - HOUR });
  const rows = voiceLeaderboard(resolvePeriod('day'));
  assert.deepEqual(
    rows.map((r) => [r.user_id, r.ms]),
    [
      ['bob', 4 * HOUR],
      ['alice', 90 * MINUTE],
    ]
  );
});

test('companions split time into alone and together, per channel', () => {
  const t0 = Date.now() - 2 * HOUR;
  seedVoice({ user: 'alice', channel: 'c1', joined: t0, left: t0 + 60 * MINUTE });
  seedVoice({ user: 'bob', channel: 'c1', joined: t0 + 20 * MINUTE, left: t0 + 50 * MINUTE });
  // Same time, different channel: not company.
  seedVoice({ user: 'carol', channel: 'c2', joined: t0, left: t0 + 60 * MINUTE });

  const { totalMs, aloneMs, companions } = voiceCompanions('alice', resolvePeriod('day'));
  assert.equal(totalMs, 60 * MINUTE);
  assert.equal(aloneMs, 30 * MINUTE);
  assert.deepEqual(companions, [{ user_id: 'bob', ms: 30 * MINUTE }]);
});

test('voice hour histogram slices a session across local hour boundaries', () => {
  seedVoice({ user: 'alice', joined: yesterdayAt(10, 30), left: yesterdayAt(12, 15) });
  const hours = voiceHourHistogram(resolvePeriod('week'));
  assert.equal(hours[10], 30 * MINUTE);
  assert.equal(hours[11], 60 * MINUTE);
  assert.equal(hours[12], 15 * MINUTE);
  assert.equal(hours.reduce((a, b) => a + b, 0), 105 * MINUTE);
});

test('message leaderboard filters by hour of day, wrapping past midnight', () => {
  seedMessage({ user: 'early', at: yesterdayAt(3) });
  seedMessage({ user: 'noon', at: yesterdayAt(12) });
  seedMessage({ user: 'late', at: yesterdayAt(23) });
  const week = resolvePeriod('week');

  const afternoon = messageLeaderboard(week, { fromHour: 14 }).map((r) => r.user_id);
  assert.deepEqual(afternoon, ['late']);

  const lateNight = messageLeaderboard(week, { fromHour: 22, toHour: 4 }).map((r) => r.user_id);
  assert.deepEqual(lateNight.sort(), ['early', 'late']);

  assert.equal(messageLeaderboard(week).length, 3);
});

test('message totals count people and words across the window only', () => {
  const now = Date.now();
  seedMessages('alice', 3, now - HOUR);
  seedMessages('bob', 2, now - HOUR);
  seedMessages('bob', 5, now - 10 * DAY); // outside the week
  const totals = messageTotals(null, resolvePeriod('week'));
  assert.equal(totals.messages, 5);
  assert.equal(totals.people, 2);
  assert.equal(totals.words, 15);
  assert.equal(messageTotals('bob', resolvePeriod('all')).messages, 7);
});

test('message hour histogram buckets by local hour', () => {
  seedMessage({ user: 'a', at: yesterdayAt(18, 5) });
  seedMessage({ user: 'b', at: yesterdayAt(18, 50) });
  seedMessage({ user: 'c', at: yesterdayAt(7) });
  const hours = messageHourHistogram(resolvePeriod('week'));
  assert.equal(hours[18], 2);
  assert.equal(hours[7], 1);
  assert.equal(hours.reduce((a, b) => a + b, 0), 3);
});

test('reacting to your own message does not count', () => {
  const now = Date.now();
  const id = seedMessage({ user: 'alice', at: now - HOUR });
  seedReaction({ message: id, author: 'alice', user: 'bob', at: now - MINUTE });
  seedReaction({ message: id, author: 'alice', user: 'alice', at: now - MINUTE });
  assert.equal(reactionTotals(resolvePeriod('day')).reactions, 1);
});

test('lastSeenByUser takes the latest sighting across every table', () => {
  const now = Date.now();
  seedMessage({ user: 'alice', at: now - 10 * DAY });
  seedVoice({ user: 'alice', joined: now - 4 * DAY, left: now - 3 * DAY });
  seedGame({ user: 'bob', started: now - HOUR }); // still playing
  const id = seedMessage({ user: 'alice', at: now - 12 * DAY });
  seedReaction({ message: id, author: 'alice', user: 'carol', at: now - DAY });

  const seen = new Map(lastSeenByUser().map((r) => [r.user_id, r]));
  assert.equal(seen.size, 3);
  assert.equal(seen.get('alice').last_seen, now - 3 * DAY);
  assert.equal(seen.get('alice').source, 'in voice');
  assert.ok(closeTo(seen.get('bob').last_seen, now));
  assert.equal(seen.get('bob').source, 'at play');
  assert.equal(seen.get('carol').source, 'reacting');
});
