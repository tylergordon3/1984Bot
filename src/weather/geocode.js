// Both NWS and Nominatim ask for an identifying User-Agent on every request.
export const WEATHER_USER_AGENT = '1984Bot (github.com/tylergordon3/1984Bot)';

/**
 * "hillsborough nc" → { lat, lon, label } via OpenStreetMap's Nominatim, or
 * null when nothing matches. US-only, since NWS alerts only cover the US.
 */
export async function geocodePlace(query) {
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': WEATHER_USER_AGENT } });
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);
  const [hit] = await res.json();
  if (!hit) return null;
  return {
    lat: Number(hit.lat).toFixed(4),
    lon: Number(hit.lon).toFixed(4),
    label: hit.display_name,
  };
}

/**
 * What NWS knows the point as ("Hillsborough, NC"), or null when the point is
 * outside NWS coverage — which means it can never produce an alert.
 */
export async function nwsPointLabel(lat, lon) {
  const res = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
    headers: { 'User-Agent': WEATHER_USER_AGENT, Accept: 'application/geo+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`NWS points API returned ${res.status}`);
  const body = await res.json();
  const rel = body.properties?.relativeLocation?.properties;
  return rel ? `${rel.city}, ${rel.state}` : 'unknown NWS area';
}
