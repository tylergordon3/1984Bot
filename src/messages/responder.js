import { displayName } from '../db/database.js';
import { resolvePeriod, formatDuration, SECOND } from '../util/time.js';
import {
  messageTotals,
  messageHourHistogram,
  taggedByLeaderboard,
  tagsGivenLeaderboard,
  tagsBetween,
  voiceTotalForUser,
  userGameStats,
} from '../stats/queries.js';
import { logger } from '../util/logger.js';

const COOLDOWN = 8 * SECOND; // per user, so a mention war can't spam the channel
const lastReplyAt = new Map();

const ALL_TIME = () => resolvePeriod('all');

/** Generic surveillance flavour, used when there's nothing specific to say. */
const FLAVOUR = [
  'I am always watching. 👁️',
  'Your file is already open.',
  'Noted. Filed. Cross-referenced.',
  'Everything you say is being recorded — that was never a secret.',
  'The Ministry acknowledges your message.',
  'You have my attention. You have always had my attention.',
  'Big Brother is listening. So am I, but I take better notes.',
  'Statement logged against your permanent record.',
  'I was watching before you typed that.',
  'Curious. I have added it to the dossier.',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const hourText = (h) => `${String(h).padStart(2, '0')}:00`;

// ── Facts, drawn from what we've actually recorded ─────────────────────────

function messageFact(userId, name) {
  const totals = messageTotals(userId, ALL_TIME());
  if (!totals.messages) return null;
  return `**${name}** has sent ${totals.messages.toLocaleString()} messages on record — ${totals.words.toLocaleString()} words of evidence.`;
}

function hourFact(userId, name) {
  const hours = messageHourHistogram(resolvePeriod('month'), { userId });
  const total = hours.reduce((a, b) => a + b, 0);
  if (total < 10) return null;
  const peak = hours.indexOf(Math.max(...hours));
  const share = Math.round((hours[peak] / total) * 100);
  return `**${name}** talks most around **${hourText(peak)}** — ${share}% of their last month landed in that hour.`;
}

function taggerFact(userId, name) {
  const [top] = taggedByLeaderboard(userId, ALL_TIME(), 1);
  if (!top || top.tags < 3) return null;
  return `**${displayName(top.user_id)}** tags **${name}** more than anyone — ${top.tags} times on record.`;
}

function taggedFact(userId, name) {
  const [top] = tagsGivenLeaderboard(userId, ALL_TIME(), 1);
  if (!top || top.tags < 3) return null;
  return `**${name}** can't stop tagging **${displayName(top.user_id)}** — ${top.tags} times and counting.`;
}

function voiceFact(userId, name) {
  const ms = voiceTotalForUser(userId, ALL_TIME());
  if (!ms) return null;
  return `**${name}** has spent ${formatDuration(ms)} in voice. I counted every minute.`;
}

function gameFact(userId, name) {
  const [top] = userGameStats(userId, resolvePeriod('month'), 1);
  if (!top) return null;
  return `**${name}** has put ${formatDuration(top.ms)} into **${top.game_name}** this month. I don't judge. I only record.`;
}

/** Tag balance between the author and someone they tagged in the same message. */
function relationshipFact(authorId, authorName, otherId) {
  const { aToB, bToA } = tagsBetween(authorId, otherId, ALL_TIME());
  if (aToB + bToA === 0) return null;
  const other = displayName(otherId);
  if (bToA === 0) {
    return `**${authorName}** has tagged **${other}** ${aToB} times. **${other}** has never once tagged back.`;
  }
  if (aToB === 0) {
    return `**${other}** has tagged **${authorName}** ${bToA} times and never been tagged back. I keep score.`;
  }
  if (aToB >= bToA * 2 && aToB >= 3) {
    return `**${authorName}** has tagged **${other}** ${aToB} times. **${other}** has returned the favour ${bToA} times. Make of that what you will.`;
  }
  if (bToA >= aToB * 2 && bToA >= 3) {
    return `**${other}** tags **${authorName}** ${bToA} times to their ${aToB}. Someone is doing more of the work here.`;
  }
  return `On record: **${authorName}** → **${other}** ${aToB} tags, **${other}** → **${authorName}** ${bToA}. Balanced. Suspiciously so.`;
}

// ── Routing ────────────────────────────────────────────────────────────────

const ROUTES = [
  { re: /\b(hi|hello|hey|yo|sup|howdy|hiya|good (morning|evening|afternoon))\b/i, facts: [messageFact] },
  { re: /\b(stats?|dossier|file|record|records|report|info)\b/i, facts: [messageFact, voiceFact] },
  { re: /\b(who|tag|tags|tagged|tagging|ping|pings|pinged|mention|mentions)\b/i, facts: [taggerFact, taggedFact] },
  { re: /\b(when|hour|hours|time|late|night|early)\b/i, facts: [hourFact] },
  { re: /\b(voice|vc|call|chat)\b/i, facts: [voiceFact] },
  { re: /\b(game|games|gaming|play|playing)\b/i, facts: [gameFact] },
];

const ALL_FACTS = [messageFact, taggerFact, taggedFact, hourFact, voiceFact, gameFact];

/**
 * What the bot says back. Prefers something it actually knows about whoever is
 * involved; falls back to flavour when there's no data (or no MessageContent
 * intent, in which case `content` is empty and every route misses).
 */
function buildReply(message) {
  const author = message.author;
  const content = message.content || '';
  const route = ROUTES.find((r) => r.re.test(content));
  const others = message.mentions.users.filter((u) => !u.bot && u.id !== author.id);
  const other = others.first();

  const answer = (userId, name, facts) => {
    for (const fact of facts) {
      const line = fact(userId, name);
      if (line) return line;
    }
    return null;
  };

  if (other) {
    // "@1984Bot who tags @bob the most?" — the question is about them, not the asker.
    if (route) {
      const line = answer(other.id, displayName(other.id), [...route.facts, ...ALL_FACTS]);
      if (line) return line;
    }
    const line = relationshipFact(author.id, author.username, other.id);
    if (line) return line;
  }

  return (
    answer(author.id, author.username, route ? [...route.facts, ...ALL_FACTS] : ALL_FACTS) ||
    pick(FLAVOUR)
  );
}

/**
 * Reply when someone @s the bot directly. Role pings and @everyone are ignored —
 * only a direct user mention (or a reply-ping to one of the bot's own messages)
 * counts, so the bot never joins in on mass pings.
 */
export async function handleBotMention(message, client) {
  if (message.author.bot || !message.mentions.users.has(client.user.id)) return;

  const now = Date.now();
  const last = lastReplyAt.get(message.author.id) || 0;
  if (now - last < COOLDOWN) return;
  lastReplyAt.set(message.author.id, now);

  try {
    const content = buildReply(message);
    await message.reply({
      content,
      allowedMentions: { parse: [] }, // never ping anyone we name
    });
  } catch (err) {
    logger.warn(`Could not reply to mention: ${err.message}`);
  }
}
