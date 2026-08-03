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
import { handleMessageCreate, catchUpMessages } from './tracking/messageTracker.js';
import { handleBotMention } from './messages/responder.js';
import { destroyAllPlayers } from './music/player.js';

initDatabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // voice join/leave tracking
    GatewayIntentBits.GuildPresences, // game / activity tracking  (privileged)
    GatewayIntentBits.GuildMembers, // member objects on presence  (privileged)
    GatewayIntentBits.GuildMessages, // message + tag tracking, @-mention replies
    // Message text, for word counts and keyword replies (privileged). Opt-out
    // via MESSAGE_CONTENT=false so the bot still boots without the portal toggle.
    ...(config.messageContent ? [GatewayIntentBits.MessageContent] : []),
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
  await catchUpMessages(guild).catch((err) => logger.warn(`Message catch-up failed: ${err.message}`));
  logger.info('1984Bot is watching. 👁️');
});

client.on(Events.MessageCreate, (message) => {
  try {
    handleMessageCreate(message);
    if (config.mentionReplies) handleBotMention(message, client);
  } catch (err) {
    logger.error('messageCreate error:', err);
  }
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

client.login(config.token).catch((err) => {
  if (/disallowed intents/i.test(err.message)) {
    logger.error(
      'Login rejected: a privileged intent is not enabled. Turn on Presence, ' +
        'Server Members and Message Content in the Discord Developer Portal ' +
        '(Bot tab), or set MESSAGE_CONTENT=false in .env to run without message text.'
    );
  } else {
    logger.error('Login failed:', err);
  }
  process.exit(1);
});
