import { ChannelType, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { logger } from '../util/logger.js';
import { MINUTE, DAY } from '../util/time.js';
import { WEATHER_USER_AGENT } from './geocode.js';
import { listLocations, addLocation, subscribe, subscriberIds } from './store.js';

const POLL_INTERVAL = MINUTE;
const PRUNE_AFTER = 7 * DAY;

const EVENT_STYLE = {
  'Tornado Warning': { emoji: '🌪️', color: 0xe74c3c },
  'Tornado Watch': { emoji: '🌪️', color: 0xf1c40f },
  'Severe Thunderstorm Warning': { emoji: '⛈️', color: 0xe67e22 },
  'Severe Thunderstorm Watch': { emoji: '⛈️', color: 0xf1c40f },
};
const DEFAULT_STYLE = { emoji: '⚠️', color: 0x95a5a6 };

function alreadySent(alertId, location) {
  return !!getDb()
    .prepare('SELECT 1 FROM weather_alerts_sent WHERE alert_id = ? AND location = ?')
    .get(alertId, location);
}

function markSent(alertId, location, event) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO weather_alerts_sent (alert_id, location, event, sent_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(alertId, location, event, Date.now());
}

function pruneSent() {
  getDb()
    .prepare('DELETE FROM weather_alerts_sent WHERE sent_at < ?')
    .run(Date.now() - PRUNE_AFTER);
}

/** The text channel alerts go to, matched by id or by name (case-insensitive). */
function findAlertChannel(guild) {
  const target = config.weatherChannel;
  return guild.channels.cache.find(
    (ch) =>
      (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) &&
      (ch.id === target || ch.name.toLowerCase() === target)
  );
}

/** Case-insensitive member lookup by username, global name, or nickname. */
function findMemberByName(guild, name) {
  return guild.members.cache.find(
    (m) =>
      m.user.username?.toLowerCase() === name ||
      m.user.globalName?.toLowerCase() === name ||
      m.displayName?.toLowerCase() === name
  );
}

/**
 * One-time import of the legacy WEATHER_LOCATIONS .env format into the
 * database, resolving each configured name to a member id. Runs only while
 * the locations table is empty, so /weather edits are never overwritten.
 */
function seedFromEnv(guild) {
  if (config.weatherLocations.length === 0 || listLocations().length > 0) return;
  for (const loc of config.weatherLocations) {
    addLocation(loc.name, loc.lat, loc.lon, 'env');
    for (const name of loc.users) {
      const member = findMemberByName(guild, name);
      if (member) subscribe(loc.name, member.id);
      else logger.warn(`Weather: no guild member matches "${name}" (seeding ${loc.name}).`);
    }
  }
  logger.info(`Weather: seeded ${config.weatherLocations.length} locations from .env.`);
}

function truncate(text, max) {
  if (!text) return null;
  const oneLine = text.replace(/\n{2,}/g, '\n').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function buildEmbed(props, location) {
  const style = EVENT_STYLE[props.event] || DEFAULT_STYLE;
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.emoji} ${props.event} — ${location.name}`)
    .setDescription(truncate(props.headline || props.description, 500))
    .setFooter({ text: `Source: NWS ${props.senderName || 'National Weather Service'}` })
    .setTimestamp(new Date(props.sent || Date.now()));

  if (props.areaDesc) {
    embed.addFields({ name: 'Area', value: truncate(props.areaDesc, 1024), inline: false });
  }
  const until = props.expires || props.ends;
  if (until) {
    const unix = Math.floor(new Date(until).getTime() / 1000);
    embed.addFields({ name: 'In effect until', value: `<t:${unix}:f> (<t:${unix}:R>)`, inline: false });
  }
  if (props.instruction) {
    embed.addFields({ name: 'Instructions', value: truncate(props.instruction, 1024), inline: false });
  }
  return embed;
}

/** "here" / "everyone" / a role id → the string that pings it. */
function globalMention() {
  const m = config.weatherMention;
  if (!m) return null;
  if (m === 'here' || m === '@here') return '@here';
  if (m === 'everyone' || m === '@everyone') return '@everyone';
  return `<@&${m.replace(/[^0-9]/g, '')}>`;
}

async function fetchActiveAlerts(location) {
  const url =
    `https://api.weather.gov/alerts/active` +
    `?point=${location.lat},${location.lon}&status=actual&message_type=alert,update`;
  const res = await fetch(url, {
    headers: { 'User-Agent': WEATHER_USER_AGENT, Accept: 'application/geo+json' },
  });
  if (!res.ok) throw new Error(`NWS API returned ${res.status}`);
  const body = await res.json();
  return body.features || [];
}

async function pollLocation(channel, location) {
  const features = await fetchActiveAlerts(location);
  const now = Date.now();

  for (const feature of features) {
    const props = feature.properties || {};
    if (!config.weatherEvents.has(props.event?.toLowerCase())) continue;
    const expires = props.expires || props.ends;
    if (expires && new Date(expires).getTime() < now) continue;
    if (alreadySent(feature.id, location.name)) continue;

    // Mark before sending so a Discord hiccup can't cause a double-post storm.
    markSent(feature.id, location.name, props.event);
    const pings = subscriberIds(location.name).map((id) => `<@${id}>`);
    const content = [globalMention(), ...pings].filter(Boolean).join(' ') || undefined;
    await channel.send({ content, embeds: [buildEmbed(props, location)] });
    logger.info(`👁️ weather alert posted: ${props.event} @ ${location.name}`);
  }
}

async function poll(client) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  const locations = listLocations();
  if (locations.length === 0) return;
  const channel = findAlertChannel(guild);
  if (!channel) {
    logger.warn(`Weather: channel "${config.weatherChannel}" not found in guild.`);
    return;
  }
  // One location's bad day (or NWS region outage) must not silence the others,
  // so poll them all and report any failures together afterwards.
  const errors = [];
  for (const location of locations) {
    try {
      await pollLocation(channel, location);
    } catch (err) {
      errors.push(`${location.name}: ${err.message}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join(' | '));
}

/**
 * Start polling the NWS alerts API for every watched location (managed via
 * /weather, stored in SQLite) and posting new warnings to the alert channel,
 * pinging that location's subscribers. Alerts already posted are remembered,
 * so restarts and NWS re-issues don't repost.
 */
export function startWeatherWatcher(client) {
  const guild = client.guilds.cache.get(config.guildId);
  if (guild) seedFromEnv(guild);

  const where = listLocations().map((l) => l.name).join(', ') || 'no locations yet (/weather add)';
  logger.info(
    `Weather alerts → #${config.weatherChannel} | watching: ${where} | ` +
      `events: ${[...config.weatherEvents].join(', ')}`
  );

  let failures = 0;
  const timer = setInterval(async () => {
    try {
      await poll(client);
      pruneSent();
      failures = 0;
    } catch (err) {
      // Log the first failure and then every 10th, so a long NWS outage
      // doesn't flood the journal.
      if (failures % 10 === 0) logger.warn(`Weather poll failed: ${err.message}`);
      failures += 1;
    }
  }, POLL_INTERVAL);

  // One immediate check so an in-progress warning isn't missed for a minute.
  poll(client).catch((err) => logger.warn(`Weather poll failed: ${err.message}`));

  return () => clearInterval(timer);
}
