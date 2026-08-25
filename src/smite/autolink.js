import { logger } from '../util/logger.js';
import { HOUR } from '../util/time.js';
import { resolveProfile, fetchOverview } from './smite2live.js';
import { addAccount, accountsFor, pendingAccounts, resolvedAccounts } from './store.js';

// Failed lookups aren't retried for a while — smite2.live search is
// exact-match over its own index, so a miss will usually keep missing
// until the site ingests the player.
const RETRY_AFTER = 24 * HOUR;
const attempted = new Map(); // userId -> ts

async function resolveName(name) {
  const resolved = await resolveProfile(name).catch(() => null);
  if (!resolved) return null;
  const overview = await fetchOverview(resolved.platform, resolved.id).catch(() => null);
  return { ...resolved, profileId: overview?.profileId ?? null, name: overview?.name ?? name };
}

/**
 * Retry a member's pending accounts against smite2.live, and — when they have
 * no accounts at all — guess from their Discord names, linking any hit.
 * Returns the member's resolved accounts afterwards.
 */
export async function autoResolveAccounts(userId, discordNames = [], { force = false } = {}) {
  if (!force && Date.now() - (attempted.get(userId) || 0) < RETRY_AFTER) {
    return resolvedAccounts(userId);
  }
  attempted.set(userId, Date.now());

  for (const acct of pendingAccounts(userId)) {
    const hit = await resolveName(acct.s2l_name);
    if (!hit) continue;
    addAccount(userId, { name: hit.name, platform: hit.platform, id: hit.id, profileId: hit.profileId });
    logger.info(`SMITE account resolved: ${userId} → ${hit.name} (${hit.platform})`);
  }

  if (accountsFor(userId).length === 0) {
    for (const name of [...new Set(discordNames.filter(Boolean))]) {
      const hit = await resolveName(name);
      if (!hit) continue;
      addAccount(userId, { name: hit.name, platform: hit.platform, id: hit.id, profileId: hit.profileId });
      logger.info(`SMITE auto-link: ${userId} → ${hit.name} (${hit.platform})`);
      break;
    }
  }
  return resolvedAccounts(userId);
}
