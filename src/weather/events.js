// Presentation for NWS event types, shared by the alert watcher and the
// /weather map command so a tornado warning is the same red everywhere.

const STYLES = {
  'tornado warning': { emoji: '🌪️', color: 0xe74c3c, rank: 100 },
  'tornado watch': { emoji: '🌪️', color: 0xf1c40f, rank: 80 },
  'severe thunderstorm warning': { emoji: '⛈️', color: 0xe67e22, rank: 90 },
  'severe thunderstorm watch': { emoji: '⛈️', color: 0xf1c40f, rank: 70 },
  'flash flood warning': { emoji: '🌊', color: 0x27ae60, rank: 85 },
  'flash flood watch': { emoji: '🌊', color: 0x2ecc71, rank: 65 },
  'flood warning': { emoji: '🌊', color: 0x16a085, rank: 60 },
  'flood watch': { emoji: '🌊', color: 0x1abc9c, rank: 50 },
  'winter storm warning': { emoji: '❄️', color: 0x8e44ad, rank: 75 },
  'winter storm watch': { emoji: '❄️', color: 0x9b59b6, rank: 55 },
  'high wind warning': { emoji: '💨', color: 0xd35400, rank: 45 },
  'wind advisory': { emoji: '💨', color: 0xe1a95f, rank: 25 },
  'extreme heat warning': { emoji: '🥵', color: 0xc0392b, rank: 40 },
  'heat advisory': { emoji: '🥵', color: 0xe74c3c, rank: 20 },
  'special weather statement': { emoji: '📢', color: 0x7f8c8d, rank: 15 },
};

const DEFAULT_STYLE = { emoji: '⚠️', color: 0x95a5a6, rank: 10 };

/** Emoji / embed colour / sort rank for an NWS event name. */
export function styleFor(event) {
  return STYLES[String(event || '').toLowerCase()] || DEFAULT_STYLE;
}

/** Most severe first, so the headline alert leads a multi-alert map. */
export function bySeverity(a, b) {
  return styleFor(b.properties?.event).rank - styleFor(a.properties?.event).rank;
}

/** 0xRRGGBB → [r, g, b], for the map renderer. */
export function rgbOf(color) {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}
