import { SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { displayName, rememberUser } from '../db/database.js';
import { emojiDisplay } from '../tracking/reactionTracker.js';
import {
  reactionsReceivedLeaderboard,
  reactionsGivenLeaderboard,
  reactionTotalsForUser,
  reactionFansOf,
  reactionTargetsOf,
  topEmoji,
  topReactedMessages,
} from '../stats/queries.js';
import { addPeriodOption, getWindow, baseEmbed, medal, countLeaderboardLines } from './_shared.js';

/** Clickable jump link for a message we only know by id. */
function jumpLink(row) {
  return `https://discord.com/channels/${config.guildId}/${row.channel_id}/${row.message_id}`;
}

function emojiLines(rows) {
  if (rows.length === 0) return null;
  return rows
    .map((r) => `${emojiDisplay(r.emoji_name, r.emoji_id)} ${r.uses.toLocaleString()}`)
    .join('   ');
}

const reactionstats = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('reactionstats')
      .setDescription('What a user gets reacted with, and who they react to')
      .addUserOption((o) => o.setName('user').setDescription('Defaults to you'))
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const target = interaction.options.getUser('user') || interaction.user;
    rememberUser(target.id, target.username);

    const { received, given } = reactionTotalsForUser(target.id, window);
    const embed = baseEmbed(`💬 Reaction dossier — ${target.username}`, window);

    if (!received.reactions && !given.reactions) {
      embed.setDescription('_No reactions recorded either way for this period._');
      await interaction.reply({ embeds: [embed] });
      return;
    }

    embed.setDescription(
      `**Received:** ${received.reactions.toLocaleString()} from ${received.people} ` +
        `${received.people === 1 ? 'person' : 'people'}, across ${received.messages} ` +
        `message${received.messages === 1 ? '' : 's'}\n` +
        `**Given:** ${given.reactions.toLocaleString()} to ${given.people} ` +
        `${given.people === 1 ? 'person' : 'people'}`
    );

    const fans = reactionFansOf(target.id, window, 5);
    if (fans.length > 0) {
      embed.addFields({
        name: '🙌 Reacts to them most',
        value: fans
          .map((r, i) => `${medal(i)} **${displayName(r.user_id)}** — ${r.reactions}`)
          .join('\n'),
        inline: true,
      });
    }

    const targets = reactionTargetsOf(target.id, window, 5);
    if (targets.length > 0) {
      embed.addFields({
        name: '👉 They react to most',
        value: targets
          .map((r, i) => `${medal(i)} **${displayName(r.user_id)}** — ${r.reactions}`)
          .join('\n'),
        inline: true,
      });
    }

    const theirs = emojiLines(topEmoji(window, 8, target.id));
    if (theirs) embed.addFields({ name: '🎭 Their emoji', value: theirs, inline: false });

    // Their best message, found by scanning the window's top messages rather
    // than a dedicated query — the leaderboard is already ordered by reactions.
    const [top] = topReactedMessages(window, 100).filter((r) => r.author_id === target.id);
    if (top) {
      embed.addFields({
        name: '⭐ Their best-received message',
        value: `${top.reactions} reaction${top.reactions === 1 ? '' : 's'} — [jump](${jumpLink(top)})`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};

const reactionleaderboard = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('reactionleaderboard')
      .setDescription('Who gets reacted to, who does the reacting, and with what')
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const received = reactionsReceivedLeaderboard(window, 10);
    const given = reactionsGivenLeaderboard(window, 10);
    const embed = baseEmbed('💬 Reactions', window);

    if (received.length === 0 && given.length === 0) {
      embed.setDescription('_No reactions recorded for this period._');
      await interaction.reply({ embeds: [embed] });
      return;
    }

    embed.addFields(
      {
        name: '⭐ Most reacted to',
        value: countLeaderboardLines(received, 'reactions', 'reaction'),
        inline: true,
      },
      {
        name: '🙌 Biggest reactors',
        value: countLeaderboardLines(given, 'reactions', 'reaction'),
        inline: true,
      }
    );

    const emoji = emojiLines(topEmoji(window, 10));
    if (emoji) embed.addFields({ name: '🎭 Most-used emoji', value: emoji, inline: false });

    const top = topReactedMessages(window, 3);
    if (top.length > 0) {
      embed.addFields({
        name: '🏅 Best-received messages',
        value: top
          .map(
            (r, i) =>
              `${medal(i)} **${displayName(r.author_id)}** — ${r.reactions} ` +
              `from ${r.reactors} — [jump](${jumpLink(r)})`
          )
          .join('\n'),
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};

export default [reactionstats, reactionleaderboard];
