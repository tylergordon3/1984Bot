import { getDb, rememberUser, rememberChannel, logName } from '../db/database.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

const LINK_RE = /https?:\/\/\S/i;
const CATCHUP_PAGES = 10; // ≤1000 missed messages per channel recovered on boot

/**
 * Is this a channel we log? Empty allowlist means everything the bot can see.
 * Threads inherit their parent channel's setting.
 */
export function isTrackedChannel(channel) {
  if (!channel) return false;
  const allow = config.messageChannels;
  if (allow.length === 0) return true;
  const matches = (c) =>
    Boolean(c) && (allow.includes(c.id) || allow.includes((c.name || '').toLowerCase()));
  return matches(channel) || matches(channel.parent);
}

const insertMessage = () =>
  getDb().prepare(
    `INSERT OR IGNORE INTO messages
       (message_id, guild_id, channel_id, user_id, sent_at,
        char_count, word_count, attachments, has_link, mention_count, is_reply)
     VALUES
       (@messageId, @guildId, @channelId, @userId, @sentAt,
        @charCount, @wordCount, @attachments, @hasLink, @mentionCount, @isReply)`
  );

const insertMention = () =>
  getDb().prepare(
    `INSERT OR IGNORE INTO message_mentions
       (message_id, guild_id, channel_id, from_user_id, to_user_id, kind, sent_at)
     VALUES (@messageId, @guildId, @channelId, @fromUserId, @toUserId, @kind, @sentAt)`
  );

/**
 * Persist one message and the tags it contains. Idempotent — re-running over
 * history (backfill, catch-up) inserts nothing new. Returns true if stored.
 *
 * A reply that also pings its target yields a single tag row, `kind = 'mention'`;
 * `kind = 'reply'` is only used when the reply-ping is the sole tag.
 */
export function recordMessage(message) {
  if (!message.guildId || message.guildId !== config.guildId) return false;
  if (message.system || !message.author || message.author.bot) return false;
  if (!isTrackedChannel(message.channel)) return false;

  const content = message.content || ''; // empty without the MessageContent intent
  const mentioned = message.mentions.users.filter(
    (u) => !u.bot && u.id !== message.author.id
  );
  const repliedUser = message.mentions.repliedUser;
  const sentAt = message.createdTimestamp;

  const row = {
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    sentAt,
    charCount: content.length,
    wordCount: content.trim() ? content.trim().split(/\s+/).length : 0,
    attachments: message.attachments.size,
    hasLink: LINK_RE.test(content) ? 1 : 0,
    mentionCount: mentioned.size,
    isReply: repliedUser ? 1 : 0,
  };

  const db = getDb();
  const stored = db.transaction(() => {
    if (insertMessage().run(row).changes === 0) return false; // already have it

    const tag = insertMention();
    const base = {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      fromUserId: message.author.id,
      sentAt,
    };
    for (const user of mentioned.values()) {
      tag.run({ ...base, toUserId: user.id, kind: 'mention' });
      rememberUser(user.id, user.username);
    }
    if (repliedUser && !repliedUser.bot && repliedUser.id !== message.author.id) {
      // INSERT OR IGNORE keeps the 'mention' row if they were pinged directly too.
      tag.run({ ...base, toUserId: repliedUser.id, kind: 'reply' });
      rememberUser(repliedUser.id, repliedUser.username);
    }
    return true;
  })();

  if (stored) {
    rememberUser(message.author.id, message.author.username);
    rememberChannel(message.channelId, message.channel?.name || message.channelId);
  }
  return stored;
}

/** discord.js messageCreate handler. */
export function handleMessageCreate(message) {
  if (recordMessage(message)) {
    logger.debug(`message: ${logName(message.author.id)} in #${message.channel?.name}`);
  }
}

function newestMessageId(channelId) {
  const row = getDb()
    .prepare('SELECT message_id FROM messages WHERE channel_id = ? ORDER BY sent_at DESC LIMIT 1')
    .get(channelId);
  return row?.message_id;
}

/**
 * On startup: pull anything said while the bot was down, per tracked channel,
 * picking up after the newest message we already have. Channels with no history
 * yet are left alone — seeding those is `npm run backfill`'s job, not a boot task.
 */
export async function catchUpMessages(guild) {
  let recovered = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased?.() || !channel.viewable) continue;
    if (!isTrackedChannel(channel)) continue;

    let after = newestMessageId(channel.id);
    if (!after) continue;

    try {
      for (let page = 0; page < CATCHUP_PAGES; page++) {
        const batch = await channel.messages.fetch({ after, limit: 100 });
        if (batch.size === 0) break;
        // fetch() returns newest-first; walk oldest-first so `after` advances.
        const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const message of ordered) if (recordMessage(message)) recovered++;
        after = ordered[ordered.length - 1].id;
        if (batch.size < 100) break;
      }
    } catch (err) {
      logger.warn(`Could not catch up #${channel.name}: ${err.message}`);
    }
  }
  logger.info(`Messages reconciled: ${recovered} recovered from downtime.`);
  return recovered;
}
