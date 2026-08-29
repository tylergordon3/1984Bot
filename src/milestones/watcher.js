// Announces milestones as they happen. Sweeps the session tables on a timer
// rather than hooking every tracker, so an achievement crossed while the bot
// was down is still caught, and open sessions count toward totals.
//
// The first sweep that sees a kind of milestone takes a *baseline*: every
// instance already true is written down silently, and only what happens after
// that is announced. Baselines are per scope rather than one global flag, so a
// check added in a later release baselines itself on deploy instead of
// announcing every member's back catalogue at once.
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import { MINUTE } from '../util/time.js';
import { findTextChannel } from '../util/channels.js';
import { currentAwards, AWARD_SCOPES, scopeOf } from './checks.js';
import { isScopeSeeded, markScopeSeeded, hasAward, awardValue, record } from './store.js';

const SWEEP_INTERVAL = 5 * MINUTE;
// The interval-sweep checks (alone time, pair time) are much heavier than the
// rest, so they ride along only once an hour.
const DEEP_EVERY = 12;
// Announcements per sweep. Anything over the cap waits for the next one rather
// than being marked awarded, so nothing is silently swallowed.
const MAX_PER_SWEEP = 5;

const COLOR = 0xcc0000;

function toEmbed(award, previous) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: '👁️ The permanent record' })
    .setTitle(award.title)
    .setDescription(award.describe(previous))
    .setTimestamp();
}

/** Awards that are new: unseen keys, or records beaten since last time. */
function newAwards(awards) {
  const fresh = [];
  for (const award of awards) {
    if (award.isRecord) {
      const previous = awardValue(award.key);
      if (previous && award.value <= (previous.value ?? 0)) continue;
      fresh.push({ award, previous });
    } else if (!hasAward(award.key)) {
      fresh.push({ award, previous: null });
    }
  }
  return fresh;
}

function store(award, { baseline = false } = {}) {
  record({
    key: award.key,
    kind: award.kind,
    userId: award.userId ?? null,
    detail: award.detail ?? null,
    value: award.value ?? null,
    // Baseline rows are dated 0: recorded so they're never announced, but not
    // presented as things that just happened.
    at: baseline ? 0 : Date.now(),
  });
}

/**
 * Write down everything already true of scopes we've never baselined,
 * announcing none of it. Runs on first boot for every scope, and again for
 * just the new ones whenever a release adds a check — otherwise the day a
 * check ships, every member's entire history arrives at once as "news".
 *
 * Existing rows are left alone: a scope being re-baselined must never reset
 * the timestamps of milestones that were genuinely announced.
 */
function seedScopes(pending) {
  let recorded = 0;
  for (const award of currentAwards({ deep: true, seeding: true })) {
    if (!pending.has(scopeOf(award)) || hasAward(award.key)) continue;
    store(award, { baseline: true });
    recorded++;
  }
  for (const scope of pending) markScopeSeeded(scope);
  logger.info(
    `Milestones: baseline taken for ${pending.size} scope(s) ` +
      `[${[...pending].join(', ')}] — ${recorded} already-earned milestone(s) recorded.`
  );
}

async function sweep(client, deep) {
  const pending = new Set(AWARD_SCOPES.filter((scope) => !isScopeSeeded(scope)));
  if (pending.size > 0) {
    // A baseline sweep announces nothing; the next one resumes normally.
    seedScopes(pending);
    return;
  }

  const fresh = newAwards(currentAwards({ deep }));
  if (fresh.length === 0) return;

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  const channel = findTextChannel(guild, config.milestoneChannel);
  if (!channel) {
    logger.warn(`Milestones: channel "${config.milestoneChannel}" not found in guild.`);
    return;
  }

  const batch = fresh.slice(0, MAX_PER_SWEEP);
  const embeds = batch.map(({ award, previous }) => toEmbed(award, previous));
  // Recorded before sending, as with weather alerts: a failed send costs one
  // announcement, where an unrecorded award would repeat every five minutes.
  for (const { award } of batch) store(award);
  await channel.send({ embeds });
  for (const { award } of batch) logger.info(`👁️ milestone: ${award.key}`);
  if (fresh.length > batch.length) {
    logger.info(`Milestones: ${fresh.length - batch.length} more queued for the next sweep.`);
  }
}

/** Start the milestone sweeps. Returns a stop function. */
export function startMilestoneWatcher(client) {
  logger.info(`Milestones → #${config.milestoneChannel} | sweeping every 5 minutes`);

  let ticks = 0;
  const run = () => {
    const deep = ticks % DEEP_EVERY === 0;
    ticks += 1;
    sweep(client, deep).catch((err) => logger.warn(`Milestone sweep failed: ${err.message}`));
  };

  const timer = setInterval(run, SWEEP_INTERVAL);
  run(); // take the baseline (or catch anything earned while we were down) now
  return () => clearInterval(timer);
}
