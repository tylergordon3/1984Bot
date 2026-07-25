import {
  joinVoiceChannel,
  createAudioPlayer,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { createTrackResource } from './sources.js';
import { logger } from '../util/logger.js';
import { formatDuration } from '../util/time.js';

const IDLE_DISCONNECT_MS = 5 * 60 * 1000;

const players = new Map(); // guildId -> GuildPlayer

class GuildPlayer {
  constructor(guild) {
    this.guild = guild;
    this.queue = [];
    this.current = null;
    this.volume = 1;
    this.textChannel = null;
    this.idleTimer = null;

    this.audioPlayer = createAudioPlayer();
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => this._onIdle());
    this.audioPlayer.on('error', (err) => {
      logger.error(`Audio error in ${this.guild.id}:`, err.message);
      this._playNext();
    });
  }

  connect(voiceChannel) {
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    this.connection.subscribe(this.audioPlayer);
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.destroy();
      }
    });
  }

  get connected() {
    return this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  enqueue(tracks, requestedBy) {
    for (const t of tracks) t.requestedBy = requestedBy;
    this.queue.push(...tracks);
  }

  async start() {
    if (!this.current) await this._playNext();
  }

  async _playNext() {
    this._clearIdleTimer();
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this._scheduleIdleDisconnect();
      return;
    }
    this.current = next;
    try {
      const resource = await createTrackResource(next, { volume: this.volume });
      this._currentResource = resource;
      this.audioPlayer.play(resource);
      if (this.textChannel) {
        this.textChannel
          .send(`▶️ Now playing **${next.title}** (${formatDuration(next.durationMs)})`)
          .catch(() => {});
      }
    } catch (err) {
      logger.error(`Failed to play "${next.title}":`, err.message);
      if (this.textChannel) {
        this.textChannel.send(`⚠️ Couldn't play **${next.title}** — skipping.`).catch(() => {});
      }
      await this._playNext();
    }
  }

  _onIdle() {
    this._killCurrentProcess();
    this._playNext();
  }

  _killCurrentProcess() {
    const proc = this._currentResource?.playbackProcess;
    if (proc && !proc.killed) proc.kill('SIGKILL');
  }

  skip() {
    const skipped = this.current;
    this._killCurrentProcess();
    this.audioPlayer.stop(true); // triggers Idle → _playNext
    return skipped;
  }

  pause() {
    return this.audioPlayer.pause();
  }

  resume() {
    return this.audioPlayer.unpause();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(2, v));
    this._currentResource?.volume?.setVolume(this.volume);
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  stop() {
    this.queue = [];
    this._killCurrentProcess();
    this.audioPlayer.stop(true);
    this.current = null;
  }

  _scheduleIdleDisconnect() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => this.destroy(), IDLE_DISCONNECT_MS);
  }

  _clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  destroy() {
    this._clearIdleTimer();
    this._killCurrentProcess();
    try {
      this.audioPlayer.stop(true);
    } catch {}
    const conn = getVoiceConnection(this.guild.id);
    if (conn) conn.destroy();
    players.delete(this.guild.id);
  }
}

export function getPlayer(guild, create = false) {
  let player = players.get(guild.id);
  if (!player && create) {
    player = new GuildPlayer(guild);
    players.set(guild.id, player);
  }
  return player;
}

export function destroyAllPlayers() {
  for (const p of players.values()) p.destroy();
}
