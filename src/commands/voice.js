import { SlashCommandBuilder } from 'discord.js';
import {
  voiceLeaderboard,
  voiceTotalForUser,
  voiceCompanions,
  voiceHourHistogram,
} from '../stats/queries.js';
import { rememberUser, displayName } from '../db/database.js';
import { addPeriodOption, getWindow, userLeaderboardLines, baseEmbed, formatDuration } from './_shared.js';

const voiceleaderboard = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('voiceleaderboard')
      .setDescription('Who spent the most time in voice')
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const rows = voiceLeaderboard(window, 15);
    const embed = baseEmbed('🎙️ Voice Leaderboard', window.label).setDescription(
      userLeaderboardLines(rows)
    );
    await interaction.reply({ embeds: [embed] });
  },
};

const voicestats = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('voicestats')
      .setDescription('Voice time, solitude, and closest companions for a user')
      .addUserOption((o) => o.setName('user').setDescription('Defaults to you'))
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const target = interaction.options.getUser('user') || interaction.user;
    rememberUser(target.id, target.username);

    const total = voiceTotalForUser(target.id, window);
    const { aloneMs, companions } = voiceCompanions(target.id, window, 8);

    const embed = baseEmbed(`🎙️ Voice dossier — ${target.username}`, window.label);
    if (total === 0) {
      embed.setDescription('_No voice activity recorded for this period._');
      return interaction.reply({ embeds: [embed] });
    }

    const alonePct = Math.round((aloneMs / total) * 100);
    embed.addFields(
      { name: 'Total in voice', value: formatDuration(total), inline: true },
      { name: 'Alone', value: `${formatDuration(aloneMs)} (${alonePct}%)`, inline: true },
      { name: 'With others', value: formatDuration(total - aloneMs), inline: true }
    );
    if (companions.length) {
      embed.addFields({
        name: 'Most time spent with',
        value: companions
          .map((c, i) => `${i + 1}. **${displayName(c.user_id)}** — ${formatDuration(c.ms)}`)
          .join('\n'),
      });
    }
    await interaction.reply({ embeds: [embed] });
  },
};

function renderHeatmap(hours) {
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

const voiceheatmap = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('voiceheatmap')
      .setDescription('Which hours of day voice channels are busiest')
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const hours = voiceHourHistogram(window);
    const busiest = hours.indexOf(Math.max(...hours));
    const embed = baseEmbed('🕐 Voice activity by hour', window.label);
    if (Math.max(...hours) === 0) {
      embed.setDescription('_No voice activity recorded for this period._');
    } else {
      embed.setDescription(renderHeatmap(hours));
      embed.addFields({
        name: 'Peak hour',
        value: `**${String(busiest).padStart(2, '0')}:00–${String(busiest).padStart(2, '0')}:59** ` +
          `(${formatDuration(hours[busiest])} of combined presence)`,
      });
    }
    embed.setFooter({ text: `1984Bot • ${window.label} • server local time` });
    await interaction.reply({ embeds: [embed] });
  },
};

export default [voicestats, voiceleaderboard, voiceheatmap];
