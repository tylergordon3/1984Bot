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
  databasePath: process.env.DATABASE_PATH || './data/1984bot.sqlite',
  logLevel: process.env.LOG_LEVEL || 'info',
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
};
