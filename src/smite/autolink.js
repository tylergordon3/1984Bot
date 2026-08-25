import { logger } from '../util/logger.js';
import { HOUR } from '../util/time.js';
import { resolveProfile, fetchOverview } from './smite2live.js';
import { linkSmite2Live, getPlayer } from './store.js';

// Failed lookups aren't retried for a while — smite2.live search is
// exact-match, so a Discord name that missed once will keep missing.
const RETRY_AFTER = 24 * HOUR;
const attempted = new Map(); // userId -> ts

/**
 * Try to find a member's smite2.live profile by their Discord names
 * (nickname, global name, username). On a hit the profile is linked as if
 * they ran /smite link themselves. Returns the stored row, or null.
 */
export async function autoLinkSmite2Live(userId, names, { force = false } = {}) {
  if (!force && Date.now() - (attempted.get(userId) || 0) < RETRY_AFTER) return null;
  attempted.set(userId, Date.now());
  // A stored pending in-game name (from /smite link before smite2.live
  // tracked the player) beats guesses from Discord names.
  const pending = getPlayer(userId)?.s2l_name;
  for (const name of [...new Set([pending, ...names].filter(Boolean))]) {
    const resolved = await resolveProfile(name).catch(() => null);
    if (!resolved) continue;
    const overview = await fetchOverview(resolved.platform, resolved.id).catch(() => null);
    linkSmite2Live(userId, {
      platform: resolved.platform,
      id: resolved.id,
      profileId: overview?.profileId ?? null,
      name: overview?.name ?? null,
    });
    logger.info(`SMITE auto-link: ${userId} → ${overview?.name || name} (${resolved.platform})`);
    return getPlayer(userId);
  }
  return null;
}
