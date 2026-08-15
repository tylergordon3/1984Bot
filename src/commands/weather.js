import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { rememberUser } from '../db/database.js';
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
      `You're subscribed — severe thunderstorm and tornado warnings will ping you here. ` +
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
