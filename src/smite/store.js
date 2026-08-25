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

function upsert(userId, fields) {
  const row = getPlayer(userId) || {};
  const merged = { ...row, ...fields };
  getDb()
    .prepare(
      `INSERT INTO smite_players
         (user_id, player_uuid, s2l_platform, s2l_id, s2l_profile_id, s2l_name, last_match_id, linked_at)
       VALUES (@user_id, @player_uuid, @s2l_platform, @s2l_id, @s2l_profile_id, @s2l_name, @last_match_id, @linked_at)
       ON CONFLICT(user_id) DO UPDATE SET
         player_uuid = excluded.player_uuid,
         s2l_platform = excluded.s2l_platform,
         s2l_id = excluded.s2l_id,
         s2l_profile_id = excluded.s2l_profile_id,
         s2l_name = excluded.s2l_name,
         last_match_id = excluded.last_match_id,
         linked_at = excluded.linked_at`
    )
    .run({
      user_id: userId,
      player_uuid: merged.player_uuid ?? null,
      s2l_platform: merged.s2l_platform ?? null,
      s2l_id: merged.s2l_id ?? null,
      s2l_profile_id: merged.s2l_profile_id ?? null,
      s2l_name: merged.s2l_name ?? null,
      last_match_id: merged.last_match_id ?? null,
      linked_at: Date.now(),
    });
}

/** Link (or update) the member's SmiteSource profile. */
export function linkSmiteSource(userId, playerUuid) {
  upsert(userId, { player_uuid: playerUuid });
}

/** Link (or update) the member's smite2.live profile. */
export function linkSmite2Live(userId, { platform, id, profileId, name }) {
  upsert(userId, {
    s2l_platform: platform,
    s2l_id: id,
    s2l_profile_id: profileId ?? null,
    s2l_name: name ?? null,
    // A new identity means old match history no longer applies.
    last_match_id: null,
  });
}

/**
 * Remember an in-game name smite2.live doesn't know yet. Auto-link retries
 * it until the site starts tracking the player, then fills in the ids.
 */
export function setPendingName(userId, name) {
  upsert(userId, {
    s2l_name: name,
    s2l_platform: null,
    s2l_id: null,
    s2l_profile_id: null,
    last_match_id: null,
  });
}

export function unlinkPlayer(userId) {
  return getDb().prepare('DELETE FROM smite_players WHERE user_id = ?').run(userId).changes > 0;
}

export function getPlayer(userId) {
  return getDb().prepare('SELECT * FROM smite_players WHERE user_id = ?').get(userId) || null;
}

export function playerUuid(userId) {
  return getPlayer(userId)?.player_uuid || null;
}

export function setLastMatch(userId, matchId) {
  getDb().prepare('UPDATE smite_players SET last_match_id = ? WHERE user_id = ?').run(matchId, userId);
}

export function listLinkedPlayers() {
  return getDb().prepare('SELECT * FROM smite_players').all();
}

/** Members with a smite2.live identity, for stat cards and match reports. */
export function listStatPlayers() {
  return getDb()
    .prepare('SELECT * FROM smite_players WHERE s2l_platform IS NOT NULL AND s2l_id IS NOT NULL')
    .all();
}
