import { ActivityType, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import { rememberUser, logName } from '../db/database.js';
import { MINUTE } from '../util/time.js';
import { findTextChannel } from '../util/channels.js';
import { findGodIn, godDisplayName, godPageUrl } from './gods.js';
import { extractPlayerUuid, playerUuid, playerPageUrl, matchPageUrl } from './store.js';

const EMBED_COLOR = 0xc9a227; // SMITE gold
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

function buildEmbed(member, activity, { god, matchId }) {
  const f = presenceFields(activity);
  const profileUuid = playerUuid(member.id);
  // SMITE 2 sets no rich-presence details (observed live: every field null),
  // so when there's no status line the tracker profile is the route to the
  // match they're in.
  const statusLine = [f.details, f.state].filter(Boolean).join(' — ');
  const fallback = profileUuid
    ? 'Their live match shows up on their SmiteSource profile below.'
    : '_No linked SmiteSource profile — `/smite link` adds their live match tracker._';
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`⚔️ ${member.displayName} is playing ${activity.name}`)
    .setDescription(statusLine || fallback)
    .setFooter({ text: 'SmiteSource' });

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
  if (profileUuid) {
    embed.addFields({
      name: 'Profile',
      value: `[SmiteSource tracker](${playerPageUrl(profileUuid)})`,
      inline: true,
    });
  }
  return embed;
}

async function announce(guild, member, activity, info, reason) {
  const channel = findTextChannel(guild, config.smiteChannel);
  if (!channel) {
    logger.warn(`SMITE: channel "${config.smiteChannel}" not found in guild.`);
    return;
  }
  // The best link goes in the message body bare, so Discord unfurls
  // SmiteSource's own preview card (match beats god build beats profile).
  const profile = playerUuid(member.id);
  const bestUrl =
    (info.matchId && matchPageUrl(info.matchId)) ||
    (info.god && godPageUrl(info.god)) ||
    (profile && playerPageUrl(profile)) ||
    null;

  await channel.send({
    content: bestUrl || undefined,
    embeds: [buildEmbed(member, activity, info)],
  });
  logger.info(
    `👁️ SMITE post (${reason}): ${logName(member.id)}` +
      `${info.god ? ` as ${godDisplayName(info.god)}` : ''}${info.matchId ? ` match ${info.matchId}` : ''}`
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
