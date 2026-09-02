import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod, previousWindow, formatDuration, DAY, HOUR, MINUTE } from '../src/util/time.js';

test('resolvePeriod windows end now and have the documented lengths', () => {
  const week = resolvePeriod('week');
  assert.ok(Math.abs(week.until - Date.now()) < 1000);
  assert.equal(week.until - week.since, 7 * DAY);
  const length = (period) => {
    const w = resolvePeriod(period);
    return w.until - w.since;
  };
  assert.equal(length('day'), DAY);
  assert.equal(length('month'), 30 * DAY);
  assert.equal(resolvePeriod('all').since, 0);
  assert.equal(resolvePeriod('all').range, 'all time');
  assert.equal(resolvePeriod('nonsense').label, 'past 7 days');
});

test('previousWindow is the same length, ending where this one starts', () => {
  const week = resolvePeriod('week');
  const prev = previousWindow(week);
  assert.equal(prev.until, week.since);
  assert.equal(prev.until - prev.since, 7 * DAY);
  assert.equal(prev.label, 'previous 7 days');
  assert.match(prev.range, /–/);
});

test('previousWindow has nothing to offer for all time', () => {
  assert.equal(previousWindow(resolvePeriod('all')), null);
  assert.equal(previousWindow(null), null);
});

test('formatDuration rounds down to minutes and never goes negative', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(-5 * MINUTE), '0m');
  assert.equal(formatDuration(59 * 1000), '0m');
  assert.equal(formatDuration(3 * HOUR + 12 * MINUTE), '3h 12m');
  assert.equal(formatDuration(2 * DAY + 5 * MINUTE), '2d 5m');
  assert.equal(formatDuration(DAY), '1d');
});
