import { spawn } from 'node:child_process';
import { createAudioResource, StreamType } from '@discordjs/voice';
import * as spotifyPkg from 'spotify-url-info';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

// spotify-url-info v3 exports a factory that takes a fetch implementation.
// Handle both default and named export shapes across minor versions.
const spotifyFactory = spotifyPkg.default || spotifyPkg.spotifyUrlInfo || spotifyPkg;
const spotify = spotifyFactory(fetch); // Node 18+ global fetch

const SPOTIFY_RE = /open\.spotify\.com\/(track|playlist|album)\//i;
const YT_PLAYLIST_RE = /[?&]list=/i;
const URL_RE = /^https?:\/\//i;

/**
 * A track: { title, url?, query?, durationMs }
 * `url` is a direct page URL ready to stream; if absent, `query` is searched on
 * YouTube lazily when the track is about to play (keeps big playlists cheap).
 */

function runYtdlp(args, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp exited ${code}: ${err.trim()}`));
      if (!json) return resolve(out);
      try {
        // -J on a playlist prints one JSON object; a plain video prints one too.
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (e) {
        reject(new Error(`Failed to parse yt-dlp JSON: ${e.message}`));
      }
    });
  });
}

function entryToTrack(e) {
  const id = e.id;
  const url = e.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : undefined);
  return {
    title: e.title || 'Unknown title',
    url,
    durationMs: e.duration ? Math.round(e.duration * 1000) : 0,
  };
}

async function searchYouTube(query) {
  const data = await runYtdlp(
    ['--no-warnings', '--no-playlist', '-J', `ytsearch1:${query}`],
    { json: true }
  );
  const entry = data.entries ? data.entries[0] : data;
  if (!entry) throw new Error(`No YouTube results for "${query}"`);
  return entryToTrack(entry);
}

async function resolveSpotify(url) {
  const tracks = await spotify.getTracks(url);
  return tracks
    .filter((t) => t && t.name)
    .map((t) => {
      const artist =
        t.artist ||
        (Array.isArray(t.artists) ? t.artists.map((a) => a.name || a).join(', ') : '');
      const title = artist ? `${artist} - ${t.name}` : t.name;
      return { title, query: title, durationMs: t.duration || t.duration_ms || 0 };
    });
}

async function resolveYouTubePlaylist(url) {
  const data = await runYtdlp(['--no-warnings', '--flat-playlist', '-J', url], { json: true });
  const entries = data.entries || [];
  return entries.map(entryToTrack);
}

/** Turn arbitrary user input into a list of playable tracks. */
export async function resolveQuery(query) {
  const input = query.trim();

  if (SPOTIFY_RE.test(input)) {
    logger.debug(`Resolving Spotify: ${input}`);
    return resolveSpotify(input);
  }
  if (URL_RE.test(input)) {
    if (YT_PLAYLIST_RE.test(input)) return resolveYouTubePlaylist(input);
    const data = await runYtdlp(['--no-warnings', '--no-playlist', '-J', input], { json: true });
    const entry = data.entries ? data.entries[0] : data;
    return [entryToTrack(entry)];
  }
  // Plain text → single YouTube search result.
  return [await searchYouTube(input)];
}

/** Build a streaming AudioResource for a track (resolving its URL lazily if needed). */
export async function createTrackResource(track, { volume = 1 } = {}) {
  let streamUrl = track.url;
  if (!streamUrl) {
    const resolved = await searchYouTube(track.query || track.title);
    streamUrl = resolved.url;
    track.url = streamUrl;
    if (!track.durationMs) track.durationMs = resolved.durationMs;
  }

  const proc = spawn(
    config.ytdlpPath,
    [
      '--no-warnings',
      '--no-playlist',
      '-f',
      'bestaudio/best',
      '-o',
      '-',
      '--quiet',
      streamUrl,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  proc.on('error', (e) => logger.error('yt-dlp stream error:', e.message));

  const resource = createAudioResource(proc.stdout, {
    inputType: StreamType.Arbitrary, // @discordjs/voice runs it through ffmpeg → opus
    inlineVolume: true,
  });
  resource.volume?.setVolume(volume);
  // Keep a handle so the player can kill the process if skipped mid-stream.
  resource.playbackProcess = proc;
  return resource;
}
