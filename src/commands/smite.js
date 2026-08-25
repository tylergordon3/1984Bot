import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { rememberUser, displayName } from '../db/database.js';
import {
  extractPlayerUuid,
  linkSmiteSource,
  addAccount,
  removeAccount,
  unlinkPlayer,
  getPlayer,
  accountsFor,
  resolvedAccounts,
  pendingAccounts,
  playerPageUrl,
  listLinkedUsers,
} from '../smite/store.js';
import { resolveProfile, fetchOverview, fetchStatCard, profileUrl } from '../smite/smite2live.js';
import { autoResolveAccounts } from '../smite/autolink.js';
import { SMITE_EMBED_COLOR, statCardEmbed, profileLinks } from '../smite/embeds.js';

const smite = {
  data: new SlashCommandBuilder()
    .setName('smite')
    .setDescription('SMITE 2 session announcements, stats, and profile links')
    .addSubcommand((sub) =>
      sub
        .setName('link')
        .setDescription('Link a SMITE 2 account (members can have several)')
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
        .setDescription('Show SMITE 2 stat cards for a member or any player name')
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
        .setDescription('Remove one linked account, or everything')
        .addUserOption((o) =>
          o.setName('user').setDescription('Unlink someone else (defaults to you)')
        )
        .addStringOption((o) =>
          o.setName('name').setDescription('In-game name of one account to remove (default: everything)')
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
  // anything else — an in-game name or smite2.live URL — adds an account.
  const smitesourceUuid =
    /smitesource\.com/.test(query) || /^[0-9a-f-]{36}$/i.test(query)
      ? extractPlayerUuid(query)
      : null;
  if (smitesourceUuid) {
    linkSmiteSource(target.id, smitesourceUuid);
    return interaction.reply(
      `👁️ ${who} → SmiteSource profile linked: <${playerPageUrl(smitesourceUuid)}>. ` +
        'Also `/smite link` in-game names to add smite2.live stats.'
    );
  }

  await interaction.deferReply();
  const resolved = await resolveProfile(query).catch(() => null);
  if (!resolved) {
    // smite2.live only indexes players it has already seen in matches, so a
    // real name can still miss. Keep it and retry until the site catches up.
    addAccount(target.id, { name: query });
    return interaction.editReply(
      `👁️ Saved account **${query}** for ${who === 'You' ? 'you' : who}. smite2.live doesn't ` +
        "track this player yet (it only knows players it has seen in matches) — I'll keep " +
        'checking and stats will appear automatically once they do.'
    );
  }
  const overview = await fetchOverview(resolved.platform, resolved.id).catch(() => null);
  addAccount(target.id, {
    name: overview?.name ?? query,
    platform: resolved.platform,
    id: resolved.id,
    profileId: overview?.profileId ?? null,
  });
  const count = accountsFor(target.id).length;
  return interaction.editReply(
    `👁️ ${who} → linked account **${overview?.name || query}** ` +
      `(<${profileUrl(resolved.platform, resolved.id)}>)` +
      `${count > 1 ? ` — that's ${count} accounts now` : ''}. Session posts carry ` +
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
      embeds: [statCardEmbed(name, card, `[smite2.live](${profileUrl(resolved.platform, resolved.id)})`)],
    });
  }

  const target = interaction.options.getUser('user') || interaction.user;
  const before = resolvedAccounts(target.id).length;
  const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
  const accounts = await autoResolveAccounts(
    target.id,
    [member?.nickname, target.globalName, target.username],
    { force: true }
  ).catch(() => resolvedAccounts(target.id));

  if (accounts.length === 0) {
    const pending = pendingAccounts(target.id).map((a) => `**${a.s2l_name}**`);
    return interaction.editReply(
      pending.length
        ? `smite2.live still doesn't track ${pending.join(' / ')} — stats appear once they've ` +
            'been seen in a tracked match. No action needed; I keep checking.'
        : `Couldn't find <@${target.id}> on smite2.live — none of their Discord names match an ` +
            'in-game name. They can `/smite link` their exact SMITE 2 name (or you can run ' +
            '`/smite link profile:<name> user:@them`), or use `/smite stats name:<in-game name>` ' +
            'for a one-off lookup.'
    );
  }

  const player = getPlayer(target.id);
  const shown = accounts.slice(0, 4);
  const embeds = [];
  for (const account of shown) {
    const card = await fetchStatCard(account.s2l_platform, account.s2l_id);
    if (card) {
      embeds.push(
        statCardEmbed(member?.displayName || displayName(target.id), card, profileLinks(player, [account]))
      );
    }
  }
  if (embeds.length === 0) {
    return interaction.editReply('smite2.live is not answering right now — try again in a bit.');
  }
  const newlyLinked = accounts.length > before && before === 0;
  return interaction.editReply({
    content: newlyLinked
      ? `🔗 Auto-matched to **${accounts[0].s2l_name || '?'}** by Discord name and linked — \`/smite unlink\` if that's not them.`
      : undefined,
    embeds,
  });
}

async function execUnlink(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const name = interaction.options.getString('name')?.trim();
  const who = target.id === interaction.user.id ? 'You' : `<@${target.id}>`;
  if (name) {
    const removed = removeAccount(target.id, name);
    return interaction.reply(
      removed
        ? `🗑️ ${who} → account **${name}** removed.`
        : `${who} ${target.id === interaction.user.id ? "don't" : "doesn't"} have an account named **${name}**.`
    );
  }
  const removed = unlinkPlayer(target.id);
  return interaction.reply(
    removed
      ? `🗑️ ${who} → all SMITE links removed.`
      : `${who} ${target.id === interaction.user.id ? "don't" : "doesn't"} have anything linked.`
  );
}

async function execList(interaction) {
  const userIds = listLinkedUsers();
  const embed = new EmbedBuilder().setColor(SMITE_EMBED_COLOR).setTitle('⚔️ Linked SMITE profiles');
  if (userIds.length === 0) {
    embed.setDescription('_Nobody has linked a profile yet — `/smite link` your in-game name._');
    return interaction.reply({ embeds: [embed] });
  }
  embed.setDescription(
    (
      await Promise.all(
        userIds.map(async (userId) => {
          const player = getPlayer(userId);
          const parts = [];
          for (const a of accountsFor(userId)) {
            if (a.s2l_platform && a.s2l_id) {
              parts.push(`[${a.s2l_name || 'smite2.live'}](${profileUrl(a.s2l_platform, a.s2l_id)})`);
            } else if (a.s2l_name) {
              parts.push(`⏳ ${a.s2l_name}`);
            }
          }
          if (player?.player_uuid) parts.push(`[SmiteSource](${playerPageUrl(player.player_uuid)})`);
          return `${await memberName(interaction.guild, userId)} — ${parts.join(' · ') || '_nothing linked_'}`;
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
