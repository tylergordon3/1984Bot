import { EmbedBuilder } from 'discord.js';
import { resolvePeriod, formatDuration } from '../util/time.js';
import { displayName } from '../db/database.js';

const PERIOD_CHOICES = [
  { name: 'Day (24h)', value: 'day' },
  { name: 'Week', value: 'week' },
  { name: 'Month', value: 'month' },
  { name: 'Year', value: 'year' },
  { name: 'All time', value: 'all' },
];

/** Attach a standard "period" option to a slash command builder. */
export function addPeriodOption(builder) {
  return builder.addStringOption((o) =>
    o.setName('period').setDescription('Time window (default: week)').addChoices(...PERIOD_CHOICES)
  );
}

export function getWindow(interaction) {
  return resolvePeriod(interaction.options.getString('period') || 'week');
}

export function medal(i) {
  return ['🥇', '🥈', '🥉'][i] || `\`#${i + 1}\``;
}

/** Render rows of { user_id, ms } into leaderboard lines. */
export function userLeaderboardLines(rows) {
  if (rows.length === 0) return '_No data for this period._';
  return rows
    .map((r, i) => `${medal(i)} **${displayName(r.user_id)}** — ${formatDuration(r.ms)}`)
    .join('\n');
}

/**
 * Standard summary embed. Puts the period + concrete date range prominently at
 * the top (author line, above the title), e.g. "Past 7 days · Jul 24 – Jul 31, 2026".
 */
export function baseEmbed(title, window) {
  const label = window.label.charAt(0).toUpperCase() + window.label.slice(1);
  const heading = window.range === 'all time' ? 'All time' : `${label} · ${window.range}`;
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0xcc0000)
    .setAuthor({ name: `📅 ${heading}` })
    .setFooter({ text: '1984Bot' })
    .setTimestamp();
}

export { formatDuration };
