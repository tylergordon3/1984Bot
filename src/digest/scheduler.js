// Posts the digest on a schedule: a daily edition at DIGEST_HOUR, and a weekly
// one on DIGEST_WEEKLY_DAY at the same hour. Every edition posted is recorded,
// so a restart can never repeat one — and editions whose slot has already
// passed when the bot boots are marked done rather than fired late.
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { logger } from '../util/logger.js';
import { MINUTE, resolvePeriod } from '../util/time.js';
import { findTextChannel } from '../util/channels.js';
import { buildDigest } from './report.js';

const TICK_INTERVAL = MINUTE;

const EDITIONS = {
  daily: { period: 'day', title: '👁️ Daily Report' },
  weekly: { period: 'week', title: '👁️ Weekly Report' },
};

/** Local calendar date, e.g. "2026-08-29" — the identity of an edition. */
function dateKey(d) {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

function alreadySent(periodKey) {
  return !!getDb().prepare('SELECT 1 FROM digests_sent WHERE period_key = ?').get(periodKey);
}

function markSent(periodKey, kind) {
  getDb()
    .prepare('INSERT OR IGNORE INTO digests_sent (period_key, kind, sent_at) VALUES (?, ?, ?)')
    .run(periodKey, kind, Date.now());
}

/**
 * Which editions are due right now: enabled, past their hour today, on their
 * day, and not yet posted. Each comes back with the key that records it.
 */
function dueEditions(now = new Date()) {
  const due = [];
  if (now.getHours() < config.digestHour) return due;
  const today = dateKey(now);

  if (config.digestDaily) {
    const key = `daily:${today}`;
    if (!alreadySent(key)) due.push({ kind: 'daily', key });
  }
  if (config.digestWeekly && now.getDay() === config.digestWeeklyDay) {
    const key = `weekly:${today}`;
    if (!alreadySent(key)) due.push({ kind: 'weekly', key });
  }
  return due;
}

async function post(client, edition) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  const channel = findTextChannel(guild, config.digestChannel);
  if (!channel) {
    logger.warn(`Digest: channel "${config.digestChannel}" not found in guild.`);
    return;
  }

  const { period, title } = EDITIONS[edition.kind];
  const embed = buildDigest(resolvePeriod(period), title);

  // Mark before sending, as with weather alerts: a Discord hiccup must not
  // turn into a report posted once a minute for the rest of the day.
  markSent(edition.key, edition.kind);
  if (!embed) {
    logger.info(`Digest: ${edition.kind} edition skipped — nothing happened.`);
    return;
  }
  await channel.send({ embeds: [embed] });
  logger.info(`👁️ ${edition.kind} digest posted to #${channel.name}.`);
}

/** Post whichever editions are due right now. One tick of the scheduler. */
export async function runDigestTick(client) {
  for (const edition of dueEditions()) {
    await post(client, edition);
  }
}

/**
 * Start the digest scheduler. Ticks every minute rather than sleeping until
 * the hour, so it survives clock changes, DST and a Pi that was asleep.
 */
export function startDigestScheduler(client) {
  // Editions whose slot is already behind us at boot are recorded, not sent:
  // a restart at 3pm shouldn't fire the 9am report into the channel.
  for (const edition of dueEditions()) {
    markSent(edition.key, edition.kind);
    logger.debug(`Digest: ${edition.kind} slot already passed at boot — skipping today.`);
  }

  const editions = [
    config.digestDaily ? 'daily' : null,
    config.digestWeekly ? `weekly (day ${config.digestWeeklyDay})` : null,
  ].filter(Boolean);
  logger.info(
    `Digest → #${config.digestChannel} at ${String(config.digestHour).padStart(2, '0')}:00 | ` +
      `editions: ${editions.join(', ') || 'none enabled'}`
  );

  const timer = setInterval(() => {
    runDigestTick(client).catch((err) => logger.warn(`Digest post failed: ${err.message}`));
  }, TICK_INTERVAL);

  return () => clearInterval(timer);
}
