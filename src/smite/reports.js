import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { getDb, logName } from '../db/database.js';
import { logger } from '../util/logger.js';
import { MINUTE } from '../util/time.js';
import { findTextChannel } from '../util/channels.js';
import { listStatPlayers, setLastMatch } from './store.js';
import { fetchLatestMatchIds, fetchPerformance } from './smite2live.js';
import { SMITE_EMBED_COLOR, modeName, roleName } from './embeds.js';

const POLL_INTERVAL = 3 * MINUTE;
// Matches finish (and appear on smite2.live) after the session that played
// them, so keep polling a member for a while after they close the game.
const LINGER = 20 * MINUTE;

/** Linked members whose SMITE session is open or recently ended. */
function pollablePlayers() {
  const cutoff = Date.now() - LINGER;
  const active = new Set(
    getDb()
      .prepare(
        `SELECT DISTINCT user_id FROM game_sessions
         WHERE game_name LIKE 'SMITE%' AND (ended_at IS NULL OR ended_at > ?)`
      )
      .all(cutoff)
      .map((r) => r.user_id)
  );
  return listStatPlayers().filter((p) => active.has(p.user_id));
}

/** percentile_rank is "better than X% of players" — phrase both halves sanely. */
function percentileLabel(p) {
  if (!p) return '';
  return p >= 50
    ? ` · top ${Math.max(1, Math.round(100 - p))}%`
    : ` · bottom ${Math.max(1, Math.round(p))}%`;
}

function kdaLine(perf) {
  const v = perf.stat_values || {};
  if (v.Kills == null) return null;
  return `${v.Kills}/${v.Deaths}/${v.Assists}`;
}

function reportEmbed(matchId, entries) {
  const first = entries[0].perf;
  const minutes = Math.round(first.match_context?.duration_minutes || 0);
  const embed = new EmbedBuilder()
    .setColor(SMITE_EMBED_COLOR)
    .setTitle(`⚔️ Match report — ${modeName(first.game_mode)}`)
    .setDescription(minutes ? `${minutes} minute match` : null)
    .setFooter({ text: 'Stats: smite2.live · full match on tracker.gg' })
    .setTimestamp(new Date());

  for (const { player, displayName, perf } of entries) {
    const bits = [
      `**${perf.god_name || '?'}** (${roleName(perf.role)})`,
      kdaLine(perf),
      perf.grade && `${perf.grade}${percentileLabel(perf.percentile_rank)}`,
      perf.win_status ? '🏆 Victory' : '💀 Defeat',
    ].filter(Boolean);
    embed.addFields({
      name: displayName || player.s2l_name || 'Unknown',
      value: bits.join(' · '),
      inline: false,
    });
  }
  embed.addFields({
    name: 'Full match',
    value: `https://tracker.gg/smite2/matches/${matchId}`,
    inline: false,
  });
  return embed;
}

export async function pollSmiteReports(client) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  const players = pollablePlayers();
  if (players.length === 0) return;

  // matchId → [{player, displayName, perf}] so a party's shared match posts once.
  const byMatch = new Map();

  for (const player of players) {
    try {
      const ids = await fetchLatestMatchIds(player.s2l_platform, player.s2l_id, 1);
      const newest = ids[0];
      if (!newest) continue;
      if (!player.last_match_id) {
        // First sighting: remember where "new" starts, don't report history.
        setLastMatch(player.user_id, newest);
        continue;
      }
      if (newest === player.last_match_id) continue;
      setLastMatch(player.user_id, newest);
      if (!player.s2l_profile_id) continue;
      const perf = await fetchPerformance(newest, player.s2l_profile_id);
      const member = await guild.members.fetch(player.user_id).catch(() => null);
      if (!byMatch.has(newest)) byMatch.set(newest, []);
      byMatch.get(newest).push({ player, displayName: member?.displayName, perf });
    } catch (err) {
      logger.warn(`SMITE report poll failed for ${logName(player.user_id)}: ${err.message}`);
    }
  }

  if (byMatch.size === 0) return;
  const channel = findTextChannel(guild, config.smiteChannel);
  if (!channel) return;
  for (const [matchId, entries] of byMatch) {
    await channel.send({ embeds: [reportEmbed(matchId, entries)] });
    logger.info(
      `👁️ SMITE match report: ${entries.map((e) => logName(e.player.user_id)).join(', ')} → ${matchId}`
    );
  }
}

/**
 * Poll smite2.live for freshly finished matches of linked members who are (or
 * were just) in a SMITE session, posting one report per match with each guild
 * member's god, KDA, grade, and result.
 */
export function startSmiteReporter(client) {
  const timer = setInterval(() => {
    pollSmiteReports(client).catch((err) =>
      logger.warn(`SMITE report poll failed: ${err.message}`)
    );
  }, POLL_INTERVAL);
  return () => clearInterval(timer);
}
