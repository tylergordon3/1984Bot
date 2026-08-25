import { EmbedBuilder } from 'discord.js';
import { playerPageUrl } from './store.js';
import { profileUrl } from './smite2live.js';

export const SMITE_EMBED_COLOR = 0xc9a227; // SMITE gold

const ROLE_NAMES = {
  ECarry: 'Carry',
  EMid: 'Mid',
  ESolo: 'Solo',
  EJungle: 'Jungle',
  ESupport: 'Support',
};

export const roleName = (role) => ROLE_NAMES[role] || role || '?';

/** "conquest-ranked" → "Ranked Conquest", "arena" → "Arena". */
export function modeName(mode) {
  const words = String(mode || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return words.reverse().join(' ') || 'Unknown mode';
}

const num = (s) => Number(String(s).replace(/[^0-9.]/g, '')).toLocaleString('en-US');

/**
 * Add rank / record / recent-form / top-gods fields from a smite2.live stat
 * card (fetchStatCard result) onto an embed. Skips whatever is missing.
 */
export function addStatFields(embed, card) {
  if (card.tier || card.mmr) {
    embed.addFields({
      name: 'Rank',
      value: [card.tier, card.mmr && `${num(card.mmr)} MMR`].filter(Boolean).join(' · '),
      inline: true,
    });
  }
  const wr = card.stats?.['Win Rate'];
  const kda = card.stats?.KDA;
  const matches = card.stats?.Matches;
  if (wr || kda || matches) {
    embed.addFields({
      name: 'Ranked Conquest',
      value: [
        wr && `${wr.value} WR${wr.sub ? ` (${wr.sub})` : ''}`,
        kda && `${kda.value} KDA`,
        matches && `${num(matches.value)} matches`,
      ]
        .filter(Boolean)
        .join(' · '),
      inline: true,
    });
  }
  if (card.recentWr) {
    embed.addFields({
      name: 'Recent form',
      value: `${card.recentWr} WR last 25${card.streak ? ` · on a ${card.streak} streak` : ''}`,
      inline: true,
    });
  }
  if (card.topGods?.length) {
    embed.addFields({
      name: 'Top gods',
      value: card.topGods
        .map(
          (g) =>
            `**${g.name}** — ${g.winRate.toFixed(0)}% WR, ${g.kda.toFixed(2)} KDA` +
            `${g.grade ? ` (${g.grade})` : ''} over ${g.matches} matches`
        )
        .join('\n'),
      inline: false,
    });
  }
}

/** Profile-links field: smite2.live tracker and/or SmiteSource. */
export function profileLinks(player) {
  const links = [];
  if (player?.s2l_platform && player?.s2l_id) {
    links.push(`[smite2.live](${profileUrl(player.s2l_platform, player.s2l_id)})`);
  }
  if (player?.player_uuid) {
    links.push(`[SmiteSource](${playerPageUrl(player.player_uuid)})`);
  }
  return links.join(' · ') || null;
}

/** Standalone stat card, for /smite stats. */
export function statCardEmbed(displayName, card, player) {
  const embed = new EmbedBuilder()
    .setColor(SMITE_EMBED_COLOR)
    .setTitle(`⚔️ ${card.name || displayName} — SMITE 2`)
    .setFooter({ text: 'Stats: smite2.live' });
  addStatFields(embed, card);
  const links = profileLinks(player);
  if (links) embed.addFields({ name: 'Profiles', value: links, inline: false });
  return embed;
}
