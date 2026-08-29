/**
 * Import existing channel history into the messages / message_mentions tables.
 *
 *   node scripts/backfill-messages.js                 # last 90 days
 *   node scripts/backfill-messages.js --days=365
 *   node scripts/backfill-messages.js --all
 *   node scripts/backfill-messages.js --channel=the-resources
 *   node scripts/backfill-messages.js --reactions        # import reactions too
 *
 * Safe to re-run: every insert is INSERT OR IGNORE, keyed on the message id.
 * Historical message *text* only comes back if the MessageContent intent is
 * enabled for the app; tags, authors and timestamps import either way.
 *
 * --reactions also imports who reacted to each message, which costs one API
 * request per emoji per reacted message -- much slower than the message walk,
 * hence opt-in. It reconciles rather than appends, so reactions taken back
 * while the bot was offline are dropped from the database on the next run.
 * Imported reactions are dated to their message, since Discord doesn't record
 * when a reaction was added.
 */
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from '../src/config.js';
import { initDatabase, closeDatabase } from '../src/db/database.js';
import { recordMessage, isTrackedChannel } from '../src/tracking/messageTracker.js';
import { syncMessageReactions } from '../src/tracking/reactionTracker.js';
import { reconcileImportedHistory } from '../src/milestones/baseline.js';
import { DAY } from '../src/util/time.js';

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const days = args.includes('--all') ? Infinity : Number(arg('days') || 90);
const onlyChannel = arg('channel')?.replace(/^#/, '').toLowerCase();
const withReactions = args.includes('--reactions');
const cutoff = days === Infinity ? 0 : Date.now() - days * DAY;

initDatabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    ...(config.messageContent ? [GatewayIntentBits.MessageContent] : []),
  ],
});

client.once(Events.ClientReady, async () => {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    console.error(`Bot is not in guild ${config.guildId}.`);
    return finish(1);
  }
  await guild.members.fetch().catch(() => {});
  await guild.channels.fetchActiveThreads().catch(() => {}); // caches live threads too

  const channels = [...guild.channels.cache.values()].filter((c) => {
    if (!c.isTextBased?.() || !c.viewable) return false;
    if (onlyChannel) return c.name.toLowerCase() === onlyChannel || c.id === onlyChannel;
    return isTrackedChannel(c);
  });

  if (channels.length === 0) {
    console.error('No matching channels found. Check --channel / MESSAGE_CHANNELS.');
    return finish(1);
  }

  console.log(
    `Backfilling ${channels.length} channel(s): ${channels.map((c) => `#${c.name}`).join(', ')}\n` +
      (days === Infinity ? 'Range: all history' : `Range: last ${days} days`) +
      (withReactions ? '\nImporting reactions too (slower: one request per emoji per message)' : '')
  );

  let grandTotal = 0;
  let reactionTotal = 0;
  for (const channel of channels) {
    let before;
    let stored = 0;
    let scanned = 0;
    try {
      for (;;) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
        if (batch.size === 0) break;

        let reachedCutoff = false;
        for (const message of batch.values()) {
          scanned++;
          if (message.createdTimestamp < cutoff) {
            reachedCutoff = true;
            continue;
          }
          if (recordMessage(message)) stored++;
          if (withReactions) reactionTotal += await syncMessageReactions(message);
        }
        before = batch.last().id; // fetch() returns newest-first
        if (reachedCutoff || batch.size < 100) break;
        if (scanned % 1000 === 0) console.log(`  …#${channel.name}: ${scanned} scanned`);
      }
      console.log(`  #${channel.name}: ${stored} new of ${scanned} scanned`);
      grandTotal += stored;
    } catch (err) {
      console.warn(`  #${channel.name}: stopped — ${err.message}`);
    }
  }

  console.log(
    `\n✅ Backfill complete. ${grandTotal} messages imported` +
      (withReactions ? `, ${reactionTotal} reactions.` : '.')
  );

  // Imported history was always true; it just wasn't on file. Bring the
  // milestone tables level with it here, or the bot's next sweep announces the
  // archive as though it had all happened this afternoon.
  const { recorded, updated } = reconcileImportedHistory();
  if (recorded || updated) {
    console.log(
      `   ${recorded} milestone(s) filed as history, ${updated} record(s) updated — none announced.`
    );
  }
  finish(0);
});

function finish(code) {
  closeDatabase();
  client.destroy();
  process.exit(code);
}

client.login(config.token);
