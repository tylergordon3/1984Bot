// Turning an NWS alert into drawable rings.
//
// Storm-based products (tornado / severe thunderstorm warnings) carry their
// polygon inline. County- and zone-based products — which is most watches —
// carry only a list of zone URLs, so the shape has to be fetched. Zone
// boundaries never change, so they're cached for the life of the process.

import { logger } from '../util/logger.js';
import { WEATHER_USER_AGENT } from './geocode.js';

const MAX_ZONES = 40; // a big watch can span every county in a state
const ZONE_BATCH = 6;
const FETCH_TIMEOUT = 8000;

const zoneCache = new Map(); // zone url → rings (possibly [])

/** Flatten any GeoJSON geometry into a flat list of [lon, lat] rings. */
export function ringsOfGeometry(geometry) {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'Polygon':
      return geometry.coordinates;
    case 'MultiPolygon':
      return geometry.coordinates.flat();
    case 'GeometryCollection':
      return (geometry.geometries || []).flatMap(ringsOfGeometry);
    default:
      return [];
  }
}

async function fetchZoneRings(url) {
  if (zoneCache.has(url)) return zoneCache.get(url);
  let rings = [];
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': WEATHER_USER_AGENT, Accept: 'application/geo+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (res.ok) rings = ringsOfGeometry((await res.json()).geometry);
    else logger.debug(`Weather map: zone ${url} returned ${res.status}`);
  } catch (err) {
    logger.debug(`Weather map: zone ${url} failed — ${err.message}`);
    return rings; // don't cache a transient failure
  }
  zoneCache.set(url, rings);
  return rings;
}

/**
 * The rings covering one alert's area: its own polygon when it has one,
 * otherwise the outlines of every zone it names. Returns [] when the shape
 * can't be determined — the caller draws no map rather than a wrong one.
 */
export async function ringsForAlert(feature) {
  const inline = ringsOfGeometry(feature.geometry);
  if (inline.length > 0) return inline;

  const zones = (feature.properties?.affectedZones || []).slice(0, MAX_ZONES);
  const rings = [];
  for (let i = 0; i < zones.length; i += ZONE_BATCH) {
    const batch = await Promise.all(zones.slice(i, i + ZONE_BATCH).map(fetchZoneRings));
    for (const r of batch) rings.push(...r);
  }
  return rings;
}
