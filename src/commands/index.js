import { Collection } from 'discord.js';
import music from './music.js';
import voice from './voice.js';
import games from './games.js';

const all = [...music, ...voice, ...games];

/** Collection keyed by command name, for dispatch at runtime. */
export const commands = new Collection(all.map((c) => [c.data.name, c]));

/** Array of JSON payloads, for registration with the Discord API. */
export const commandData = all.map((c) => c.data.toJSON());
