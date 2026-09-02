import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, streakState, currentStreaks, streakForUser } from '../src/stats/streaks.js';
import { freshDb, seedVoice, seedMessage, HOUR, DAY, MINUTE } from './helpers.js';

beforeEach(() => freshDb());

const daysAgo = (n) => dayKey(Date.now() - n * DAY);

test('a run touching today or yesterday is alive', () => {
  const alive = streakState(new Set([daysAgo(2), daysAgo(1), daysAgo(0)]));
  assert.equal(alive.current, 3);
  assert.equal(alive.ended, null);

  const yesterdayOnly = streakState(new Set([daysAgo(2), daysAgo(1)]));
  assert.equal(yesterdayOnly.current, 2);
});

test('a whole day of silence ends the streak and reports it', () => {
  const s = streakState(new Set([daysAgo(5), daysAgo(4), daysAgo(3)]));
  assert.equal(s.current, 0);
  assert.equal(s.ended.length, 3);
  assert.equal(s.longest, 3);
  assert.equal(s.longestCompleted, 3);
});

test('a live run does not count as the completed record', () => {
  const s = streakState(new Set([daysAgo(10), daysAgo(9), daysAgo(1), daysAgo(0)]));
  assert.equal(s.current, 2);
  assert.equal(s.longest, 2);
  assert.equal(s.longestCompleted, 2);
  assert.equal(s.longestCompletedRun.start, daysAgo(10));
});

test('no days at all is an empty state', () => {
  assert.equal(streakState(new Set()).current, 0);
  assert.equal(streakForUser('nobody').current, 0);
});

test('a voice session that crosses midnight counts both days', () => {
  const lastMidnight = new Date();
  lastMidnight.setHours(0, 0, 0, 0);
  seedVoice({
    user: 'alice',
    joined: lastMidnight.getTime() - 30 * MINUTE,
    left: lastMidnight.getTime() + 30 * MINUTE,
  });
  assert.equal(streakForUser('alice').current, 2);
});

test('only voice keeps a streak alive', () => {
  const now = Date.now();
  seedMessage({ user: 'alice', at: now - HOUR });
  seedVoice({ user: 'bob', joined: now - HOUR, left: now - MINUTE });
  const live = currentStreaks().map((s) => s.user_id);
  assert.deepEqual(live, ['bob']);
});
