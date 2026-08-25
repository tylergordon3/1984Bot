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

export function linkPlayer(userId, playerUuid) {
  getDb()
    .prepare(
      `INSERT INTO smite_players (user_id, player_uuid, linked_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET player_uuid = excluded.player_uuid, linked_at = excluded.linked_at`
    )
    .run(userId, playerUuid, Date.now());
}

export function unlinkPlayer(userId) {
  return getDb().prepare('DELETE FROM smite_players WHERE user_id = ?').run(userId).changes > 0;
}

export function playerUuid(userId) {
  const row = getDb().prepare('SELECT player_uuid FROM smite_players WHERE user_id = ?').get(userId);
  return row?.player_uuid || null;
}

export function listLinkedPlayers() {
  return getDb().prepare('SELECT user_id, player_uuid, linked_at FROM smite_players').all();
}
