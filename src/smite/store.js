import { getDb } from '../db/database.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Pull a UUID out of a SmiteSource player URL, or accept a bare UUID. */
export function extractPlayerUuid(text) {
  const m = String(text || '').match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

export function playerPageUrl(uuid) {
  return `https://smitesource.com/player/${uuid}`;
}

export function matchPageUrl(uuid) {
  return `https://smitesource.com/match/${uuid}`;
}

// ── SmiteSource profile (one per member) ─────────────────────────────────

export function linkSmiteSource(userId, playerUuid) {
  getDb()
    .prepare(
      `INSERT INTO smite_players (user_id, player_uuid, linked_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET player_uuid = excluded.player_uuid, linked_at = excluded.linked_at`
    )
    .run(userId, playerUuid, Date.now());
}

export function getPlayer(userId) {
  return getDb().prepare('SELECT * FROM smite_players WHERE user_id = ?').get(userId) || null;
}

// ── smite2.live accounts (any number per member) ─────────────────────────

/**
 * Add or update one in-game account. Matches an existing row by smite2.live
 * id first, then by name (case-insensitive), so re-linking never duplicates.
 * Pass only a name to store a pending account (not yet tracked by the site).
 */
export function addAccount(userId, { name = null, platform = null, id = null, profileId = null }) {
  const db = getDb();
  const rows = accountsFor(userId);
  const existing =
    (id && rows.find((r) => r.s2l_id === id)) ||
    (name && rows.find((r) => r.s2l_name?.toLowerCase() === name.toLowerCase()));
  if (existing) {
    db.prepare(
      `UPDATE smite_accounts SET s2l_name = COALESCE(?, s2l_name), s2l_platform = ?,
         s2l_id = ?, s2l_profile_id = ?,
         last_match_id = CASE WHEN s2l_id IS ? THEN last_match_id ELSE NULL END
       WHERE rowid = ?`
    ).run(name, platform, id, profileId, id, existing.account_id);
    return existing.account_id;
  }
  return db
    .prepare(
      `INSERT INTO smite_accounts (user_id, s2l_name, s2l_platform, s2l_id, s2l_profile_id, linked_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, name, platform, id, profileId, Date.now()).lastInsertRowid;
}

export function accountsFor(userId) {
  return getDb()
    .prepare('SELECT rowid AS account_id, * FROM smite_accounts WHERE user_id = ? ORDER BY linked_at')
    .all(userId);
}

/** Accounts smite2.live actually tracks (usable for stats and reports). */
export function resolvedAccounts(userId) {
  return accountsFor(userId).filter((a) => a.s2l_platform && a.s2l_id);
}

export function pendingAccounts(userId) {
  return accountsFor(userId).filter((a) => !a.s2l_platform && a.s2l_name);
}

/** Remove one account by in-game name. Returns true if something matched. */
export function removeAccount(userId, name) {
  return (
    getDb()
      .prepare('DELETE FROM smite_accounts WHERE user_id = ? AND LOWER(s2l_name) = LOWER(?)')
      .run(userId, name).changes > 0
  );
}

/** Remove everything (SmiteSource link and all accounts) for a member. */
export function unlinkPlayer(userId) {
  const db = getDb();
  const a = db.prepare('DELETE FROM smite_players WHERE user_id = ?').run(userId).changes;
  const b = db.prepare('DELETE FROM smite_accounts WHERE user_id = ?').run(userId).changes;
  return a + b > 0;
}

export function setAccountLastMatch(accountId, matchId) {
  getDb().prepare('UPDATE smite_accounts SET last_match_id = ? WHERE rowid = ?').run(matchId, accountId);
}

/** Every resolved account across all members, for the match-report poller. */
export function listPollableAccounts() {
  return getDb()
    .prepare(
      `SELECT rowid AS account_id, * FROM smite_accounts
       WHERE s2l_platform IS NOT NULL AND s2l_id IS NOT NULL AND s2l_profile_id IS NOT NULL`
    )
    .all();
}

/** Every member with anything linked, for /smite list. */
export function listLinkedUsers() {
  return getDb()
    .prepare(
      `SELECT DISTINCT user_id FROM (
         SELECT user_id FROM smite_players WHERE player_uuid IS NOT NULL
         UNION SELECT user_id FROM smite_accounts
       )`
    )
    .all()
    .map((r) => r.user_id);
}
