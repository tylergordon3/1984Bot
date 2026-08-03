import { SlashCommandBuilder, ChannelType } from 'discord.js';
import {
  messageLeaderboard,
  messageTotals,
  messageHourHistogram,
  messageChannelBreakdown,
  taggedByLeaderboard,
  tagsGivenLeaderboard,
  mostTagged,
  biggestTaggers,
  topTagPairs,
} from '../stats/queries.js';
import { rememberUser, displayName, channelName } from '../db/database.js';
import {
  addPeriodOption,
  getWindow,
  baseEmbed,
  medal,
  countLeaderboardLines,
  renderHeatmap,
  hourLabel,
} from './_shared.js';

/** Optional #channel filter, restricted to text channels and threads. */
function addChannelOption(builder) {
  return builder.addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('Only count messages in this channel (default: everywhere)')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread
      )
  );
}

/** `after` / `before` hour filters, e.g. after:14 → "messages sent from 2pm on". */
function addHourOptions(builder) {
  return builder
    .addIntegerOption((o) =>
      o
        .setName('after')
        .setDescription('Only count messages sent at or after this hour (0–23, server local)')
        .setMinValue(0)
        .setMaxValue(23)
    )
    .addIntegerOption((o) =>
      o
        .setName('before')
        .setDescription('Only count messages sent before this hour (0–23, server local)')
        .setMinValue(0)
        .setMaxValue(23)
    );
}

function getFilters(interaction) {
  const channel = interaction.options.getChannel('channel');
  const fromHour = interaction.options.getInteger('after');
  const toHour = interaction.options.getInteger('before');
  return {
    channelId: channel?.id,
    channelLabel: channel ? `#${channel.name}` : null,
    fromHour: fromHour ?? undefined,
    toHour: toHour ?? undefined,
  };
}

/** Human description of the active filters, for the embed footer/description. */
function filterLabel({ channelLabel, fromHour, toHour }) {
  const parts = [];
  if (channelLabel) parts.push(`in ${channelLabel}`);
  if (fromHour != null && toHour != null) {
    parts.push(`between ${String(fromHour).padStart(2, '0')}:00 and ${String(toHour).padStart(2, '0')}:00`);
  } else if (fromHour != null) {
    parts.push(`from ${String(fromHour).padStart(2, '0')}:00 onwards`);
  } else if (toHour != null) {
    parts.push(`before ${String(toHour).padStart(2, '0')}:00`);
  }
  return parts.length ? `Filtered: ${parts.join(', ')}.` : null;
}

const messageleaderboard = {
  data: addHourOptions(
    addChannelOption(
      addPeriodOption(
        new SlashCommandBuilder()
          .setName('messageleaderboard')
          .setDescription('Who sends the most messages (optionally by channel or hour of day)')
      )
    )
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const filters = getFilters(interaction);
    const rows = messageLeaderboard(window, filters, 15);
    const totals = messageTotals(null, window, filters);

    const embed = baseEmbed('💬 Message Leaderboard', window).setDescription(
      countLeaderboardLines(rows, 'messages', 'message')
    );
    const label = filterLabel(filters);
    if (totals.messages > 0) {
      embed.addFields({
        name: 'Server total',
        value:
          `${totals.messages.toLocaleString()} messages from ${totals.people} people` +
          (label ? `\n_${label}_` : ''),
      });
    } else if (label) {
      embed.addFields({ name: 'Filters', value: label });
    }
    await interaction.reply({ embeds: [embed] });
  },
};

const messagestats = {
  data: addChannelOption(
    addPeriodOption(
      new SlashCommandBuilder()
        .setName('messagestats')
        .setDescription("A user's chat dossier: volume, hours, channels, and tags")
        .addUserOption((o) => o.setName('user').setDescription('Defaults to you'))
    )
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const filters = getFilters(interaction);
    const target = interaction.options.getUser('user') || interaction.user;
    rememberUser(target.id, target.username);

    const totals = messageTotals(target.id, window, filters);
    const embed = baseEmbed(`💬 Chat dossier — ${target.username}`, window);

    if (!totals.messages) {
      embed.setDescription('_No messages recorded for this period._');
      return interaction.reply({ embeds: [embed] });
    }

    const avgWords = totals.messages ? Math.round(totals.words / totals.messages) : 0;
    embed.addFields(
      { name: 'Messages', value: totals.messages.toLocaleString(), inline: true },
      { name: 'Words', value: totals.words.toLocaleString(), inline: true },
      { name: 'Avg length', value: `${avgWords} words`, inline: true }
    );

    const hours = messageHourHistogram(window, { ...filters, userId: target.id });
    const peak = hours.indexOf(Math.max(...hours));
    embed.addFields({
      name: 'When they talk',
      value: `${renderHeatmap(hours)}\nPeak: **${hourLabel(peak)}**`,
    });

    if (!filters.channelId) {
      const channels = messageChannelBreakdown(target.id, window, 5);
      if (channels.length) {
        embed.addFields({
          name: 'Where they talk',
          value: channels
            .map((c) => `**${channelName(c.channel_id)}** — ${c.messages.toLocaleString()}`)
            .join('\n'),
        });
      }
    }

    const given = tagsGivenLeaderboard(target.id, window, 5);
    const received = taggedByLeaderboard(target.id, window, 5);
    if (given.length) {
      embed.addFields({
        name: 'Tags the most',
        value: given.map((r) => `**${displayName(r.user_id)}** — ${r.tags}`).join('\n'),
        inline: true,
      });
    }
    if (received.length) {
      embed.addFields({
        name: 'Tagged the most by',
        value: received.map((r) => `**${displayName(r.user_id)}** — ${r.tags}`).join('\n'),
        inline: true,
      });
    }

    const extras = [];
    if (totals.replies) extras.push(`${totals.replies.toLocaleString()} replies`);
    if (totals.links) extras.push(`${totals.links.toLocaleString()} links`);
    if (totals.attachments) extras.push(`${totals.attachments.toLocaleString()} attachments`);
    if (extras.length) embed.addFields({ name: 'Also on file', value: extras.join(' · ') });

    await interaction.reply({ embeds: [embed] });
  },
};

const messageheatmap = {
  data: addChannelOption(
    addPeriodOption(
      new SlashCommandBuilder()
        .setName('messageheatmap')
        .setDescription('Which hours of day the chat is busiest')
        .addUserOption((o) => o.setName('user').setDescription('Narrow to one person'))
    )
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const filters = getFilters(interaction);
    const user = interaction.options.getUser('user');
    const hours = messageHourHistogram(window, { ...filters, userId: user?.id });
    const total = hours.reduce((a, b) => a + b, 0);

    const title = user ? `🕐 Messages by hour — ${user.username}` : '🕐 Messages by hour';
    const embed = baseEmbed(title, window);
    if (total === 0) {
      embed.setDescription('_No messages recorded for this period._');
    } else {
      const peak = hours.indexOf(Math.max(...hours));
      embed.setDescription(renderHeatmap(hours));
      embed.addFields({
        name: 'Peak hour',
        value: `**${hourLabel(peak)}** (${hours[peak].toLocaleString()} of ${total.toLocaleString()} messages)`,
      });
      const label = filterLabel(filters);
      if (label) embed.addFields({ name: 'Filters', value: label });
    }
    embed.setFooter({ text: '1984Bot • server local time' });
    await interaction.reply({ embeds: [embed] });
  },
};

const tagstats = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('tagstats')
      .setDescription('Who tags a person the most — and who they tag back')
      .addUserOption((o) => o.setName('user').setDescription('Defaults to you'))
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const target = interaction.options.getUser('user') || interaction.user;
    rememberUser(target.id, target.username);

    const received = taggedByLeaderboard(target.id, window, 10);
    const given = tagsGivenLeaderboard(target.id, window, 10);
    const totalIn = received.reduce((sum, r) => sum + r.tags, 0);
    const totalOut = given.reduce((sum, r) => sum + r.tags, 0);

    const embed = baseEmbed(`🔔 Tag dossier — ${target.username}`, window);
    if (!totalIn && !totalOut) {
      embed.setDescription('_No tags recorded for this period._');
      return interaction.reply({ embeds: [embed] });
    }

    embed.setDescription(
      `Tagged **${totalIn.toLocaleString()}** times · tagged others **${totalOut.toLocaleString()}** times.`
    );
    if (received.length) {
      embed.addFields({
        name: `Tags ${target.username} the most`,
        value: received
          .map((r, i) => `${medal(i)} **${displayName(r.user_id)}** — ${r.tags}`)
          .join('\n'),
        inline: true,
      });
    }
    if (given.length) {
      embed.addFields({
        name: `${target.username} tags the most`,
        value: given.map((r, i) => `${medal(i)} **${displayName(r.user_id)}** — ${r.tags}`).join('\n'),
        inline: true,
      });
    }

    // Where the relationship is most lopsided, in either direction.
    const givenMap = new Map(given.map((r) => [r.user_id, r.tags]));
    const oneSided = received
      .map((r) => ({ userId: r.user_id, in: r.tags, out: givenMap.get(r.user_id) || 0 }))
      .filter((r) => r.in >= 5 && r.in >= r.out * 3)
      .slice(0, 3);
    if (oneSided.length) {
      embed.addFields({
        name: 'Unrequited',
        value: oneSided
          .map(
            (r) =>
              `**${displayName(r.userId)}** tags them ${r.in}× · gets ${r.out}× back`
          )
          .join('\n'),
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};

const tagleaderboard = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('tagleaderboard')
      .setDescription('Most-tagged people, biggest taggers, and the strongest tag pairs')
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const tagged = mostTagged(window, 10);
    const taggers = biggestTaggers(window, 10);
    const pairs = topTagPairs(window, 10);

    const embed = baseEmbed('🔔 Tag Leaderboard', window);
    if (!tagged.length) {
      embed.setDescription('_No tags recorded for this period._');
      return interaction.reply({ embeds: [embed] });
    }

    embed.addFields(
      {
        name: 'Most tagged',
        value: countLeaderboardLines(tagged, 'tags', 'tag'),
        inline: true,
      },
      {
        name: 'Biggest taggers',
        value: countLeaderboardLines(taggers, 'tags', 'tag'),
        inline: true,
      },
      {
        name: 'Closest pairs',
        value: pairs
          .map(
            (p, i) =>
              `${medal(i)} **${displayName(p.from_user_id)}** → **${displayName(p.to_user_id)}** — ${p.tags}`
          )
          .join('\n'),
      }
    );
    await interaction.reply({ embeds: [embed] });
  },
};

export default [messagestats, messageleaderboard, messageheatmap, tagstats, tagleaderboard];
