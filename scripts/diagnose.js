// Read-only diagnostics for voice tracking integrity.
import Database from 'better-sqlite3';
import { config } from '../src/config.js';

const db = new Database(config.databasePath, { readonly: true });
const name = (id) => {
  const r = db.prepare('SELECT username FROM users WHERE user_id = ?').get(id);
  return r ? r.username : id;
};

console.log('=== voice_sessions summary ===');
console.log(db.prepare('SELECT COUNT(*) c, SUM(left_at IS NULL) open FROM voice_sessions').get());

console.log('\n=== users with MORE THAN ONE open (left_at IS NULL) session ===');
const multiOpen = db
  .prepare(
    `SELECT user_id, COUNT(*) n FROM voice_sessions WHERE left_at IS NULL
     GROUP BY user_id HAVING n > 1 ORDER BY n DESC`
  )
  .all();
if (multiOpen.length === 0) console.log('(none)');
for (const r of multiOpen) console.log(`  ${name(r.user_id)}: ${r.n} concurrent open sessions`);

console.log('\n=== self-overlapping sessions (same user, same time) ===');
const overlaps = db
  .prepare(
    `SELECT a.user_id, COUNT(*) n
     FROM voice_sessions a
     JOIN voice_sessions b
       ON a.user_id = b.user_id AND a.id < b.id
      AND a.joined_at < COALESCE(b.left_at, 9e18)
      AND b.joined_at < COALESCE(a.left_at, 9e18)
     GROUP BY a.user_id ORDER BY n DESC`
  )
  .all();
if (overlaps.length === 0) console.log('(none)');
for (const r of overlaps) console.log(`  ${name(r.user_id)}: ${r.n} overlapping session pairs`);

console.log('\n=== top voice totals (all time, raw sum) ===');
const now = Date.now();
const totals = db
  .prepare(
    `SELECT user_id, SUM(COALESCE(left_at, ?) - joined_at) ms, COUNT(*) sessions
     FROM voice_sessions GROUP BY user_id ORDER BY ms DESC LIMIT 10`
  )
  .all(now);
for (const r of totals) {
  const hours = (r.ms / 3600000).toFixed(1);
  console.log(`  ${name(r.user_id)}: ${hours}h across ${r.sessions} sessions`);
}

console.log('\n\n########## GAME SESSIONS ##########');
console.log('\n=== game_sessions summary ===');
console.log(db.prepare('SELECT COUNT(*) c, SUM(ended_at IS NULL) open FROM game_sessions').get());

console.log('\n=== (user, game) with MORE THAN ONE open session ===');
const gMultiOpen = db
  .prepare(
    `SELECT user_id, game_name, COUNT(*) n FROM game_sessions WHERE ended_at IS NULL
     GROUP BY user_id, game_name HAVING n > 1 ORDER BY n DESC`
  )
  .all();
if (gMultiOpen.length === 0) console.log('(none)');
for (const r of gMultiOpen) console.log(`  ${name(r.user_id)} / ${r.game_name}: ${r.n} open`);

console.log('\n=== self-overlapping game sessions (same user, same game, same time) ===');
const gOverlaps = db
  .prepare(
    `SELECT a.user_id, a.game_name, COUNT(*) n
     FROM game_sessions a
     JOIN game_sessions b
       ON a.user_id = b.user_id AND a.game_name = b.game_name AND a.id < b.id
      AND a.started_at < COALESCE(b.ended_at, 9e18)
      AND b.started_at < COALESCE(a.ended_at, 9e18)
     GROUP BY a.user_id, a.game_name ORDER BY n DESC`
  )
  .all();
if (gOverlaps.length === 0) console.log('(none)');
for (const r of gOverlaps) console.log(`  ${name(r.user_id)} / ${r.game_name}: ${r.n} overlapping pairs`);

console.log('\n=== top game totals (all time, raw sum) ===');
const gTotals = db
  .prepare(
    `SELECT game_name, SUM(COALESCE(ended_at, ?) - started_at) ms, COUNT(*) sessions
     FROM game_sessions GROUP BY game_name ORDER BY ms DESC LIMIT 10`
  )
  .all(now);
for (const r of gTotals) {
  console.log(`  ${r.game_name}: ${(r.ms / 3600000).toFixed(1)}h across ${r.sessions} sessions`);
}

db.close();
