// Who reacted to whom, with what. Reactions are the half of the chat record
// that messages and tags miss: not what was said, but what it was worth.
//
// Reactions can be taken back, so a removal deletes the row rather than
// recording an event. Timestamps are when we *saw* the reaction — Discord
// doesn't say when one was added — except for reactions imported from history,
// which are dated to their message.
import { getDb, rememberUser, rememberChannel, logName } from '../db/database.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import { isTrackedChannel } from './messageTracker.js';

/** Unicode emoji have no id; '' keeps them out of NULL primary-key trouble. */
function emojiKey(emoji) {
  return { name: emoji.name || emoji.id || '?', id: emoji.id || '' };
}

/** Renderable form: custom emoji need their full tag to show up in Discord. */
export function emojiDisplay(name, id) {
  return id ? `<:${name}:${id}>` : name;
}

/** A message we track reactions for: in-guild, in a logged channel, human. */
function trackable(message) {
  return Boolean(
    message &&
      message.guildId === config.guildId &&
      message.author &&
      !message.author.bot &&
      isTrackedChannel(message.channel)
  );
}

const insertReaction = () =>
  getDb().prepare(
    `INSERT OR IGNORE INTO message_reactions
       (message_id, guild_id, channel_id, author_id, user_id, emoji_name, emoji_id, reacted_at)
     VALUES (@messageId, @guildId, @channelId, @authorId, @userId, @name, @id, @at)`
  );

function addReaction(message, reactor, emoji, at) {
  const { name, id } = emojiKey(emoji);
  const changed = insertReaction().run({
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    userId: reactor.id,
    name,
    id,
    at,
  }).changes;
  if (changed) {
    rememberUser(reactor.id, reactor.username);
    rememberUser(message.author.id, message.author.username);
    rememberChannel(message.channelId, message.channel?.name || message.channelId);
  }
  return changed > 0;
}

function removeReaction(messageId, userId, emoji) {
  const { name, id } = emojiKey(emoji);
  return getDb()
    .prepare(
      `DELETE FROM message_reactions
       WHERE message_id = ? AND user_id = ? AND emoji_name = ? AND emoji_id = ?`
    )
    .run(messageId, userId, name, id).changes;
}

/**
 * Resolve the partials a reaction event can arrive as. Reactions on messages
 * sent before the bot started come through uncached, so both the reaction and
 * its message may need fetching before there's anything to read.
 */
async function resolve(reaction) {
  if (reaction.partial) await reaction.fetch();
  return reaction.message.partial ? await reaction.message.fetch() : reaction.message;
}

/** discord.js messageReactionAdd handler. */
export async function handleReactionAdd(reaction, user) {
  if (user.bot) return;
  try {
    const message = await resolve(reaction);
    if (!trackable(message)) return;
    if (addReaction(message, user, reaction.emoji, Date.now())) {
      logger.debug(
        `reaction: ${logName(user.id)} ${reaction.emoji.name} to ${logName(message.author.id)}`
      );
    }
  } catch (err) {
    // A deleted message, or one in a channel we've lost access to. Nothing to record.
    logger.debug(`reactionAdd skipped: ${err.message}`);
  }
}

/** discord.js messageReactionRemove handler. */
export async function handleReactionRemove(reaction, user) {
  if (user.bot) return;
  try {
    // No fetch needed: the message id and emoji are enough to find the row,
    // and the message may well be gone by now.
    removeReaction(reaction.message.id, user.id, reaction.emoji);
  } catch (err) {
    logger.debug(`reactionRemove skipped: ${err.message}`);
  }
}

/** discord.js messageReactionRemoveAll handler — a message cleared wholesale. */
export function handleReactionRemoveAll(message) {
  getDb().prepare('DELETE FROM message_reactions WHERE message_id = ?').run(message.id);
}

/** discord.js messageReactionRemoveEmoji handler — one emoji cleared. */
export function handleReactionRemoveEmoji(reaction) {
  const { name, id } = emojiKey(reaction.emoji);
  getDb()
    .prepare(
      'DELETE FROM message_reactions WHERE message_id = ? AND emoji_name = ? AND emoji_id = ?'
    )
    .run(reaction.message.id, name, id);
}

/**
 * Reconcile the stored reactions for a fetched message against its current
 * state: adds what's missing, drops what's been taken back. Used when importing
 * history, where the API gives the whole picture at once and live add/remove
 * events were never seen. Reactions found this way are dated to their message.
 *
 * Returns the number of reaction rows added.
 */
export async function syncMessageReactions(message) {
  if (!trackable(message)) return 0;

  // No early exit on an empty reaction list: a message everyone un-reacted
  // while we were offline still has rows here that need clearing.
  const seen = new Set();
  let added = 0;
  for (const reaction of message.reactions.cache.values()) {
    const { name, id } = emojiKey(reaction.emoji);
    // users.fetch() is a request per emoji per message, which is why importing
    // reactions is opt-in rather than part of every backfill.
    const users = await reaction.users.fetch();
    for (const user of users.values()) {
      if (user.bot) continue;
      seen.add(`${user.id}|${name}|${id}`);
      if (addReaction(message, user, reaction.emoji, message.createdTimestamp)) added++;
    }
  }

  // Anything we hold that the API no longer reports was taken back while we
  // were away. Existing rows keep their original timestamps; only these go.
  const stale = getDb()
    .prepare('SELECT user_id, emoji_name, emoji_id FROM message_reactions WHERE message_id = ?')
    .all(message.id)
    .filter((row) => !seen.has(`${row.user_id}|${row.emoji_name}|${row.emoji_id}`));
  for (const row of stale) {
    removeReaction(message.id, row.user_id, { name: row.emoji_name, id: row.emoji_id || null });
  }
  return added;
}
