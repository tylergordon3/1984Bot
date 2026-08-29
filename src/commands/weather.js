import { AttachmentBuilder, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { rememberUser } from '../db/database.js';
import { logger } from '../util/logger.js';
import { fetchActiveAlerts } from '../weather/alerts.js';
import { styleFor, rgbOf, bySeverity } from '../weather/events.js';
import { ringsForAlert } from '../weather/geometry.js';
import { renderMap, mapCredit } from '../weather/map.js';
import { config } from '../config.js';
import { geocodePlace, nwsPointLabel } from '../weather/geocode.js';
import {
  listLocations,
  getLocation,
  addLocation,
  removeLocation,
  subscribe,
  unsubscribe,
  subscriberIds,
} from '../weather/store.js';

const EMBED_COLOR = 0x5865f2;
const CLEAR_COLOR = 0x2ecc71;
// One reply, so: at most this many locations get a map, each showing at most
// this many overlapping alerts.
const MAX_MAPS = 3;
const MAX_LAYERS = 6;

function addPlaceOption(sub, description) {
  return sub.addStringOption((o) =>
    o.setName('place').setDescription(description).setRequired(true).setAutocomplete(true)
  );
}

const weather = {
  data: new SlashCommandBuilder()
    .setName('weather')
    .setDescription('Severe weather alerts: watched locations and who gets pinged')
    .addSubcommand((sub) =>
      addPlaceOption(
        sub.setName('add').setDescription('Watch a new place (you get subscribed automatically)'),
        'Place name, e.g. "Hillsborough NC" — or any US town/address'
      )
        .addNumberOption((o) =>
          o.setName('lat').setDescription('Latitude, if you want to skip place-name lookup').setMinValue(-90).setMaxValue(90)
        )
        .addNumberOption((o) =>
          o.setName('lon').setDescription('Longitude, if you want to skip place-name lookup').setMinValue(-180).setMaxValue(180)
        )
    )
    .addSubcommand((sub) =>
      addPlaceOption(
        sub.setName('remove').setDescription('Stop watching a place entirely (for everyone)'),
        'Which watched place to remove'
      )
    )
    .addSubcommand((sub) =>
      addPlaceOption(
        sub.setName('subscribe').setDescription('Get pinged when a place has severe weather'),
        'Which watched place'
      ).addUserOption((o) =>
        o.setName('user').setDescription('Subscribe someone else (defaults to you)')
      )
    )
    .addSubcommand((sub) =>
      addPlaceOption(
        sub.setName('unsubscribe').setDescription('Stop getting pinged for a place'),
        'Which watched place'
      ).addUserOption((o) =>
        o.setName('user').setDescription('Unsubscribe someone else (defaults to you)')
      )
    )
    .addSubcommand((sub) =>
      sub
        .setName('map')
        .setDescription('Map the watches and warnings in effect right now')
        .addStringOption((o) =>
          o
            .setName('place')
            .setDescription('Which watched place (default: all of them)')
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Show all watched places and their subscribers')
    ),

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const names = listLocations()
      .map((l) => l.name)
      .filter((n) => n.toLowerCase().includes(typed))
      .slice(0, 25);
    await interaction.respond(names.map((n) => ({ name: n, value: n })));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') return execAdd(interaction);
    if (sub === 'remove') return execRemove(interaction);
    if (sub === 'subscribe') return execSubscribe(interaction, true);
    if (sub === 'unsubscribe') return execSubscribe(interaction, false);
    if (sub === 'map') return execMap(interaction);
    return execList(interaction);
  },
};

async function execAdd(interaction) {
  const place = interaction.options.getString('place').trim();
  if (getLocation(place)) {
    return interaction.reply({
      content: `**${place}** is already watched — \`/weather subscribe\` to get pinged for it.`,
      ephemeral: true,
    });
  }

  // Geocoding + NWS verification are two network hops; buy time.
  await interaction.deferReply();

  let lat = interaction.options.getNumber('lat');
  let lon = interaction.options.getNumber('lon');
  if (lat == null || lon == null) {
    const hit = await geocodePlace(place);
    if (!hit) {
      return interaction.editReply(
        `Couldn't find **${place}** on the map. Try "Town ST" (e.g. "Sykesville MD"), ` +
          `or pass \`lat\`/\`lon\` directly.`
      );
    }
    ({ lat, lon } = hit);
  } else {
    lat = lat.toFixed(4);
    lon = lon.toFixed(4);
  }

  const nwsLabel = await nwsPointLabel(lat, lon);
  if (!nwsLabel) {
    return interaction.editReply(
      `**${place}** resolved to ${lat}, ${lon}, but the National Weather Service has no ` +
        `coverage there — no alerts would ever fire. (NWS covers the US and its territories.)`
    );
  }

  addLocation(place, lat, lon, interaction.user.id);
  subscribe(place, interaction.user.id);
  rememberUser(interaction.user.id, interaction.user.username);

  return interaction.editReply(
    `👁️ Now watching **${place}** (NWS knows it as **${nwsLabel}**, ${lat}, ${lon}). ` +
      `You're subscribed — severe thunderstorm and tornado warnings will ping you ` +
      `here, with a map of the warned area. ` +
      `Others can join with \`/weather subscribe\`.`
  );
}

async function execRemove(interaction) {
  const place = interaction.options.getString('place').trim();
  const location = getLocation(place);
  if (!location) {
    return interaction.reply({ content: noSuchPlace(place), ephemeral: true });
  }
  removeLocation(location.name);
  return interaction.reply(
    `🗑️ No longer watching **${location.name}** — its subscribers won't be pinged again.`
  );
}

async function execSubscribe(interaction, joining) {
  const place = interaction.options.getString('place').trim();
  const target = interaction.options.getUser('user') || interaction.user;
  const location = getLocation(place);
  if (!location) {
    return interaction.reply({ content: noSuchPlace(place), ephemeral: true });
  }
  rememberUser(target.id, target.username);

  const you = target.id === interaction.user.id;
  const who = you ? 'You' : `<@${target.id}>`;
  if (joining) {
    const changed = subscribe(location.name, target.id);
    return interaction.reply(
      changed
        ? `🔔 ${who} will now be pinged for severe weather in **${location.name}**.`
        : `${who} ${you ? 'are' : 'is'} already subscribed to **${location.name}**.`
    );
  }
  const changed = unsubscribe(location.name, target.id);
  return interaction.reply(
    changed
      ? `🔕 ${who} won't be pinged for **${location.name}** anymore.`
      : `${who} ${you ? "weren't" : "wasn't"} subscribed to **${location.name}**.`
  );
}

/** Alerts that haven't already expired, worst first. */
function liveAlerts(features) {
  const now = Date.now();
  return features
    .filter((f) => {
      const until = f.properties?.expires || f.properties?.ends;
      return !until || new Date(until).getTime() >= now;
    })
    .sort(bySeverity);
}

function describeAlert(feature) {
  const props = feature.properties || {};
  const style = styleFor(props.event);
  const until = props.expires || props.ends;
  const when = until ? ` — until <t:${Math.floor(new Date(until).getTime() / 1000)}:R>` : '';
  return `${style.emoji} **${props.event}**${when}`;
}

/** One embed per location: every active alert area drawn on a single map. */
async function mapLocation(location, alerts, index) {
  const embed = new EmbedBuilder()
    .setColor(styleFor(alerts[0].properties?.event).color)
    .setTitle(`🗺️ In effect now — ${location.name}`)
    .setDescription(alerts.slice(0, 10).map(describeAlert).join('\n'));

  const layers = [];
  // Reversed: the least severe alert is drawn first, so the worst one's
  // outline ends up on top of the pile rather than buried under a watch.
  for (const feature of alerts.slice(0, MAX_LAYERS).reverse()) {
    const rings = await ringsForAlert(feature);
    if (rings.length > 0) layers.push({ rings, rgb: rgbOf(styleFor(feature.properties?.event).color) });
  }

  let map = null;
  try {
    map = await renderMap({
      layers,
      marker: [Number(location.lon), Number(location.lat)],
      radar: config.weatherRadar,
    });
  } catch (err) {
    logger.warn(`Weather map render failed for ${location.name}: ${err.message}`);
  }
  if (!map) {
    embed.setFooter({ text: 'Source: NWS (no map available for these alerts)' });
    return { embed, file: null };
  }

  const name = `alerts-${index}.png`;
  embed.setImage(`attachment://${name}`).setFooter({ text: `Source: NWS${mapCredit(map)}` });
  return { embed, file: new AttachmentBuilder(map.png, { name }) };
}

async function execMap(interaction) {
  const place = interaction.options.getString('place')?.trim();
  const locations = place ? [getLocation(place)].filter(Boolean) : listLocations();
  if (locations.length === 0) {
    return interaction.reply({
      content: place ? noSuchPlace(place) : 'Nothing is watched yet — `/weather add` a place first.',
      ephemeral: true,
    });
  }

  // An NWS round-trip per location, plus tiles per map.
  await interaction.deferReply();

  const checked = [];
  for (const location of locations) {
    try {
      checked.push({ location, alerts: liveAlerts(await fetchActiveAlerts(location)) });
    } catch (err) {
      checked.push({ location, alerts: [], error: err.message });
    }
  }

  const unreachable = checked.filter((c) => c.error).map((c) => `**${c.location.name}**`);
  const note = unreachable.length
    ? `\n⚠️ Couldn't reach the National Weather Service for ${unreachable.join(', ')}.`
    : '';

  const hot = checked.filter((c) => c.alerts.length > 0);
  if (hot.length === 0) {
    const names = checked.map((c) => `**${c.location.name}**`).join(', ');
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(CLEAR_COLOR)
          .setTitle('☀️ All clear')
          .setDescription(`No watches or warnings in effect for ${names}.${note}`),
      ],
    });
  }

  const embeds = [];
  const files = [];
  for (const [i, { location, alerts }] of hot.slice(0, MAX_MAPS).entries()) {
    const { embed, file } = await mapLocation(location, alerts, i);
    embeds.push(embed);
    if (file) files.push(file);
  }

  const overflow = hot.length - embeds.length;
  const content =
    (overflow > 0
      ? `_…and alerts for ${hot.slice(MAX_MAPS).map((c) => `**${c.location.name}**`).join(', ')}._`
      : '') + note;

  return interaction.editReply({ content: content || undefined, embeds, files });
}

async function execList(interaction) {
  const locations = listLocations();
  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle('👁️ Watched weather locations');

  if (locations.length === 0) {
    embed.setDescription('_Nothing is watched yet. `/weather add` a place to start._');
  } else {
    embed.setDescription(
      locations
        .map((l) => {
          const subs = subscriberIds(l.name).map((id) => `<@${id}>`);
          return (
            `**${l.name}** — ${l.lat}, ${l.lon}\n` +
            `↳ pings: ${subs.length ? subs.join(', ') : '_nobody yet_'}`
          );
        })
        .join('\n\n')
    );
  }
  return interaction.reply({ embeds: [embed] });
}

function noSuchPlace(place) {
  const names = listLocations().map((l) => `**${l.name}**`);
  return (
    `**${place}** isn't a watched place. ` +
    (names.length ? `Currently watching: ${names.join(', ')}.` : 'Nothing is watched yet.') +
    ' Use `/weather add` to watch somewhere new.'
  );
}

export default [weather];
