import { ActivityType, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import { rememberUser, logName } from '../db/database.js';
import { MINUTE } from '../util/time.js';
import { findTextChannel } from '../util/channels.js';
import { findGodIn, godDisplayName, godPageUrl } from './gods.js';
import { extractPlayerUuid, getPlayer, matchPageUrl } from './store.js';
import { fetchStatCard } from './smite2live.js';
import { autoLinkSmite2Live } from './autolink.js';
import { SMITE_EMBED_COLOR, addStatFields, profileLinks } from './embeds.js';

// A relaunch (crash, queue-dodge restart) inside this window doesn't re-announce.
const RELAUNCH_COOLDOWN = 30 * MINUTE;

const SMITE_NAMES = new Set(['smite', 'smite 2']);

// userId → { god, matchId, raw } for users currently in a SMITE session.
const sessions = new Map();
// userId → last "started playing" announcement, surviving session end.
const lastStartPost = new Map();

function smiteActivity(presence) {
  if (!presence) return null;
  return (
    presence.activities.find(
      (a) => a.type === ActivityType.Playing && SMITE_NAMES.has(a.name?.trim().toLowerCase())
    ) || null
  );
}

/** The rich-presence fields that might name the god / mode / match. */
function presenceFields(activity) {
  return {
    details: activity.details || null,
    state: activity.state || null,
    largeText: activity.assets?.largeText || null,
    smallText: activity.assets?.smallText || null,
    partyId: activity.party?.id || null,
  };
}

function buildEmbed(member, activity, { god, matchId }, player, card) {
  const f = presenceFields(activity);
  const statusLine = [f.details, f.state].filter(Boolean).join(' — ');
  const fallback = player
    ? null
    : '_No linked profile — `/smite link` your in-game name to add your stats._';
  const embed = new EmbedBuilder()
    .setColor(SMITE_EMBED_COLOR)
    .setTitle(`⚔️ ${member.displayName} is playing ${activity.name}`)
    .setFooter({ text: card ? 'Stats: smite2.live' : 'SmiteSource' });

  if (statusLine || fallback) embed.setDescription(statusLine || fallback);
  if (activity.timestamps?.start) embed.setTimestamp(activity.timestamps.start);
  if (god) {
    embed.addFields({
      name: 'God',
      value: `[${godDisplayName(god)} — builds & guide](${godPageUrl(god)})`,
      inline: true,
    });
  }
  if (matchId) {
    embed.addFields({ name: 'Live match', value: matchPageUrl(matchId), inline: true });
  }
  if (card) addStatFields(embed, card);
  const links = profileLinks(player);
  if (links) embed.addFields({ name: 'Profiles', value: links, inline: false });
  return embed;
}

async function announce(guild, member, activity, info, reason) {
  const channel = findTextChannel(guild, config.smiteChannel);
  if (!channel) {
    logger.warn(`SMITE: channel "${config.smiteChannel}" not found in guild.`);
    return;
  }
  let player = getPlayer(member.id);
  if (!player?.s2l_platform) {
    // Unlinked player: maybe one of their Discord names IS their in-game name.
    player =
      (await autoLinkSmite2Live(member.id, [
        member.nickname,
        member.user?.globalName,
        member.user?.username,
      ]).catch(() => null)) || player;
  }
  const card =
    player?.s2l_platform && player?.s2l_id
      ? await fetchStatCard(player.s2l_platform, player.s2l_id)
      : null;

  await channel.send({
    // The best SmiteSource link goes in the body bare, so Discord unfurls
    // the site's own preview card on top of our stats embed.
    content: (info.matchId && matchPageUrl(info.matchId)) || (info.god && godPageUrl(info.god)) || undefined,
    embeds: [buildEmbed(member, activity, info, player, card)],
  });
  logger.info(
    `👁️ SMITE post (${reason}): ${logName(member.id)}` +
      `${info.god ? ` as ${godDisplayName(info.god)}` : ''}${info.matchId ? ` match ${info.matchId}` : ''}` +
      `${card ? ' +stats' : ''}`
  );
}

/**
 * discord.js presenceUpdate handler. Announces when a member starts a SMITE
 * session, and again when their god or live match first becomes visible (or
 * changes) in rich presence.
 */
export function handleSmitePresence(oldPresence, newPresence) {
  if (!newPresence) return;
  const guild = newPresence.guild;
  const userId = newPresence.userId || newPresence.member?.id;
  const user = newPresence.user || newPresence.member?.user;
  if (!guild || !userId || user?.bot) return;

  const activity = smiteActivity(newPresence);
  if (!activity) {
    if (sessions.delete(userId)) logger.debug(`SMITE session over: ${logName(userId)}`);
    return;
  }

  const member = newPresence.member;
  if (!member) return;
  rememberUser(userId, user?.username || userId);

  const fields = presenceFields(activity);
  // SMITE 2's rich presence format is undocumented — keep the raw fields in
  // the journal so the god/match extraction below can be tuned against them.
  const raw = JSON.stringify(fields);
  const existing = sessions.get(userId);
  if (!existing || existing.raw !== raw) {
    logger.info(`SMITE presence for ${logName(userId)}: ${raw}`);
  }

  const god =
    findGodIn([fields.details, fields.state, fields.largeText, fields.smallText]) ||
    existing?.god ||
    null;
  const matchId = extractPlayerUuid(fields.partyId) || existing?.matchId || null;
  const info = { god, matchId, raw };
  sessions.set(userId, info);

  const run = (reason) =>
    announce(guild, member, activity, info, reason).catch((err) =>
      logger.warn(`SMITE announce failed: ${err.message}`)
    );

  if (!existing) {
    const last = lastStartPost.get(userId) || 0;
    if (Date.now() - last < RELAUNCH_COOLDOWN) return;
    lastStartPost.set(userId, Date.now());
    run('session start');
  } else if ((god && god !== existing.god) || (matchId && matchId !== existing.matchId)) {
    run(god !== existing.god ? 'god detected' : 'match detected');
  }
}

/**
 * Mark everyone already mid-SMITE at boot as known, so a bot restart doesn't
 * re-announce sessions that were running the whole time.
 */
export function seedSmiteSessions(guild) {
  for (const presence of guild.presences.cache.values()) {
    const activity = smiteActivity(presence);
    const userId = presence.userId || presence.member?.id;
    if (!activity || !userId) continue;
    const fields = presenceFields(activity);
    const raw = JSON.stringify(fields);
    logger.info(`SMITE presence for ${logName(userId)}: ${raw}`);
    sessions.set(userId, {
      god: findGodIn([fields.details, fields.state, fields.largeText, fields.smallText]),
      matchId: extractPlayerUuid(fields.partyId),
      raw,
    });
    lastStartPost.set(userId, Date.now());
  }
  if (sessions.size > 0) logger.info(`SMITE: ${sessions.size} member(s) already in game at boot.`);
}
