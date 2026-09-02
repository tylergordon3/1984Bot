import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editionChannel } from '../src/digest/scheduler.js';

test('the weekly edition has its own channel; the daily keeps the default', () => {
  assert.equal(editionChannel('daily'), 'bot-room');
  assert.equal(editionChannel('weekly'), 'town-square');
});
