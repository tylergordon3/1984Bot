import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith('your-')) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

/** Whole number from the environment, bounded to [min, max]. */
function intInRange(name, fallback, min, max) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
  }
  return n;
}

/** Channel name or id, normalised for case-insensitive matching. */
function channelName(name, fallback) {
  return (process.env[name] || fallback).trim().replace(/^#/, '').toLowerCase();
}

/** Comma-separated list of channel names and/or ids; empty means "every channel". */
function channelList(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  // Which text channels to log messages from. Empty = all channels the bot can see.
  messageChannels: channelList('MESSAGE_CHANNELS'),
  // Reply when someone @s the bot.
  mentionReplies: process.env.MENTION_REPLIES !== 'false',
  // Request the (privileged) MessageContent intent. Set false if it isn't
  // enabled in the Developer Portal — logins are rejected outright otherwise.
  // Tag tracking works without it; word counts and keyword replies don't.
  messageContent: process.env.MESSAGE_CONTENT !== 'false',
  // Severe weather alerts (NWS). Feature is off unless at least one location
  // is set. Format: "Name|lat,lon|user,user" entries separated by ";". The
  // users are Discord names to ping (username, display name, or nickname).
  weatherLocations: (process.env.WEATHER_LOCATIONS || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, coords, users] = entry.split('|').map((s) => s.trim());
      const [lat, lon] = (coords || '').split(',').map((s) => s.trim());
      if (!name || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
        throw new Error(
          `Bad WEATHER_LOCATIONS entry "${entry}" — expected "Name|lat,lon|user,user".`
        );
      }
      return {
        name,
        lat,
        lon,
        users: (users || '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      };
    }),
  weatherChannel: (process.env.WEATHER_CHANNEL || 'gord-bot').replace(/^#/, '').toLowerCase(),
  // NWS event names that trigger a notification, lowercase for matching.
  // Warnings only by default — append "Severe Thunderstorm Watch,Tornado Watch"
  // to WEATHER_EVENTS to be pinged for watches too. This gates the *pings*
  // only: /weather map always draws every alert in effect, watches included.
  weatherEvents: new Set(
    (process.env.WEATHER_EVENTS || 'Severe Thunderstorm Warning,Tornado Warning')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
  // '', 'here', 'everyone', or a role id to ping with each alert.
  weatherMention: (process.env.WEATHER_MENTION || '').trim(),
  // Attach a map of the alert area (NWS polygons over OpenStreetMap tiles) to
  // each post. Set false to go back to text-only alerts.
  weatherMaps: process.env.WEATHER_MAPS !== 'false',
  // Overlay NEXRAD radar on those maps, so you see the storm and not just the
  // county it was warned for. Outside radar coverage the map is drawn without it.
  weatherRadar: process.env.WEATHER_RADAR !== 'false',
  // Master switch for the whole SMITE utility: the /smite command, the session
  // announcements and the match reports. Off unless explicitly enabled, so the
  // feature can sit dormant in the tree without registering commands or polling
  // smite2.live. Set SMITE_ENABLED=true to bring it back.
  smiteEnabled: process.env.SMITE_ENABLED === 'true',
  // Channel (name or id) the SMITE session posts go to.
  smiteChannel: (process.env.SMITE_CHANNEL || 'gord-bot').replace(/^#/, '').toLowerCase(),
  // Scheduled digest: the Ministry's daily (and weekly) report, posted from
  // the statistics already being collected. Fires at DIGEST_HOUR local time;
  // a restart never replays an edition, and quiet periods post nothing.
  digestEnabled: process.env.DIGEST_ENABLED !== 'false',
  digestChannel: channelName('DIGEST_CHANNEL', 'gord-bot'),
  // The weekly edition can go somewhere more public than the daily one.
  digestWeeklyChannel: channelName('DIGEST_WEEKLY_CHANNEL', process.env.DIGEST_CHANNEL || 'gord-bot'),
  digestHour: intInRange('DIGEST_HOUR', 9, 0, 23),
  digestDaily: process.env.DIGEST_DAILY !== 'false',
  digestWeekly: process.env.DIGEST_WEEKLY !== 'false',
  // Weekday the weekly edition goes out on: 0 = Sunday … 6 = Saturday.
  digestWeeklyDay: intInRange('DIGEST_WEEKLY_DAY', 0, 0, 6),
  // Missing persons: members unseen for this many days are named in the
  // report. 0 drops the section.
  digestMissingDays: intInRange('DIGEST_MISSING_DAYS', 7, 0, 3650),
  // Milestone announcements: thresholds crossed and records broken, posted as
  // they happen. Everything already achieved is recorded silently on first
  // run, so switching this on never dumps years of history into the channel.
  milestonesEnabled: process.env.MILESTONES_ENABLED !== 'false',
  milestoneChannel: channelName('MILESTONE_CHANNEL', process.env.DIGEST_CHANNEL || 'gord-bot'),
  databasePath: process.env.DATABASE_PATH || './data/1984bot.sqlite',
  logLevel: process.env.LOG_LEVEL || 'info',
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
};
