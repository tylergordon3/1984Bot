// Writing history down without announcing it.
//
// Two things must never produce announcements, because nothing actually
// happened: switching on a check that has been able to see the past all along,
// and importing history that was always true but wasn't in the database yet.
// Both are handled here, and both are careful never to disturb milestones that
// were genuinely announced.
import { getDb } from '../db/database.js';
import { logger } from '../util/logger.js';
import { currentAwards, scopeOf } from './checks.js';
import { hasAward, awardValue, record, markScopeSeeded } from './store.js';

/** Record an award as history: on file, dated 0, never announced. */
function storeAsHistory(award) {
  record({
    key: award.key,
    kind: award.kind,
    userId: award.userId ?? null,
    detail: award.detail ?? null,
    value: award.value ?? null,
    at: 0,
  });
}

/**
 * Take a value onto an existing record row without re-dating it. Used when a
 * record is beaten by imported history rather than by anything that happened:
 * the standing record should be right, but nobody should be told about it.
 */
function updateRecordQuietly(award) {
  getDb()
    .prepare('UPDATE milestones_awarded SET user_id = ?, detail = ?, value = ? WHERE key = ?')
    .run(award.userId ?? null, award.detail ?? null, award.value ?? null, award.key);
}

/**
 * Baseline the given scopes: everything already true of them goes on file
 * silently. Existing rows are left alone, so a scope being re-baselined can
 * never reset the timestamp of a milestone that was genuinely announced.
 *
 * Returns how many rows were written.
 */
export function baselineScopes(pending) {
  let recorded = 0;
  for (const award of currentAwards({ deep: true, seeding: true })) {
    if (!pending.has(scopeOf(award)) || hasAward(award.key)) continue;
    storeAsHistory(award);
    recorded++;
  }
  for (const scope of pending) markScopeSeeded(scope);
  return recorded;
}

/**
 * Bring the milestone tables level with the database after importing history.
 *
 * A backfill can make a threshold true (someone's imported messages push them
 * past 500) or beat a standing record (an old message turns out to be the
 * best-received one). Neither is news: it was always true, we just hadn't
 * looked. Run this at the end of any import, or the next sweep announces the
 * archive as though it happened this afternoon.
 */
export function reconcileImportedHistory() {
  let recorded = 0;
  let updated = 0;

  for (const award of currentAwards({ deep: true, seeding: true })) {
    if (award.isRecord) {
      const previous = awardValue(award.key);
      if (previous && (award.value ?? 0) > (previous.value ?? 0)) {
        updateRecordQuietly(award);
        updated++;
        continue;
      }
    }
    if (hasAward(award.key)) continue;
    storeAsHistory(award);
    recorded++;
  }

  if (recorded || updated) {
    logger.info(
      `Milestones reconciled after import: ${recorded} filed as history, ` +
        `${updated} record(s) quietly updated. None announced.`
    );
  }
  return { recorded, updated };
}
