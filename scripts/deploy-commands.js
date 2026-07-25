import { REST, Routes } from 'discord.js';
import { config } from '../src/config.js';
import { commandData } from '../src/commands/index.js';

const rest = new REST({ version: '10' }).setToken(config.token);

try {
  console.log(`Registering ${commandData.length} guild commands to ${config.guildId}…`);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: commandData,
  });
  console.log('✅ Commands registered. They appear instantly in your server.');
} catch (err) {
  console.error('❌ Failed to register commands:', err);
  process.exit(1);
}
