// The Ministry's report: one embed summarising a window of surveillance,
// built entirely from statistics already in the database. Used both by the
// scheduler (daily / weekly editions) and by /digest on demand.
import { config } from '../config.js';
import { displayName } from '../db/database.js';
import { formatDuration } from '../util/time.js';
import {
  messageTotals,
  messageLeaderboard,
  messageHourHistogram,
  voiceLeaderboard,
  voiceCompanions,
  voiceFlagLeaderboard,
  guildTopGames,
  mostTagged,
  biggestTaggers,
  topReactedMessages,
  reactionsGivenLeaderboard,
  reactionTotals,
} from '../stats/queries.js';
import { currentStreaks } from '../stats/streaks.js';
import { baseEmbed, medal, renderHeatmap, hourLabel } from '../commands/_shared.js';

// How many of the top voice users get the (relatively expensive) interval
// sweep for alone-time and closest-pair. The rest can't plausibly top either.
const DEEP_VOICE_USERS = 6;

const CLOSERS = [
  'Filed, cross-referenced, and remembered.',
  'Nothing here was volunteered. Everything here was recorded.',
  'The record is complete. It always is.',
  'You were observed. You will be observed tomorrow.',
  'No further action is required of you at this time.',
  'This report has been added to every relevant file.',
  'Attendance was noted. Absence was noted more carefully.',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Sum a full leaderboard, not just the rows we display. */
function sumMs(rows) {
  return rows.reduce((total, r) => total + (r.ms || 0), 0);
}

function userLines(rows, render) {
  if (rows.length === 0) return null;
  return rows.map((r, i) => `${medal(i)} ${render(r)}`).join('\n');
}

/**
 * Build the report embed for a window. Returns null when the period was
 * genuinely dead — an empty report is worse than no report.
 */
export function buildDigest(window, title = '👁️ Ministry Report') {
  const totals = messageTotals(null, window);
  const voice = voiceLeaderboard(window, 100);
  const games = guildTopGames(window, 3);
  const voiceMs = sumMs(voice);

  if (!totals.messages && voiceMs === 0 && games.length === 0) return null;

  const embed = baseEmbed(title, window);

  const reactionCount = reactionTotals(window).reactions;
  const headline = [
    `**${totals.messages.toLocaleString()}** message${totals.messages === 1 ? '' : 's'}`,
    reactionCount
      ? `**${reactionCount.toLocaleString()}** reaction${reactionCount === 1 ? '' : 's'}`
      : null,
    `**${formatDuration(voiceMs)}** of voice time (everyone combined)`,
    `**${totals.people}** under observation`,
  ]
    .filter(Boolean)
    .join(' · ');
  embed.setDescription(headline);

  const talkers = messageLeaderboard(window, {}, 3);
  const talkerLines = userLines(
    talkers,
    (r) => `**${displayName(r.user_id)}** — ${r.messages.toLocaleString()} msg`
  );
  if (talkerLines) embed.addFields({ name: '🗣️ Loudest', value: talkerLines, inline: true });

  const voiceLines = userLines(
    voice.slice(0, 3),
    (r) => `**${displayName(r.user_id)}** — ${formatDuration(r.ms)}`
  );
  if (voiceLines) embed.addFields({ name: '🎙️ Most time in voice', value: voiceLines, inline: true });

  if (games.length > 0) {
    embed.addFields({
      name: '🎮 Top games',
      value: games
        .map((g, i) => `${medal(i)} **${g.game_name}** — ${formatDuration(g.ms)}`)
        .join('\n'),
      inline: false,
    });
  }

  // Relationships: who was alone, and who was inseparable.
  const notes = [];
  let lonely = null;
  let pair = null;
  for (const row of voice.slice(0, DEEP_VOICE_USERS)) {
    const { aloneMs, companions } = voiceCompanions(row.user_id, window, 5);
    if (aloneMs > 0 && (!lonely || aloneMs > lonely.ms)) {
      lonely = { user_id: row.user_id, ms: aloneMs };
    }
    for (const c of companions) {
      if (!pair || c.ms > pair.ms) pair = { a: row.user_id, b: c.user_id, ms: c.ms };
    }
  }
  if (pair) {
    notes.push(
      `👥 **${displayName(pair.a)}** and **${displayName(pair.b)}** — ` +
        `${formatDuration(pair.ms)} in the same channel`
    );
  }
  if (lonely) {
    notes.push(`🕯️ **${displayName(lonely.user_id)}** spent ${formatDuration(lonely.ms)} alone in voice`);
  }
  const [streamer] = voiceFlagLeaderboard('streaming', window, 1);
  if (streamer) {
    notes.push(`📺 **${displayName(streamer.user_id)}** streamed for ${formatDuration(streamer.ms)}`);
  }
  const [starred] = topReactedMessages(window, 1);
  if (starred) {
    const link =
      `https://discord.com/channels/${config.guildId}/` +
      `${starred.channel_id}/${starred.message_id}`;
    notes.push(
      `⭐ **${displayName(starred.author_id)}**'s message drew ${starred.reactions} ` +
        `reaction${starred.reactions === 1 ? '' : 's'} — [jump](${link})`
    );
  }
  const [reactor] = reactionsGivenLeaderboard(window, 1);
  if (reactor) {
    notes.push(
      `🙌 **${displayName(reactor.user_id)}** handed out ` +
        `${reactor.reactions} reaction${reactor.reactions === 1 ? '' : 's'}`
    );
  }
  const [streak] = currentStreaks(1);
  if (streak && streak.current >= 3) {
    notes.push(
      `📆 **${displayName(streak.user_id)}** has turned up ` +
        `${streak.current} days running`
    );
  }
  const [tagged] = mostTagged(window, 1);
  if (tagged) {
    notes.push(
      `🏷️ **${displayName(tagged.user_id)}** was tagged ${tagged.tags} time${tagged.tags === 1 ? '' : 's'} ` +
        `by ${tagged.taggers} ${tagged.taggers === 1 ? 'person' : 'people'}`
    );
  }
  const [tagger] = biggestTaggers(window, 1);
  if (tagger && (!tagged || tagger.user_id !== tagged.user_id)) {
    notes.push(`📣 **${displayName(tagger.user_id)}** did the most tagging (${tagger.tags})`);
  }
  if (notes.length > 0) {
    embed.addFields({ name: '📁 Of note', value: notes.join('\n'), inline: false });
  }

  if (totals.messages > 0) {
    const hours = messageHourHistogram(window);
    const peak = hours.indexOf(Math.max(...hours));
    embed.addFields({
      name: `⏰ Chatter by hour — busiest ${hourLabel(peak)}`,
      value: renderHeatmap(hours),
      inline: false,
    });
  }

  embed.setFooter({ text: `1984Bot · ${pick(CLOSERS)}` });
  return embed;
}
