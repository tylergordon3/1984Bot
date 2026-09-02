import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod } from '../src/util/time.js';
import { buildDigest } from '../src/digest/report.js';
import {
  freshDb,
  seedVoice,
  seedMessages,
  seedMessage,
  fakeGuild,
  fieldOf,
  HOUR,
  DAY,
} from './helpers.js';

beforeEach(() => freshDb());

const description = (embed) => embed.toJSON().description;

test('a dead period produces no report at all', () => {
  assert.equal(buildDigest(resolvePeriod('week')), null);
  seedMessages('alice', 5, Date.now() - 20 * DAY);
  assert.equal(buildDigest(resolvePeriod('week')), null);
  assert.ok(buildDigest(resolvePeriod('month')));
});

test('headline and leaderboard figures carry trends against the previous window', () => {
  const now = Date.now();
  seedMessages('alice', 200, now - HOUR);
  seedMessages('alice', 100, now - 8 * DAY);
  seedMessages('bob', 50, now - HOUR);
  seedVoice({ user: 'alice', joined: now - 3 * HOUR, left: now - HOUR });
  seedVoice({ user: 'alice', joined: now - 9 * DAY, left: now - 9 * DAY + 4 * HOUR });

  const embed = buildDigest(resolvePeriod('week'));
  const text = description(embed);
  assert.match(text, /\*\*250\*\* messages \(▲ 150%\)/);
  assert.match(text, /2h\*\* of voice time \(everyone combined\) \(▼ 50%\)/);
  assert.match(text, /\*\*2\*\* under observation \(▲ 100%\)/);
  assert.match(text, /Trends are against the previous 7 days/);

  const loudest = fieldOf(embed, '🗣️').value;
  assert.match(loudest, /\*\*alice\*\* — 200 msg \(▲ 100%\)/);
  assert.match(loudest, /\*\*bob\*\* — 50 msg \(▲ from 0\)/);
});

test('small changes read as flat', () => {
  const now = Date.now();
  seedMessages('alice', 100, now - HOUR);
  seedMessages('alice', 98, now - 8 * DAY);
  assert.match(description(buildDigest(resolvePeriod('week'))), /\*\*100\*\* messages \(▬ flat\)/);
});

test('no trends before the record began, nor for all time', () => {
  seedMessages('alice', 10, Date.now() - HOUR);
  for (const period of ['week', 'all']) {
    const embed = buildDigest(resolvePeriod(period));
    assert.doesNotMatch(description(embed), /[▲▼▬]/, period);
    assert.doesNotMatch(fieldOf(embed, '🗣️').value, /[▲▼▬]/, period);
  }
});

test('missing persons names current members unseen past the threshold', () => {
  const now = Date.now();
  seedMessages('alice', 5, now - HOUR);
  seedMessage({ user: 'bob', at: now - 10 * DAY });
  seedVoice({ user: 'carol', joined: now - 20 * DAY, left: now - 20 * DAY + HOUR });
  seedMessage({ user: 'gone', at: now - 30 * DAY }); // no longer a member
  seedMessage({ user: 'beep', at: now - 30 * DAY }); // a bot
  seedMessage({ user: 'dave', at: now - 6 * DAY }); // not yet missing

  const guild = fakeGuild({ alice: {}, bob: {}, carol: {}, beep: { bot: true }, dave: {} });
  const field = fieldOf(buildDigest(resolvePeriod('week'), 'x', { guild }), '🕵️');
  assert.ok(field, 'expected a missing persons section');
  assert.match(field.name, /7\+ days/);
  assert.deepEqual(
    field.value.split('\n').map((l) => l.match(/\*\*(\w+)\*\*/)[1]),
    ['carol', 'bob']
  );
  assert.match(field.value, /\*\*carol\*\* — last seen in voice <t:\d+:R>/);
  assert.match(field.value, /\*\*bob\*\* — last seen in chat/);
});

test('missing persons is capped, with the overflow counted', () => {
  const now = Date.now();
  seedMessages('alice', 5, now - HOUR);
  const members = { alice: {} };
  for (let i = 0; i < 7; i++) {
    seedMessage({ user: `ghost${i}`, at: now - (10 + i) * DAY });
    members[`ghost${i}`] = {};
  }
  const field = fieldOf(buildDigest(resolvePeriod('week'), 'x', { guild: fakeGuild(members) }), '🕵️');
  const lines = field.value.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0].includes('ghost6'), true); // longest absent first
  assert.match(lines[5], /…and 2 more unaccounted for/);
});

test('missing persons is skipped when the whole record has gone quiet, or without a guild', () => {
  const now = Date.now();
  seedMessages('alice', 5, now - 10 * DAY);
  seedMessage({ user: 'bob', at: now - 12 * DAY });
  const guild = fakeGuild({ alice: {}, bob: {} });
  // Everyone is "missing" — that's the bot having been down, not the members.
  assert.equal(fieldOf(buildDigest(resolvePeriod('month'), 'x', { guild }), '🕵️'), undefined);

  seedMessage({ user: 'alice', at: now - HOUR });
  assert.ok(fieldOf(buildDigest(resolvePeriod('month'), 'x', { guild }), '🕵️'));
  assert.equal(fieldOf(buildDigest(resolvePeriod('month')), '🕵️'), undefined);
});
