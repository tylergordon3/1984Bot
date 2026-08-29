import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { displayName, rememberUser } from '../db/database.js';
import { currentStreaks, longestStreaks, streakForUser } from '../stats/streaks.js';
import { medal } from './_shared.js';

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

const streaks = {
  data: new SlashCommandBuilder()
    .setName('streaks')
    .setDescription('Who has turned up every day, and for how long')
    .addUserOption((o) => o.setName('user').setDescription('Show one person in detail')),
  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const embed = new EmbedBuilder()
      .setColor(0xcc0000)
      .setFooter({ text: '1984Bot · a day counts as a message sent or any time in voice' })
      .setTimestamp();

    if (target) {
      rememberUser(target.id, target.username);
      const s = streakForUser(target.id);
      embed.setTitle(`📆 Attendance — ${target.username}`);
      if (!s.lastDay) {
        embed.setDescription('_Never observed. Not once._');
      } else {
        const lines = [
          s.current > 0
            ? `**Current streak:** ${days(s.current)} — since ${s.start}`
            : `**Current streak:** none — last seen ${s.lastDay}`,
          `**Longest ever:** ${days(s.longest)}` +
            (s.longestRun ? ` (${s.longestRun.start} to ${s.longestRun.end})` : ''),
        ];
        if (s.ended && s.ended.length >= 2) {
          lines.push(`**Last streak:** ${days(s.ended.length)}, ended ${s.ended.end}`);
        }
        embed.setDescription(lines.join('\n'));
      }
      await interaction.reply({ embeds: [embed] });
      return;
    }

    embed.setTitle('📆 Attendance streaks');
    const live = currentStreaks(10);
    const best = longestStreaks(10);

    if (live.length === 0 && best.length === 0) {
      embed.setDescription('_Nothing recorded yet._');
      await interaction.reply({ embeds: [embed] });
      return;
    }

    embed.addFields({
      name: '🔥 Running now',
      value:
        live.length > 0
          ? live
              .map((s, i) => `${medal(i)} **${displayName(s.user_id)}** — ${days(s.current)}`)
              .join('\n')
          : '_Nobody has a streak going._',
      inline: true,
    });
    embed.addFields({
      name: '🏆 Longest ever',
      value: best
        .map((s, i) => `${medal(i)} **${displayName(s.user_id)}** — ${days(s.longest)}`)
        .join('\n'),
      inline: true,
    });

    await interaction.reply({ embeds: [embed] });
  },
};

export default [streaks];
