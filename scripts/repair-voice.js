// Repair overlapping/duplicate voice sessions caused by the pre-fix tracker.
// Flattens each user's sessions so none overlap in time (no double-counting),
// preserving distinct channel sessions as adjacent intervals.
//
//   node scripts/repair-voice.js            # DRY RUN — reports, writes nothing
//   node scripts/repair-voice.js --apply    # backs up the DB, then repairs
//
// IMPORTANT: stop the bot before running with --apply.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { config } from '../src/config.js';

const APPLY = process.argv.includes('--apply');
const NOW = Date.now();
const H = (ms) => (ms / 3600000).toFixed(1) + 'h';

const db = new Database(config.databasePath);
const name = (id) => {
  const r = db.prepare('SELECT username FROM users WHERE user_id = ?').get(id);
  return r ? r.username : id;
};

// Flatten one table so no two rows for the same key (user [+ flag]) overlap.
function plan(table, tsStart, tsEnd, extraKey) {
  const orderCols = ['user_id', extraKey, tsStart, 'id'].filter(Boolean).join(', ');
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderCols}`).all();
  const groups = new Map();
  for (const r of rows) {
    const key = r.user_id + '|' + (extraKey ? r[extraKey] : '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const deletes = [];
  const clips = []; // { id, newStart }
  for (const list of groups.values()) {
    let cursor = 0;
    for (const r of list) {
      const start = r[tsStart];
      const end = r[tsEnd] == null ? NOW : r[tsEnd];
      const newStart = Math.max(start, cursor);
      if (newStart >= end) {
        deletes.push(r.id);
        continue; // fully covered by an earlier session
      }
      if (newStart !== start) clips.push({ id: r.id, newStart });
      cursor = end;
    }
  }
  return { deletes, clips };
}

function totals() {
  return db
    .prepare(
      `SELECT user_id, SUM(COALESCE(left_at, ?) - joined_at) ms
       FROM voice_sessions GROUP BY user_id ORDER BY ms DESC LIMIT 8`
    )
    .all(NOW);
}

console.log(`Mode: ${APPLY ? 'APPLY (will modify DB)' : 'DRY RUN (no changes)'}\n`);
console.log('Voice totals BEFORE:');
for (const r of totals()) console.log(`  ${name(r.user_id).padEnd(16)} ${H(r.ms)}`);

const sessions = plan('voice_sessions', 'joined_at', 'left_at', null);
const flags = plan('voice_flags', 'started_at', 'ended_at', 'flag');
const games = plan('game_sessions', 'started_at', 'ended_at', 'game_name');
console.log(
  `\nvoice_sessions: delete ${sessions.deletes.length}, clip ${sessions.clips.length}`
);
console.log(`voice_flags:    delete ${flags.deletes.length}, clip ${flags.clips.length}`);
console.log(`game_sessions:  delete ${games.deletes.length}, clip ${games.clips.length}`);

if (APPLY) {
  const backup = `${config.databasePath}.backup-${Date.now()}.sqlite`;
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`\nBackup written: ${backup}`);

  const apply = db.transaction(() => {
    const delSess = db.prepare('DELETE FROM voice_sessions WHERE id = ?');
    const clipSess = db.prepare('UPDATE voice_sessions SET joined_at = ? WHERE id = ?');
    for (const id of sessions.deletes) delSess.run(id);
    for (const c of sessions.clips) clipSess.run(c.newStart, c.id);
    const delFlag = db.prepare('DELETE FROM voice_flags WHERE id = ?');
    const clipFlag = db.prepare('UPDATE voice_flags SET started_at = ? WHERE id = ?');
    for (const id of flags.deletes) delFlag.run(id);
    for (const c of flags.clips) clipFlag.run(c.newStart, c.id);
    const delGame = db.prepare('DELETE FROM game_sessions WHERE id = ?');
    const clipGame = db.prepare('UPDATE game_sessions SET started_at = ? WHERE id = ?');
    for (const id of games.deletes) delGame.run(id);
    for (const c of games.clips) clipGame.run(c.newStart, c.id);
  });
  apply();

  console.log('\nVoice totals AFTER:');
  for (const r of totals()) console.log(`  ${name(r.user_id).padEnd(16)} ${H(r.ms)}`);
  console.log('\n✅ Repair applied.');
} else {
  // Simulate the flattened result so we can preview totals without writing.
  const rows = db
    .prepare('SELECT * FROM voice_sessions ORDER BY user_id, joined_at, id')
    .all();
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  const projected = [];
  for (const [uid, list] of byUser) {
    let cursor = 0;
    let ms = 0;
    for (const r of list) {
      const start = r.joined_at;
      const end = r.left_at == null ? NOW : r.left_at;
      const s = Math.max(start, cursor);
      if (s >= end) continue;
      ms += end - s;
      cursor = end;
    }
    projected.push({ uid, ms });
  }
  projected.sort((a, b) => b.ms - a.ms);
  console.log('\nVoice totals AFTER (projected):');
  for (const r of projected.slice(0, 8)) console.log(`  ${name(r.uid).padEnd(16)} ${H(r.ms)}`);
  console.log('\nDry run only. Re-run with --apply (bot stopped) to repair.');
}

db.close();
