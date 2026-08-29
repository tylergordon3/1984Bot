import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { displayName } from '../db/database.js';
import { formatDuration } from '../util/time.js';
import { buildDigest } from '../digest/report.js';
import { recentAwards, standingRecords } from '../milestones/store.js';
import { addPeriodOption, getWindow, baseEmbed } from './_shared.js';

const RECORD_LABELS = {
  'record:voice_session': { name: '🎙️ Longest voice session', format: formatDuration },
  'record:game_session': { name: '🎮 Longest unbroken game session', format: formatDuration },
  'record:message_day': {
    name: '🗣️ Most messages in a day',
    format: (n) => `${Number(n).toLocaleString()} messages`,
  },
};

const digest = {
  data: addPeriodOption(
    new SlashCommandBuilder()
      .setName('digest')
      .setDescription("The Ministry's report on a period — the same one posted on a schedule")
  ),
  async execute(interaction) {
    const window = getWindow(interaction);
    const embed = buildDigest(window, '👁️ Ministry Report');
    if (!embed) {
      await interaction.reply({
        content: 'Nothing to report for that period. Suspiciously quiet.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({ embeds: [embed] });
  },
};

const records = {
  data: new SlashCommandBuilder()
    .setName('records')
    .setDescription('Standing records and the milestones most recently entered on the record'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0xcc0000)
      .setTitle('🏆 The permanent record')
      .setFooter({ text: '1984Bot' })
      .setTimestamp();

    const held = standingRecords();
    if (held.length === 0) {
      embed.setDescription('_No records set yet. Give it time._');
    } else {
      embed.setDescription(
        held
          .map((r) => {
            const label = RECORD_LABELS[r.key];
            if (!label) return null;
            const detail = r.key === 'record:game_session' && r.detail ? ` — *${r.detail}*` : '';
            const on = r.key === 'record:message_day' && r.detail ? ` on ${r.detail}` : '';
            return (
              `**${label.name}**\n` +
              `${label.format(r.value)}${detail} — **${displayName(r.user_id)}**${on}`
            );
          })
          .filter(Boolean)
          .join('\n\n')
      );
    }

    const recent = recentAwards(8).filter((a) => a.kind !== 'record');
    if (recent.length > 0) {
      embed.addFields({
        name: '🗂️ Recently filed',
        value: recent
          .map((a) => `<t:${Math.floor(a.awarded_at / 1000)}:R> — ${summarise(a)}`)
          .join('\n'),
      });
    }
    await interaction.reply({ embeds: [embed] });
  },
};

/** One line describing a stored award, without re-running its check. */
function summarise(a) {
  const who = a.user_id ? `**${displayName(a.user_id)}**` : null;
  switch (a.kind) {
    case 'voice_hours':
      return `${who} — ${a.value} hours in voice`;
    case 'game_hours':
      return `${who} — ${a.value} hours at play`;
    case 'game_title_hours':
      return `${who} — ${a.value} hours in *${a.detail}*`;
    case 'alone_hours':
      return `${who} — ${a.value} hours alone in voice`;
    case 'messages':
      return `${who} — ${Number(a.value).toLocaleString()} messages on file`;
    case 'duo_hours': {
      const [x, y] = String(a.detail || '').split('|');
      return `**${displayName(x)}** + **${displayName(y)}** — ${a.value} hours together`;
    }
    case 'first_game':
      return `First sighting of *${a.detail}*`;
    default:
      return a.detail || a.kind;
  }
}

export default [digest, records];
