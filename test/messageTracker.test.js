import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { recordMessage, isTrackedChannel } from '../src/tracking/messageTracker.js';
import { getDb } from '../src/db/database.js';
import { freshDb, GUILD } from './helpers.js';

beforeEach(() => freshDb());

const user = (id, bot = false) => ({ id, username: id, bot });

/** Enough of a discord.js Message for recordMessage. */
function fakeMessage({
  id = 'msg1',
  author = user('alice'),
  content = 'hello there world',
  mentions = [],
  repliedUser = null,
  channel = { id: 'general', name: 'general', parent: null },
  attachments = 0,
} = {}) {
  return {
    id,
    guildId: GUILD,
    channelId: channel.id,
    channel,
    author,
    content,
    system: false,
    createdTimestamp: Date.now(),
    attachments: { size: attachments },
    mentions: { users: new Collection(mentions.map((u) => [u.id, u])), repliedUser },
  };
}

const mentionRows = () => getDb().prepare('SELECT to_user_id, kind FROM message_mentions ORDER BY to_user_id').all();

test('stores the message with word and character counts', () => {
  assert.equal(recordMessage(fakeMessage({ content: '  two   words ', attachments: 2 })), true);
  const row = getDb().prepare('SELECT * FROM messages').get();
  assert.equal(row.user_id, 'alice');
  assert.equal(row.word_count, 2);
  assert.equal(row.char_count, 14);
  assert.equal(row.attachments, 2);
  assert.equal(row.has_link, 0);
});

test('links are flagged and the same message is never stored twice', () => {
  const msg = fakeMessage({ content: 'see https://example.com' });
  assert.equal(recordMessage(msg), true);
  assert.equal(recordMessage(msg), false);
  assert.equal(getDb().prepare('SELECT has_link FROM messages').get().has_link, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('a reply that also pings its target is one tag, not two', () => {
  const bob = user('bob');
  recordMessage(fakeMessage({ mentions: [bob], repliedUser: bob }));
  assert.deepEqual(mentionRows(), [{ to_user_id: 'bob', kind: 'mention' }]);
});

test('a bare reply is recorded as a reply tag', () => {
  recordMessage(fakeMessage({ repliedUser: user('bob') }));
  assert.deepEqual(mentionRows(), [{ to_user_id: 'bob', kind: 'reply' }]);
});

test('tagging yourself or a bot is not a tag', () => {
  recordMessage(fakeMessage({ mentions: [user('alice'), user('robot', true)] }));
  assert.deepEqual(mentionRows(), []);
  assert.equal(getDb().prepare('SELECT mention_count FROM messages').get().mention_count, 0);
});

test('bots, system messages and other guilds are ignored', () => {
  assert.equal(recordMessage(fakeMessage({ author: user('beep', true) })), false);
  assert.equal(recordMessage({ ...fakeMessage(), system: true }), false);
  assert.equal(recordMessage({ ...fakeMessage(), guildId: 'elsewhere' }), false);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('an empty channel allowlist tracks everything, threads included', () => {
  assert.equal(isTrackedChannel({ id: 'x', name: 'anything', parent: null }), true);
  assert.equal(isTrackedChannel(null), false);
});
