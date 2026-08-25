import { ChannelType } from 'discord.js';

/** Text/announcement channel matched by id or by name (case-insensitive). */
export function findTextChannel(guild, target) {
  return guild.channels.cache.find(
    (ch) =>
      (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) &&
      (ch.id === target || ch.name.toLowerCase() === target)
  );
}
