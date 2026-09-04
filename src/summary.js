// Location summary: tap a point, get everything known about it in one card.
//
// Modelled on PeakHut's /v1/locations/summary — one call fans out to every
// provider in parallel and returns a single record, with each field carrying
// where it came from. Providers that fail are omitted rather than fatal: a
// card with elevation and no avalanche bulletin still beats no card.

import { cached, TTL } from './cache.js';
import { preciseElevations, pickProvider } from './elevation.js';
import { record } from './provenance.js';

const FT_PER_M = 3.28084;

// ---------- terrain ----------
// Slope and aspect from a 3x3 elevation grid (Horn's method, as used by
// ESRI). The resolver decides both which provider answers and how far apart
// to sample: 30 m against 3DEP, 90 m against Open-Meteo.
async function terrain([lon, lat]) {
  const picked = pickProvider([lon, lat]);
  const step = picked.spacingM;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLat = step / mPerDegLat;
  const dLon = step / mPerDegLon;

  // Rows north → south, columns west → east.
  const grid = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) grid.push([lon + j * dLon, lat - i * dLat]);
  }
  const { values: z, provider, resolutionM } = await preciseElevations(grid);
  const [a, b, c, d, , f, g, h, i] = z;

  const dzdx = (c + 2 * f + i - (a + 2 * d + g)) / (8 * step);
  const dzdy = (g + 2 * h + i - (a + 2 * b + c)) / (8 * step);

  const slopeDeg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

  let aspect = (Math.atan2(dzdy, -dzdx) * 180) / Math.PI;
  if (aspect < 0) aspect = 90 - aspect;
  else if (aspect > 90) aspect = 360 - aspect + 90;
  else aspect = 90 - aspect;

  return {
    elevationFt: z[4] * FT_PER_M,
    slopeDeg,
    // Flat ground has no meaningful aspect.
    aspectDeg: slopeDeg < 1 ? null : aspect % 360,
    demProvider: provider,
    demResolutionM: resolutionM,
    spacingM: step,
  };
}

export const compass = (deg) =>
  ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][
    Math.round(deg / 22.5) % 16
  ];

// Avalanche terrain rule of thumb: most slab avalanches release between 30
// and 45 degrees. Not advice, just the band worth noticing.
export const slopeBand = (deg) =>
  deg >= 30 && deg <= 45 ? 'avy' : deg > 45 ? 'steep' : 'low';

// ---------- weather ----------
const WEATHER_CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorms',
  96: 'Thunderstorms with hail', 99: 'Thunderstorms with hail',
};

async function weather([lon, lat]) {
  const key = `weather:${lon.toFixed(2)},${lat.toFixed(2)}`;
  const hit = await cached(key, TTL.weather, async () => {
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      '&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch' +
      '&timezone=auto&forecast_days=3';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    return res.json();
  });

  record('Weather', {
    provider: 'Open-Meteo',
    detail: 'current + 3 day',
    at: hit.fetchedAt,
    stale: hit.stale,
    fromCache: hit.fromCache,
  });

  const cur = hit.value.current || {};
  const day = hit.value.daily || {};
  return {
    tempF: cur.temperature_2m,
    windMph: cur.wind_speed_10m,
    windDir: cur.wind_direction_10m,
    conditions: WEATHER_CODES[cur.weather_code] || null,
    highF: day.temperature_2m_max?.[0],
    lowF: day.temperature_2m_min?.[0],
    precipIn: day.precipitation_sum?.slice(0, 3),
  };
}

// ---------- active alerts ----------
async function alerts([lon, lat]) {
  const key = `alerts:${lon.toFixed(2)},${lat.toFixed(2)}`;
  const hit = await cached(key, TTL.alerts, async () => {
    const res = await fetch(
      `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`
    );
    if (!res.ok) throw new Error(`NWS ${res.status}`);
    const data = await res.json();
    return (data.features || []).map((f) => ({
      event: f.properties?.event,
      severity: f.properties?.severity,
      headline: f.properties?.headline,
    }));
  });

  record('Alerts', {
    provider: 'NWS',
    detail: hit.value.length ? `${hit.value.length} active` : 'none active',
    at: hit.fetchedAt,
    stale: hit.stale,
    fromCache: hit.fromCache,
  });
  return hit.value;
}

// ---------- avalanche ----------
// CAIC forecast zones, served through the National Avalanche Center API.
// The whole state's zone polygons come in one response, so it is fetched
// once per three hours and the containing zone found locally.
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInFeature(pt, geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  return polys.some(
    // First ring is the outer boundary; the rest are holes.
    (poly) => pointInRing(pt, poly[0]) && !poly.slice(1).some((h) => pointInRing(pt, h))
  );
}

async function avalanche(pt) {
  const hit = await cached('avalanche:CAIC', TTL.avalanche, async () => {
    const res = await fetch('https://api.avalanche.org/v2/public/products/map-layer/CAIC');
    if (!res.ok) throw new Error(`CAIC ${res.status}`);
    return res.json();
  });

  const zone = (hit.value.features || []).find((f) => f.geometry && pointInFeature(pt, f.geometry));

  record('Avalanche', {
    provider: 'CAIC',
    detail: zone ? zone.properties?.name : 'outside CAIC zones',
    at: hit.fetchedAt,
    stale: hit.stale,
    fromCache: hit.fromCache,
  });

  if (!zone) return null;
  const p = zone.properties || {};
  return {
    zone: p.name,
    level: p.danger_level,
    danger: p.danger,
    advice: p.travel_advice,
    color: p.color,
    warning: p.warning?.product ? p.warning.title : null,
    offSeason: p.danger_level === -1 || p.danger === 'no rating',
  };
}

// ---------- the summary ----------
// Every provider runs in parallel and failures degrade to null.
export async function locationSummary(pt) {
  const settle = (p) => p.catch(() => null);
  const [t, w, al, av] = await Promise.all([
    settle(terrain(pt)),
    settle(weather(pt)),
    settle(alerts(pt)),
    settle(avalanche(pt)),
  ]);
  return { point: pt, terrain: t, weather: w, alerts: al, avalanche: av };
}
