import { Collection } from 'discord.js';
import { config } from '../config.js';
import music from './music.js';
import voice from './voice.js';
import games from './games.js';
import messages from './messages.js';
import weather from './weather.js';
import digest from './digest.js';
import smite from './smite.js';

// /smite is registered only while the utility is switched on; deploying
// commands with it off removes it from the server's command list.
const all = [
  ...music,
  ...voice,
  ...games,
  ...messages,
  ...weather,
  ...digest,
  ...(config.smiteEnabled ? smite : []),
];

/** Collection keyed by command name, for dispatch at runtime. */
export const commands = new Collection(all.map((c) => [c.data.name, c]));

/** Array of JSON payloads, for registration with the Discord API. */
export const commandData = all.map((c) => c.data.toJSON());
