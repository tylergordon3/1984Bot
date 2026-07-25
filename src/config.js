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

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  databasePath: process.env.DATABASE_PATH || './data/1984bot.sqlite',
  logLevel: process.env.LOG_LEVEL || 'info',
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
};
