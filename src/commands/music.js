import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getPlayer } from '../music/player.js';
import { resolveQuery } from '../music/sources.js';
import { formatDuration } from '../util/time.js';

function memberVoiceChannel(interaction) {
  return interaction.member?.voice?.channel || null;
}

const play = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube/Spotify link or search term in your voice channel')
    .addStringOption((o) =>
      o.setName('query').setDescription('URL or search text').setRequired(true)
    ),
  async execute(interaction) {
    const channel = memberVoiceChannel(interaction);
    if (!channel) {
      return interaction.reply({ content: '❌ Join a voice channel first.', ephemeral: true });
    }
    await interaction.deferReply();
    const query = interaction.options.getString('query');

    let tracks;
    try {
      tracks = await resolveQuery(query);
    } catch (err) {
      return interaction.editReply(`⚠️ Couldn't resolve that: ${err.message}`);
    }
    if (!tracks || tracks.length === 0) {
      return interaction.editReply('⚠️ Nothing found.');
    }

    const player = getPlayer(interaction.guild, true);
    player.textChannel = interaction.channel;
    if (!player.connected) player.connect(channel);
    player.enqueue(tracks, interaction.user.tag);
    await player.start();

    if (tracks.length === 1) {
      await interaction.editReply(`➕ Queued **${tracks[0].title}**`);
    } else {
      await interaction.editReply(`➕ Queued **${tracks.length}** tracks.`);
    }
  },
};

const skip = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player || !player.current) {
      return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    }
    const skipped = player.skip();
    await interaction.reply(`⏭️ Skipped **${skipped?.title ?? 'track'}**.`);
  },
};

const stop = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue'),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    player.stop();
    await interaction.reply('⏹️ Stopped and cleared the queue.');
  },
};

const pause = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player || !player.current) {
      return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    }
    player.pause();
    await interaction.reply('⏸️ Paused.');
  },
};

const resume = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player) return interaction.reply({ content: 'Nothing to resume.', ephemeral: true });
    player.resume();
    await interaction.reply('▶️ Resumed.');
  },
};

const queue = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player || (!player.current && player.queue.length === 0)) {
      return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
    }
    const embed = new EmbedBuilder().setTitle('🎶 Queue').setColor(0xcc0000);
    if (player.current) {
      embed.setDescription(`**Now playing:** ${player.current.title}`);
    }
    const upcoming = player.queue
      .slice(0, 10)
      .map((t, i) => `\`${i + 1}.\` ${t.title} (${formatDuration(t.durationMs)})`)
      .join('\n');
    if (upcoming) {
      embed.addFields({
        name: `Up next (${player.queue.length} total)`,
        value: upcoming,
      });
    }
    await interaction.reply({ embeds: [embed] });
  },
};

const nowplaying = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current track'),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player || !player.current) {
      return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    }
    await interaction.reply(
      `▶️ **${player.current.title}** (${formatDuration(player.current.durationMs)}) — requested by ${player.current.requestedBy}`
    );
  },
};

const volume = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume (0–200%)')
    .addIntegerOption((o) =>
      o.setName('percent').setDescription('0–200').setMinValue(0).setMaxValue(200).setRequired(true)
    ),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    const percent = interaction.options.getInteger('percent');
    player.setVolume(percent / 100);
    await interaction.reply(`🔊 Volume set to ${percent}%.`);
  },
};

const shuffle = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player || player.queue.length < 2) {
      return interaction.reply({ content: 'Not enough tracks to shuffle.', ephemeral: true });
    }
    player.shuffle();
    await interaction.reply('🔀 Queue shuffled.');
  },
};

const leave = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect the bot from voice'),
  async execute(interaction) {
    const player = getPlayer(interaction.guild);
    if (!player) return interaction.reply({ content: "I'm not in a voice channel.", ephemeral: true });
    player.destroy();
    await interaction.reply('👋 Left the voice channel.');
  },
};

export default [play, skip, stop, pause, resume, queue, nowplaying, volume, shuffle, leave];
