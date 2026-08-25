import { logger } from '../util/logger.js';
import { MINUTE } from '../util/time.js';

// smite2.live serves player stats server-rendered and allows general clients
// (its robots.txt only blocks AI-training crawlers); identify honestly.
const BASE = 'https://smite2.live';
const USER_AGENT = '1984Bot/1.0 (private Discord bot)';
const TIMEOUT = 20_000; // profile pages run to several MB
const CACHE_TTL = 5 * MINUTE;

const cache = new Map(); // url -> { at, body }

async function get(path, { redirect = 'follow', fresh = false, attempt = 1 } = {}) {
  const url = `${BASE}${path}`;
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL) return hit.body;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect,
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    if (attempt < 2) return get(path, { redirect, fresh, attempt: attempt + 1 });
    throw err;
  }
  if (redirect === 'manual' && res.status >= 300 && res.status < 400) {
    return { redirected: res.headers.get('location') || '' };
  }
  if (!res.ok) throw new Error(`smite2.live ${path} returned ${res.status}`);
  const body = await res.text();
  cache.set(url, { at: Date.now(), body });
  return body;
}

export function profilePath(platform, id) {
  return `/profile/${platform}/${id}`;
}

export function profileUrl(platform, id) {
  return `${BASE}${profilePath(platform, id)}/overview`;
}

const PROFILE_RE = /\/profile\/(steam|epic|xbox|psn)\/([A-Za-z0-9]+)/;

/**
 * Resolve an in-game name or a smite2.live profile URL to {platform, id}.
 * Search redirects straight to the profile on an exact name match; a miss
 * redirects to the homepage.
 */
export async function resolveProfile(query) {
  const direct = String(query).match(PROFILE_RE);
  if (direct) return { platform: direct[1], id: direct[2] };
  const res = await get(`/search?q=${encodeURIComponent(query.trim())}`, {
    redirect: 'manual',
    fresh: true,
  });
  const m = typeof res === 'object' ? res.redirected.match(PROFILE_RE) : null;
  return m ? { platform: m[1], id: m[2] } : null;
}

const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Player overview: display name, rank tier + MMR, headline stats for the
 * default (ranked conquest) mode, recent form, and the site's internal
 * numeric profile id (needed by the match performance API).
 */
export async function fetchOverview(platform, id) {
  const html = await get(`${profilePath(platform, id)}/overview`);
  const name = html.match(/<title>([^<]+?) - Overview<\/title>/)?.[1]?.trim() || null;
  const tier = html.match(/profile-rank__header-name">([^<]+)</)?.[1]?.trim() || null;
  const mmr = html.match(/profile-rank__header-mmr">([\d,]+)</)?.[1]?.replace(/,/g, '') || null;
  const profileId = html.match(/data-player-id="(\d+)"/)?.[1] || null;

  // "ov-stat-card" blocks: label / value / optional sub. Window each label
  // and pick the pieces out separately — a single lazy regex never commits
  // to the optional sub group.
  const stats = {};
  for (const m of html.matchAll(/ov-stat-card__label">([^<]+)</g)) {
    const window = html.slice(m.index, m.index + 500);
    const value = window.match(/ov-stat-card__value[^>]*>\s*([^<]+?)\s*</)?.[1];
    const sub = window.match(/ov-stat-card__sub">([^<]+)</)?.[1]?.trim() || null;
    if (value) stats[m[1].trim()] = { value, sub };
  }

  // Recent form strip: "52%</span> WR" plus an optional W/L streak chip.
  const recentWr = html.match(/ov-form-strip__stat">\s*<span[^>]*>([\d.]+%)<\/span>\s*WR/)?.[1] || null;
  const streak = html.match(/ov-form-strip__streak[^>]*>[\s\S]{0,200}?(\d+[WL])\s*</)?.[1] || null;

  return { name, tier, mmr, profileId, stats, recentWr, streak };
}

/**
 * Most-played gods with win rate / KDA / site performance grade, from the
 * gods tab's data attributes (rows come sorted by matches played).
 */
export async function fetchTopGods(platform, id, limit = 3) {
  const html = await get(`${profilePath(platform, id)}/gods`);
  const gods = [];
  const rowRe = /<tr class="gods-row"([^>]+)>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const attr = (name) => m[1].match(new RegExp(`data-${name}="([^"]*)"`))?.[1];
    const name = m[2].match(/gods-name">([^<]+)</)?.[1] || attr('god');
    if (!name) continue;
    gods.push({
      name,
      matches: Number(attr('matches')) || 0,
      winRate: Number(attr('wr')) || 0,
      kda: Number(attr('kda')) || 0,
      grade: m[2].match(/gods-perf-grade"[^>]*>([^<]+)</)?.[1]?.trim() || null,
    });
    if (gods.length >= limit) break;
  }
  return gods;
}

/** Newest-first match ids from the profile's matches tab. */
export async function fetchLatestMatchIds(platform, id, limit = 5) {
  const html = await get(`${profilePath(platform, id)}/matches`, { fresh: true });
  const ids = [];
  for (const m of html.matchAll(/data-match-id="([0-9a-f-]{36})"/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** Per-player match performance (god, role, result, grade, raw stats). */
export async function fetchPerformance(matchId, profileId) {
  const body = await get(`/api/match/${matchId}/performance?profile_id=${profileId}`, {
    fresh: true,
  });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('smite2.live performance API returned non-JSON');
  }
}

/** Overview + top gods together, with failures logged and nulled per part. */
export async function fetchStatCard(platform, id) {
  const [overview, gods] = await Promise.all([
    fetchOverview(platform, id).catch((err) => {
      logger.warn(`smite2.live overview failed for ${platform}/${id}: ${err.message}`);
      return null;
    }),
    fetchTopGods(platform, id).catch(() => []),
  ]);
  return overview ? { ...overview, topGods: gods } : null;
}
