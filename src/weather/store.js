import { getDb } from '../db/database.js';

export function listLocations() {
  return getDb().prepare('SELECT * FROM weather_locations ORDER BY name').all();
}

export function getLocation(name) {
  return getDb().prepare('SELECT * FROM weather_locations WHERE name = ?').get(name);
}

export function addLocation(name, lat, lon, addedBy) {
  getDb()
    .prepare(
      `INSERT INTO weather_locations (name, lat, lon, added_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, lat, lon, addedBy, Date.now());
}

/** Delete a location plus its subscriptions and dedupe history. */
export function removeLocation(name) {
  const db = getDb();
  db.prepare('DELETE FROM weather_subscribers WHERE location_name = ?').run(name);
  db.prepare('DELETE FROM weather_alerts_sent WHERE location = ?').run(name);
  return db.prepare('DELETE FROM weather_locations WHERE name = ?').run(name).changes > 0;
}

export function subscribe(locationName, userId) {
  return (
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO weather_subscribers (location_name, user_id, created_at)
         VALUES (?, ?, ?)`
      )
      .run(locationName, userId, Date.now()).changes > 0
  );
}

export function unsubscribe(locationName, userId) {
  return (
    getDb()
      .prepare('DELETE FROM weather_subscribers WHERE location_name = ? AND user_id = ?')
      .run(locationName, userId).changes > 0
  );
}

/** User ids subscribed to a location, oldest subscription first. */
export function subscriberIds(locationName) {
  return getDb()
    .prepare('SELECT user_id FROM weather_subscribers WHERE location_name = ? ORDER BY created_at')
    .all(locationName)
    .map((r) => r.user_id);
}
