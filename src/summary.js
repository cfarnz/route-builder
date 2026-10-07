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

// ---------- air quality ----------
// Wildfire smoke is the mountain-west air quality story, and it runs on a
// daily cycle: smoke settles into valleys overnight and lifts through the
// morning. A single current number cannot say that, so the forecast hours
// matter as much as the reading.
//
// Open-Meteo's air-quality endpoint is a separate host from the forecast API
// but the same keyless contract. US AQI is precomputed by the provider rather
// than derived here, since the EPA breakpoint math is piecewise per pollutant
// and getting it subtly wrong is worse than not showing it.

// EPA AQI categories. Colors are the published EPA swatches, which people
// already recognise from purpleair and airnow, so this is one of the few
// places worth leaving the design system alone.
const AQI_BANDS = [
  { max: 50, label: 'Good', color: '#00e400', advice: null },
  { max: 100, label: 'Moderate', color: '#ffff00', advice: 'Fine for most. Unusually sensitive people may want an easier effort.' },
  { max: 150, label: 'Unhealthy for sensitive groups', color: '#ff7e00', advice: 'Hard efforts will feel it. Asthma and heart conditions should back off.' },
  { max: 200, label: 'Unhealthy', color: '#ff0000', advice: 'Everyone feels this on a climb. Shorten it or move it.' },
  { max: 300, label: 'Very unhealthy', color: '#8f3f97', advice: 'Not a day to train outside.' },
  { max: Infinity, label: 'Hazardous', color: '#7e0023', advice: 'Stay inside.' },
];

export const aqiBand = (aqi) =>
  aqi === null || aqi === undefined ? null : AQI_BANDS.find((b) => aqi <= b.max);

// Look ahead for a meaningfully different reading. Smoke that clears by noon
// is the useful fact; a flat curve is not worth a line in the card.
function aqiTrend(hours = [], startIdx = 0) {
  const next = hours.slice(startIdx, startIdx + 12).filter((v) => v !== null);
  if (next.length < 4) return null;
  const now = next[0];
  const best = Math.min(...next);
  const worst = Math.max(...next);
  if (worst - now >= 20) return { dir: 'worsening', value: worst, hours: next.indexOf(worst) };
  if (now - best >= 20) return { dir: 'improving', value: best, hours: next.indexOf(best) };
  return null;
}

async function airQuality([lon, lat]) {
  const key = `air:${lon.toFixed(2)},${lat.toFixed(2)}`;
  const hit = await cached(key, TTL.air, async () => {
    const url =
      'https://air-quality-api.open-meteo.com/v1/air-quality' +
      `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      '&current=us_aqi,pm2_5' +
      '&hourly=us_aqi' +
      '&forecast_days=2&timezone=auto';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo air quality ${res.status}`);
    return res.json();
  });

  record('Air quality', {
    provider: 'Open-Meteo (CAMS)',
    detail: 'US AQI + PM2.5',
    at: hit.fetchedAt,
    stale: hit.stale,
    fromCache: hit.fromCache,
  });

  const cur = hit.value.current || {};
  if (cur.us_aqi === null || cur.us_aqi === undefined) return null;

  // Align the forecast to the hour the current reading came from, so a cached
  // response does not report a trend that already happened.
  const times = hit.value.hourly?.time || [];
  const idx = Math.max(0, times.indexOf(cur.time));

  return {
    aqi: Math.round(cur.us_aqi),
    pm25: cur.pm2_5,
    trend: aqiTrend(hit.value.hourly?.us_aqi, idx),
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
  const [t, w, aq, al, av] = await Promise.all([
    settle(terrain(pt)),
    settle(weather(pt)),
    settle(airQuality(pt)),
    settle(alerts(pt)),
    settle(avalanche(pt)),
  ]);
  return { point: pt, terrain: t, weather: w, air: aq, alerts: al, avalanche: av };
}
