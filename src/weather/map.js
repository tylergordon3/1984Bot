// A PNG map of an alert's area: NEXRAD radar over OpenStreetMap tiles, with
// the alert polygons and the watched location drawn on top.
//
// Discord won't render SVG, and a native image library is a miserable thing to
// build on a Raspberry Pi, so the map is composited here by hand: fetch the
// slippy-map tiles covering the alert, decode them with pngjs, draw the alert
// polygons and the watched location on top, re-encode. Roughly a dozen tile
// requests per map, cached, which sits comfortably inside OSM's tile policy —
// attribution goes in the embed footer.

import { PNG } from 'pngjs';
import { logger } from '../util/logger.js';
import { MINUTE, DAY } from '../util/time.js';
import { WEATHER_USER_AGENT } from './geocode.js';

const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 13;
const TILE_TIMEOUT = 8000;
const TILE_BATCH = 6;
const TILE_CACHE_MAX = 384;

const WIDTH = 800;
const HEIGHT = 560;
const BACKGROUND = [0xe8, 0xe6, 0xe1]; // OSM's land colour, for tiles that fail

// Tile layers, drawn in this order. Radar tiles are binary-alpha — every pixel
// is either an echo or fully clear — so a flat opacity composites cleanly over
// the basemap without washing the roads out.
const BASEMAP = {
  id: 'osm',
  url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  ttl: DAY, // street layout doesn't move
  opacity: 1,
};
const RADAR = {
  id: 'n0q',
  // NEXRAD base reflectivity composite, re-rendered roughly every 5 minutes.
  // Outside radar coverage the tiles come back clear, which is exactly the
  // right behaviour: no echo drawn, and no radar credited in the footer.
  url: (z, x, y) =>
    `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/${z}/${x}/${y}.png`,
  ttl: 4 * MINUTE,
  opacity: 0.55,
};

// Keyed "layer/z/x/y" → { buf, at }. Tiles are held *encoded*: decoded, a
// 256px tile is 256 KB of RGBA, and a few hundred of those is real memory on a
// Pi. Re-decoding on each use costs a millisecond or two against a network
// round trip, which is no contest.
const tileCache = new Map();

// ── projection ──────────────────────────────────────────────────────────

const MAX_LAT = 85.05112878; // where the Mercator projection runs to infinity

function worldX(lon, scale) {
  return ((lon + 180) / 360) * scale;
}

function worldY(lat, scale) {
  const rad = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
}

/**
 * The closest zoom at which the bounds still fit the canvas. Canvas size is
 * fixed, so this also fixes the tile count at ~20 requests per map.
 */
function pickZoom(bounds, width, height) {
  for (let z = MAX_ZOOM; z > MIN_ZOOM; z--) {
    const scale = TILE * 2 ** z;
    const w = worldX(bounds.east, scale) - worldX(bounds.west, scale);
    const h = worldY(bounds.south, scale) - worldY(bounds.north, scale);
    if (w <= width && h <= height) return z;
  }
  return MIN_ZOOM;
}

function boundsOf(points) {
  const b = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  for (const [lon, lat] of points) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    b.west = Math.min(b.west, lon);
    b.east = Math.max(b.east, lon);
    b.south = Math.min(b.south, lat);
    b.north = Math.max(b.north, lat);
  }
  if (!Number.isFinite(b.west)) return null;
  // Pad so the shape never touches the frame, with a floor for point-sized areas.
  const padX = Math.max((b.east - b.west) * 0.18, 0.05);
  const padY = Math.max((b.north - b.south) * 0.18, 0.04);
  return {
    west: b.west - padX,
    east: b.east + padX,
    south: b.south - padY,
    north: b.north + padY,
  };
}

// ── tiles ───────────────────────────────────────────────────────────────

function decode(key, buf) {
  if (!buf) return null;
  try {
    return PNG.sync.read(buf);
  } catch (err) {
    logger.debug(`Weather map: tile ${key} did not decode — ${err.message}`);
    return null;
  }
}

async function fetchTile(layer, z, x, y) {
  const key = `${layer.id}/${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached && Date.now() - cached.at < layer.ttl) {
    tileCache.delete(key); // re-insert: plain LRU on Map insertion order
    tileCache.set(key, cached);
    return decode(key, cached.buf);
  }

  let buf = null;
  try {
    const res = await fetch(layer.url(z, x, y), {
      headers: { 'User-Agent': WEATHER_USER_AGENT },
      signal: AbortSignal.timeout(TILE_TIMEOUT),
    });
    if (res.ok) buf = Buffer.from(await res.arrayBuffer());
    else logger.debug(`Weather map: tile ${key} returned ${res.status}`);
  } catch (err) {
    logger.debug(`Weather map: tile ${key} failed — ${err.message}`);
    // A stale radar frame beats a hole in the map, and a timeout isn't worth
    // caching as a permanent one.
    return decode(key, cached?.buf);
  }

  tileCache.set(key, { buf, at: Date.now() });
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return decode(key, buf);
}

/**
 * Paint one tile layer at the given canvas origin (in world pixels). Returns
 * the number of pixels it actually touched, so the caller can tell a radar
 * layer that drew echo from one that had nothing to say.
 */
async function drawTileLayer(canvas, layer, z, originX, originY, width, height) {
  const span = 2 ** z;
  const jobs = [];
  for (let ty = Math.floor(originY / TILE); ty * TILE < originY + height; ty++) {
    if (ty < 0 || ty >= span) continue;
    for (let tx = Math.floor(originX / TILE); tx * TILE < originX + width; tx++) {
      jobs.push({ tx, ty, dx: Math.round(tx * TILE - originX), dy: Math.round(ty * TILE - originY) });
    }
  }

  let painted = 0;
  for (let i = 0; i < jobs.length; i += TILE_BATCH) {
    const batch = jobs.slice(i, i + TILE_BATCH);
    const tiles = await Promise.all(
      batch.map((j) => fetchTile(layer, z, ((j.tx % span) + span) % span, j.ty))
    );
    tiles.forEach((tile, n) => {
      if (tile) painted += blit(canvas, width, height, tile, batch[n].dx, batch[n].dy, layer.opacity);
    });
  }
  return painted;
}

/** Composite a tile, honouring its alpha channel. Returns pixels touched. */
function blit(canvas, width, height, tile, dx, dy, opacity) {
  let painted = 0;
  for (let y = 0; y < tile.height; y++) {
    const cy = dy + y;
    if (cy < 0 || cy >= height) continue;
    for (let x = 0; x < tile.width; x++) {
      const cx = dx + x;
      if (cx < 0 || cx >= width) continue;
      const src = (y * tile.width + x) * 4;
      const alpha = (tile.data[src + 3] / 255) * opacity;
      if (alpha <= 0) continue;
      blend(canvas, (cy * width + cx) * 4, [tile.data[src], tile.data[src + 1], tile.data[src + 2]], alpha);
      painted += 1;
    }
  }
  return painted;
}

// ── drawing ─────────────────────────────────────────────────────────────

function blend(canvas, idx, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  canvas[idx] = canvas[idx] * (1 - a) + r * a;
  canvas[idx + 1] = canvas[idx + 1] * (1 - a) + g * a;
  canvas[idx + 2] = canvas[idx + 2] * (1 - a) + b * a;
}

/** Even-odd scanline fill, so rings that are holes punch through correctly. */
function fillRings(canvas, width, height, rings, rgb, alpha) {
  let top = Infinity;
  let bottom = -Infinity;
  for (const ring of rings) {
    for (const [, y] of ring) {
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (!Number.isFinite(top)) return;

  const xs = [];
  for (let y = Math.max(0, Math.ceil(top)); y <= Math.min(height - 1, Math.floor(bottom)); y++) {
    const scan = y + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % ring.length];
        if (ay <= scan === by <= scan) continue; // segment doesn't cross this row
        xs.push(ax + ((scan - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
      const row = y * width;
      for (let x = from; x <= to; x++) blend(canvas, (row + x) * 4, rgb, alpha);
    }
  }
}

/** A soft-edged disc — the brush for both outlines and the location marker. */
function disc(canvas, width, height, cx, cy, radius, rgb, alpha) {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - d));
      if (coverage > 0) blend(canvas, (y * width + x) * 4, rgb, alpha * coverage);
    }
  }
}

function strokeRings(canvas, width, height, rings, rgb, alpha, radius) {
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      // Skip segments wholly off the same side of the canvas: a statewide
      // shape can run thousands of pixels past the frame.
      if ((ax < 0 && bx < 0) || (ax > width && bx > width)) continue;
      if ((ay < 0 && by < 0) || (ay > height && by > height)) continue;
      const steps = Math.min(4000, Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2)));
      for (let s = 0; s <= steps; s++) {
        disc(canvas, width, height, ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, radius, rgb, alpha);
      }
    }
  }
}

function drawMarker(canvas, width, height, x, y) {
  disc(canvas, width, height, x, y, 8, [255, 255, 255], 1);
  disc(canvas, width, height, x, y, 6, [26, 32, 44], 1);
  disc(canvas, width, height, x, y, 3, [255, 255, 255], 1);
}

// ── entry point ─────────────────────────────────────────────────────────

/** Footer attribution for whichever tile layers actually made it onto the map. */
export function mapCredit(map) {
  if (!map) return '';
  return ` · Map © OpenStreetMap contributors${map.radar ? ', radar Iowa State Mesonet' : ''}`;
}

/**
 * Render a map PNG. `layers` are `{ rings, rgb }` in draw order (least severe
 * first, so the headline alert sits on top); `marker` is an optional
 * `[lon, lat]` for the watched location; `radar` overlays NEXRAD reflectivity
 * under the polygons. Returns `{ png, radar }` — `radar` says whether any echo
 * actually made it onto the image, so the caller only credits the source when
 * there was something to show. Returns null when there is nothing to draw at
 * all: a map is a nicety, and callers post the alert regardless.
 */
export async function renderMap({ layers, marker, radar = false, width = WIDTH, height = HEIGHT }) {
  const drawable = (layers || []).filter((l) => l.rings?.length > 0);
  if (drawable.length === 0) return null;

  const points = drawable.flatMap((l) => l.rings.flat());
  if (marker) points.push(marker);
  const bounds = boundsOf(points);
  if (!bounds) return null;

  const zoom = pickZoom(bounds, width, height);
  const scale = TILE * 2 ** zoom;
  const centerX = (worldX(bounds.west, scale) + worldX(bounds.east, scale)) / 2;
  const centerY = (worldY(bounds.north, scale) + worldY(bounds.south, scale)) / 2;
  const originX = centerX - width / 2;
  const originY = centerY - height / 2;

  const canvas = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    canvas[i * 4] = BACKGROUND[0];
    canvas[i * 4 + 1] = BACKGROUND[1];
    canvas[i * 4 + 2] = BACKGROUND[2];
    canvas[i * 4 + 3] = 255;
  }

  await drawTileLayer(canvas, BASEMAP, zoom, originX, originY, width, height);
  // Radar goes under the polygons, so a warning box stays readable over a
  // storm core. A failure here costs the echo, never the map.
  let echo = 0;
  if (radar) {
    echo = await drawTileLayer(canvas, RADAR, zoom, originX, originY, width, height).catch((err) => {
      logger.warn(`Weather map: radar layer failed — ${err.message}`);
      return 0;
    });
  }

  const toCanvas = ([lon, lat]) => [worldX(lon, scale) - originX, worldY(lat, scale) - originY];
  for (const layer of drawable) {
    const rings = layer.rings.map((ring) => ring.map(toCanvas));
    fillRings(canvas, width, height, rings, layer.rgb, 0.25);
    strokeRings(canvas, width, height, rings, [255, 255, 255], 0.8, 3);
    strokeRings(canvas, width, height, rings, layer.rgb, 1, 1.6);
  }
  if (marker) {
    const [mx, my] = toCanvas(marker);
    drawMarker(canvas, width, height, mx, my);
  }

  const png = new PNG({ width, height });
  png.data = Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  return { png: PNG.sync.write(png), radar: echo > 0 };
}
