import { SlashCommandBuilder } from 'discord.js';
import {
  userGameStats,
  userGameTotal,
  guildTopGames,
  gamePlayerLeaderboard,
} from '../stats/queries.js';
import { rememberUser } from '../db/database.js';
import { addPeriodOption, getWindow, userLeaderboardLines, baseEmbed, medal, formatDuration } from './_shared.js';

const gamestats = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('gamestats')
      .setDescription("A user's most-played games")
      .addUserOption((o) => o.setName('user').setDescription('Defaults to you'))
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const target = interaction.options.getUser('user') || interaction.user;
    rememberUser(target.id, target.username);

    const total = userGameTotal(target.id, window);
    const games = userGameStats(target.id, window, 12);
    const embed = baseEmbed(`🎮 Game dossier — ${target.username}`, window.label);
    if (total === 0) {
      embed.setDescription('_No games recorded for this period._');
    } else {
      embed.setDescription(`**Total game time:** ${formatDuration(total)}`);
      embed.addFields({
        name: 'Most played',
        value: games
          .map((g, i) => `${medal(i)} **${g.game_name}** — ${formatDuration(g.ms)}`)
          .join('\n'),
      });
    }
    await interaction.reply({ embeds: [embed] });
  },
};

const gameleaderboard = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('gameleaderboard')
      .setDescription('Who logged the most total game time')
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const rows = gamePlayerLeaderboard(window, 15);
    const embed = baseEmbed('🎮 Game-time Leaderboard', window.label).setDescription(
      userLeaderboardLines(rows)
    );
    await interaction.reply({ embeds: [embed] });
  },
};

const topgames = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('topgames')
      .setDescription('The most-played games across the whole server')
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const rows = guildTopGames(window, 15);
    const embed = baseEmbed('🏆 Top games in the server', window.label);
    if (rows.length === 0) {
      embed.setDescription('_No games recorded for this period._');
    } else {
      embed.setDescription(
        rows
          .map(
            (r, i) =>
              `${medal(i)} **${r.game_name}** — ${formatDuration(r.ms)} ` +
              `(${r.players} player${r.players === 1 ? '' : 's'})`
          )
          .join('\n')
      );
    }
    await interaction.reply({ embeds: [embed] });
  },
};

export default [gamestats, gameleaderboard, topgames];
