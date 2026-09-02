import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { currentAwards, scopeOf, AWARD_SCOPES } from '../src/milestones/checks.js';
import { record, hasAward, awardValue, recentAwards, isScopeSeeded, markScopeSeeded } from '../src/milestones/store.js';
import { freshDb, seedVoice, seedMessages, HOUR, MINUTE } from './helpers.js';

beforeEach(() => freshDb());

const keys = (opts) => currentAwards(opts).map((a) => a.key);

test('only the highest threshold crossed is emitted', () => {
  const now = Date.now();
  // 60 hours over two sessions: past 10, 25 and 50 — one award, for 50.
  seedVoice({ user: 'alice', joined: now - 40 * HOUR, left: now - 10 * HOUR });
  seedVoice({ user: 'alice', joined: now - 100 * HOUR, left: now - 70 * HOUR });
  const found = keys().filter((k) => k.startsWith('voice_hours:'));
  assert.deepEqual(found, ['voice_hours:alice:50']);
});

test('nothing is awarded below the first threshold', () => {
  const now = Date.now();
  seedVoice({ user: 'alice', joined: now - 5 * HOUR, left: now - MINUTE });
  seedMessages('alice', 40, now - HOUR);
  assert.equal(keys().filter((k) => /^(voice_hours|messages):/.test(k)).length, 0);
});

test('message counts cross their own thresholds', () => {
  seedMessages('alice', 500, Date.now() - HOUR);
  assert.ok(keys().includes('messages:alice:500'));
});

test('a long voice session is a record with its holder and length', () => {
  const now = Date.now();
  seedVoice({ user: 'alice', joined: now - 3 * HOUR, left: now - MINUTE });
  seedVoice({ user: 'bob', joined: now - 90 * MINUTE, left: now - MINUTE });
  const award = currentAwards().find((a) => a.key === 'record:voice_session');
  assert.ok(award, 'expected a voice session record');
  assert.equal(award.isRecord, true);
  assert.equal(award.userId, 'alice');
  assert.equal(award.value, 3 * HOUR - MINUTE);
  assert.equal(scopeOf(award), 'record:voice_session');
  assert.ok(AWARD_SCOPES.includes(scopeOf(award)));
});

test('the store remembers awards, updates records in place, and hides baselines', () => {
  record({ key: 'voice_hours:alice:10', kind: 'voice_hours', userId: 'alice', value: 10, at: 0 });
  record({ key: 'record:voice_session', kind: 'record', userId: 'alice', value: 100 });
  record({ key: 'record:voice_session', kind: 'record', userId: 'bob', value: 200 });

  assert.equal(hasAward('voice_hours:alice:10'), true);
  assert.equal(hasAward('voice_hours:alice:25'), false);
  assert.equal(awardValue('record:voice_session').user_id, 'bob');
  assert.equal(awardValue('record:voice_session').value, 200);
  // Baseline rows (awarded_at 0) were never announced, so never "recent".
  assert.deepEqual(
    recentAwards().map((a) => a.key),
    ['record:voice_session']
  );
});

test('scopes are seeded independently', () => {
  assert.equal(isScopeSeeded('voice_hours'), false);
  markScopeSeeded('voice_hours');
  assert.equal(isScopeSeeded('voice_hours'), true);
  assert.equal(isScopeSeeded('messages'), false);
});
