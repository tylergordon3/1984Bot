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
 * Render rows into leaderboard lines using a count column, e.g.
 * `countLeaderboardLines(rows, 'messages', 'message')` → "🥇 **alice** — 412 messages".
 */
export function countLeaderboardLines(rows, key, noun) {
  if (rows.length === 0) return '_No data for this period._';
  return rows
    .map((r, i) => {
      const n = r[key];
      return `${medal(i)} **${displayName(r.user_id)}** — ${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
    })
    .join('\n');
}

/** Sparkline bars for a 24-slot hour-of-day histogram. */
export function renderHeatmap(hours) {
  const max = Math.max(...hours, 1);
  const blocks = '▁▂▃▄▅▆▇█';
  const lines = [];
  for (let h = 0; h < 24; h += 12) {
    let row = '';
    for (let i = h; i < h + 12; i++) {
      const level = hours[i] === 0 ? 0 : 1 + Math.floor((hours[i] / max) * (blocks.length - 1));
      row += blocks[Math.min(level, blocks.length - 1)];
    }
    lines.push(`\`${String(h).padStart(2, '0')}:00\` ${row} \`${String(h + 11).padStart(2, '0')}:59\``);
  }
  return lines.join('\n');
}

/** "14:00–14:59" for an hour index. */
export function hourLabel(h) {
  return `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`;
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
