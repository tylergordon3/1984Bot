import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from './config.js';
import { logger } from './util/logger.js';
import { initDatabase, closeDatabase } from './db/database.js';
import { commands } from './commands/index.js';
import {
  handleVoiceStateUpdate,
  reconcileVoice,
  startVoiceHeartbeat,
  closeAllOpenVoiceSessions,
} from './tracking/voiceTracker.js';
import {
  handlePresenceUpdate,
  reconcileGames,
  startGameHeartbeat,
  closeAllOpenGameSessions,
} from './tracking/gameTracker.js';
import { destroyAllPlayers } from './music/player.js';

initDatabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // voice join/leave tracking
    GatewayIntentBits.GuildPresences, // game / activity tracking  (privileged)
    GatewayIntentBits.GuildMembers, // member objects on presence  (privileged)
  ],
});

const stopHeartbeats = [];

client.once(Events.ClientReady, async (c) => {
  logger.info(`Logged in as ${c.user.tag}`);

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    logger.error(`Bot is not in guild ${config.guildId}. Invite it, then restart.`);
    return;
  }

  // Populate member + presence caches so reconciliation sees everyone online.
  try {
    await guild.members.fetch({ withPresences: true });
  } catch (err) {
    logger.warn(`Could not fetch members with presences: ${err.message}`);
  }

  reconcileVoice(guild);
  reconcileGames(guild);
  stopHeartbeats.push(startVoiceHeartbeat(client), startGameHeartbeat(client));
  logger.info('1984Bot is watching. 👁️');
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    handleVoiceStateUpdate(oldState, newState);
  } catch (err) {
    logger.error('voiceStateUpdate error:', err);
  }
});

client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
  try {
    handlePresenceUpdate(oldPresence, newPresence);
  } catch (err) {
    logger.error('presenceUpdate error:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error(`Command /${interaction.commandName} failed:`, err);
    const msg = { content: '⚠️ Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      interaction.editReply(msg).catch(() => {});
    } else {
      interaction.reply(msg).catch(() => {});
    }
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down…`);
  for (const stop of stopHeartbeats) stop();
  closeAllOpenVoiceSessions();
  closeAllOpenGameSessions();
  destroyAllPlayers();
  closeDatabase();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection:', reason));

client.login(config.token);
