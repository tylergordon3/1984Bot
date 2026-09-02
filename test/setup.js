// Loaded before any test file via `node --import`. The config module reads
// the environment at import time, so this is where tests get a fake identity
// and, above all, an in-memory database: nothing here may touch the real
// SQLite file, whatever .env or the deploy secrets say.
process.env.DISCORD_TOKEN = 'test-token';
process.env.CLIENT_ID = 'test-client';
process.env.GUILD_ID = 'guild';
process.env.DATABASE_PATH = ':memory:';
process.env.MESSAGE_CHANNELS = '';
process.env.LOG_LEVEL = 'error';
process.env.DIGEST_MISSING_DAYS = '7';
process.env.DIGEST_CHANNEL = 'bot-room';
process.env.DIGEST_WEEKLY_CHANNEL = 'town-square';
process.env.WEATHER_LOCATIONS = '';
