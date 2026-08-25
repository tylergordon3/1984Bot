import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { rememberUser, displayName } from '../db/database.js';
import {
  extractPlayerUuid,
  linkPlayer,
  unlinkPlayer,
  playerPageUrl,
  listLinkedPlayers,
} from '../smite/store.js';

const EMBED_COLOR = 0xc9a227;

const smite = {
  data: new SlashCommandBuilder()
    .setName('smite')
    .setDescription('SMITE 2 session announcements and SmiteSource profile links')
    .addSubcommand((sub) =>
      sub
        .setName('link')
        .setDescription('Link a SmiteSource tracker profile (find yours at smitesource.com/tracker)')
        .addStringOption((o) =>
          o
            .setName('profile')
            .setDescription('Your smitesource.com/player/... URL (or just the UUID from it)')
            .setRequired(true)
        )
        .addUserOption((o) =>
          o.setName('user').setDescription('Link someone else (defaults to you)')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('unlink')
        .setDescription('Remove a linked SmiteSource profile')
        .addUserOption((o) =>
          o.setName('user').setDescription('Unlink someone else (defaults to you)')
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Show all linked SmiteSource profiles')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'link') return execLink(interaction);
    if (sub === 'unlink') return execUnlink(interaction);
    return execList(interaction);
  },
};

async function execLink(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const uuid = extractPlayerUuid(interaction.options.getString('profile'));
  if (!uuid) {
    return interaction.reply({
      content:
        "That doesn't look like a SmiteSource profile. Search yourself at " +
        '<https://smitesource.com/tracker>, open your profile, and paste its ' +
        '`smitesource.com/player/...` URL here.',
      ephemeral: true,
    });
  }
  rememberUser(target.id, target.username);
  linkPlayer(target.id, uuid);
  const who = target.id === interaction.user.id ? 'You' : `<@${target.id}>`;
  return interaction.reply(
    `👁️ ${who} → linked to <${playerPageUrl(uuid)}>. SMITE session posts will now include this profile.`
  );
}

async function execUnlink(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const removed = unlinkPlayer(target.id);
  const who = target.id === interaction.user.id ? 'You' : `<@${target.id}>`;
  return interaction.reply(
    removed
      ? `🗑️ ${who} → SmiteSource profile unlinked.`
      : `${who} ${target.id === interaction.user.id ? "don't" : "doesn't"} have a linked profile.`
  );
}

async function execList(interaction) {
  const rows = listLinkedPlayers();
  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle('⚔️ Linked SmiteSource profiles');
  if (rows.length === 0) {
    embed.setDescription('_Nobody has linked a profile yet — `/smite link` your tracker URL._');
  } else {
    embed.setDescription(
      rows.map((r) => `${displayName(r.user_id)} — ${playerPageUrl(r.player_uuid)}`).join('\n')
    );
  }
  return interaction.reply({ embeds: [embed] });
}

export default [smite];
