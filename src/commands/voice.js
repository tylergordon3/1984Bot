import { SlashCommandBuilder } from 'discord.js';
import {
  voiceLeaderboard,
  voiceTotalForUser,
  voiceCompanions,
  voiceHourHistogram,
  voiceFlagTotalsForUser,
  voiceFlagLeaderboard,
} from '../stats/queries.js';
import { rememberUser, displayName } from '../db/database.js';
import {
  addPeriodOption,
  getWindow,
  userLeaderboardLines,
  baseEmbed,
  formatDuration,
  renderHeatmap,
  hourLabel,
} from './_shared.js';

const FLAG_LABELS = {
  streaming: '🔴 Streaming',
  muted: '🔇 Muted',
  deafened: '🔕 Deafened',
  video: '📹 Camera',
};

const voiceleaderboard = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('voiceleaderboard')
      .setDescription('Who spent the most time in voice')
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const rows = voiceLeaderboard(window, 15);
    const embed = baseEmbed('🎙️ Voice Leaderboard', window).setDescription(
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

    const embed = baseEmbed(`🎙️ Voice dossier — ${target.username}`, window);
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

    const flags = voiceFlagTotalsForUser(target.id, window);
    const behaviour = Object.entries(FLAG_LABELS)
      .filter(([key]) => flags[key] > 0)
      .map(([key, label]) => `${label}: ${formatDuration(flags[key])}`)
      .join('\n');
    if (behaviour) embed.addFields({ name: 'Time spent', value: behaviour });

    await interaction.reply({ embeds: [embed] });
  },
};

const voiceflag = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('voiceflag')
      .setDescription('Leaderboard for time streaming / muted / deafened / on camera')
      .addStringOption((o) =>
        o
          .setName('state')
          .setDescription('Which state to rank')
          .setRequired(true)
          .addChoices(
            { name: '🔴 Streaming', value: 'streaming' },
            { name: '🔇 Muted', value: 'muted' },
            { name: '🔕 Deafened', value: 'deafened' },
            { name: '📹 Camera', value: 'video' }
          )
      )
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const state = interaction.options.getString('state');
    const rows = voiceFlagLeaderboard(state, window, 15);
    const embed = baseEmbed(`${FLAG_LABELS[state]} Leaderboard`, window).setDescription(
      userLeaderboardLines(rows)
    );
    await interaction.reply({ embeds: [embed] });
  },
};

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
    const embed = baseEmbed('🕐 Voice activity by hour', window);
    if (Math.max(...hours) === 0) {
      embed.setDescription('_No voice activity recorded for this period._');
    } else {
      embed.setDescription(renderHeatmap(hours));
      embed.addFields({
        name: 'Peak hour',
        value: `**${hourLabel(busiest)}** (${formatDuration(hours[busiest])} of combined presence)`,
      });
    }
    embed.setFooter({ text: '1984Bot • server local time' });
    await interaction.reply({ embeds: [embed] });
  },
};

export default [voicestats, voiceleaderboard, voiceheatmap, voiceflag];
