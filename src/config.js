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
  // NWS event names to post, lowercase for matching.
  weatherEvents: new Set(
    (process.env.WEATHER_EVENTS || 'Severe Thunderstorm Warning,Tornado Warning')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
  // '', 'here', 'everyone', or a role id to ping with each alert.
  weatherMention: (process.env.WEATHER_MENTION || '').trim(),
  // Announce SMITE 2 sessions (with SmiteSource links) as members start playing.
  smiteWatch: process.env.SMITE_WATCH !== 'false',
  // Channel (name or id) the SMITE session posts go to.
  smiteChannel: (process.env.SMITE_CHANNEL || 'gord-bot').replace(/^#/, '').toLowerCase(),
  databasePath: process.env.DATABASE_PATH || './data/1984bot.sqlite',
  logLevel: process.env.LOG_LEVEL || 'info',
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
};
