import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { rememberUser, displayName } from '../db/database.js';
import {
  extractPlayerUuid,
  linkSmiteSource,
  linkSmite2Live,
  unlinkPlayer,
  getPlayer,
  playerPageUrl,
  listLinkedPlayers,
} from '../smite/store.js';
import { resolveProfile, fetchOverview, fetchStatCard, profileUrl } from '../smite/smite2live.js';
import { autoLinkSmite2Live } from '../smite/autolink.js';
import { SMITE_EMBED_COLOR, statCardEmbed } from '../smite/embeds.js';

const smite = {
  data: new SlashCommandBuilder()
    .setName('smite')
    .setDescription('SMITE 2 session announcements, stats, and profile links')
    .addSubcommand((sub) =>
      sub
        .setName('link')
        .setDescription('Link your SMITE 2 identity for stats and match reports')
        .addStringOption((o) =>
          o
            .setName('profile')
            .setDescription('In-game name (exact), smite2.live profile URL, or smitesource.com/player URL')
            .setRequired(true)
        )
        .addUserOption((o) =>
          o.setName('user').setDescription('Link someone else (defaults to you)')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('Show a SMITE 2 stat card for a member or any player name')
        .addUserOption((o) =>
          o.setName('user').setDescription('Whose stats (defaults to you)')
        )
        .addStringOption((o) =>
          o.setName('name').setDescription('Look up any exact in-game name instead')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('unlink')
        .setDescription('Remove a linked SMITE profile')
        .addUserOption((o) =>
          o.setName('user').setDescription('Unlink someone else (defaults to you)')
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Show all linked SMITE profiles')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'link') return execLink(interaction);
    if (sub === 'stats') return execStats(interaction);
    if (sub === 'unlink') return execUnlink(interaction);
    return execList(interaction);
  },
};

async function execLink(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const query = interaction.options.getString('profile').trim();
  const who = target.id === interaction.user.id ? 'You' : `<@${target.id}>`;
  rememberUser(target.id, target.username);

  // A SmiteSource URL (or bare dashed UUID) links the SmiteSource profile;
  // anything else — an in-game name or smite2.live URL — links smite2.live.
  const smitesourceUuid =
    /smitesource\.com/.test(query) || /^[0-9a-f-]{36}$/i.test(query)
      ? extractPlayerUuid(query)
      : null;
  if (smitesourceUuid) {
    linkSmiteSource(target.id, smitesourceUuid);
    return interaction.reply(
      `👁️ ${who} → SmiteSource profile linked: <${playerPageUrl(smitesourceUuid)}>. ` +
        'Also `/smite link` your in-game name to add smite2.live stats.'
    );
  }

  await interaction.deferReply();
  const resolved = await resolveProfile(query).catch(() => null);
  if (!resolved) {
    return interaction.editReply(
      `Couldn't find **${query}** on smite2.live — the name must match exactly. ` +
        'Search yourself at <https://smite2.live> and paste your profile URL if in doubt.'
    );
  }
  const overview = await fetchOverview(resolved.platform, resolved.id).catch(() => null);
  linkSmite2Live(target.id, {
    platform: resolved.platform,
    id: resolved.id,
    profileId: overview?.profileId ?? null,
    name: overview?.name ?? null,
  });
  return interaction.editReply(
    `👁️ ${who} → linked to **${overview?.name || query}** ` +
      `(<${profileUrl(resolved.platform, resolved.id)}>). Session posts now carry ` +
      'rank, win rates, and top gods — and finished matches get a report here.'
  );
}

async function execStats(interaction) {
  await interaction.deferReply();

  // An explicit name looks up any player, linked or not.
  const name = interaction.options.getString('name')?.trim();
  if (name) {
    const resolved = await resolveProfile(name).catch(() => null);
    if (!resolved) {
      return interaction.editReply(
        `Couldn't find **${name}** on smite2.live — in-game names must match exactly.`
      );
    }
    const card = await fetchStatCard(resolved.platform, resolved.id);
    if (!card) {
      return interaction.editReply('smite2.live is not answering right now — try again in a bit.');
    }
    return interaction.editReply({
      embeds: [statCardEmbed(name, card, { s2l_platform: resolved.platform, s2l_id: resolved.id })],
    });
  }

  const target = interaction.options.getUser('user') || interaction.user;
  let player = getPlayer(target.id);
  let autoLinked = false;
  if (!player?.s2l_platform) {
    // No link yet — try their Discord names before giving up.
    const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
    player = await autoLinkSmite2Live(
      target.id,
      [member?.nickname, target.globalName, target.username],
      { force: true }
    );
    autoLinked = !!player;
  }
  if (!player?.s2l_platform) {
    return interaction.editReply(
      `Couldn't find <@${target.id}> on smite2.live — none of their Discord names match an ` +
        'in-game name. They can `/smite link` their exact SMITE 2 name (or you can run ' +
        '`/smite link profile:<name> user:@them`), or use `/smite stats name:<in-game name>` ' +
        'for a one-off lookup.'
    );
  }
  const card = await fetchStatCard(player.s2l_platform, player.s2l_id);
  if (!card) {
    return interaction.editReply('smite2.live is not answering right now — try again in a bit.');
  }
  return interaction.editReply({
    content: autoLinked
      ? `🔗 Auto-matched to **${player.s2l_name || '?'}** by Discord name and linked — \`/smite unlink\` if that's not them.`
      : undefined,
    embeds: [statCardEmbed(await memberName(interaction.guild, target.id), card, player)],
  });
}

async function execUnlink(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const removed = unlinkPlayer(target.id);
  const who = target.id === interaction.user.id ? 'You' : `<@${target.id}>`;
  return interaction.reply(
    removed
      ? `🗑️ ${who} → SMITE profile unlinked.`
      : `${who} ${target.id === interaction.user.id ? "don't" : "doesn't"} have a linked profile.`
  );
}

async function execList(interaction) {
  const rows = listLinkedPlayers();
  const embed = new EmbedBuilder().setColor(SMITE_EMBED_COLOR).setTitle('⚔️ Linked SMITE profiles');
  if (rows.length === 0) {
    embed.setDescription('_Nobody has linked a profile yet — `/smite link` your in-game name._');
    return interaction.reply({ embeds: [embed] });
  }
  embed.setDescription(
    (
      await Promise.all(
        rows.map(async (r) => {
          const links = [];
          if (r.s2l_platform && r.s2l_id) {
            links.push(`[${r.s2l_name || 'smite2.live'}](${profileUrl(r.s2l_platform, r.s2l_id)})`);
          }
          if (r.player_uuid) links.push(`[SmiteSource](${playerPageUrl(r.player_uuid)})`);
          return `${await memberName(interaction.guild, r.user_id)} — ${links.join(' · ') || '_nothing linked_'}`;
        })
      )
    ).join('\n')
  );
  return interaction.reply({ embeds: [embed] });
}

/** Server display name, falling back to the cached username. */
async function memberName(guild, userId) {
  const member = await guild?.members.fetch(userId).catch(() => null);
  return member?.displayName || displayName(userId);
}

export default [smite];
