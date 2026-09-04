// Elevation providers, and the resolver that picks between them.
//
// Borrowed from PeakHut: which provider answers depends on where the point
// is and what the caller needs.
//
//   USGS 3DEP    1 m, US only, one point per request  → summary cards
//   Open-Meteo  ~90 m, global, 100 points per request → routes and Discover
//
// A route samples thousands of points and needs them fast. A summary card
// samples nine and needs them right. Same data, different answer.

import { getPoint, setPoints } from './cache.js';
import { record } from './provenance.js';

const OPEN_METEO = 'https://api.open-meteo.com/v1/elevation';
const EPQS = 'https://epqs.nationalmap.gov/v1/json';
const OM_BATCH = 100; // Open-Meteo's per-request coordinate limit
const USGS_CONCURRENCY = 6; // EPQS is one point per call, so parallelise

// Cache grids, in units of 1/degree. Coarse rounds to ~11 m, well under
// Open-Meteo's source resolution. Fine rounds to ~1 m to match 3DEP.
const COARSE = 1e4;
const FINE = 1e5;

// ---------- coverage ----------
// 3DEP coverage as bounding boxes. This is the one place geography lives;
// everything else asks the resolver rather than testing coordinates itself.
const USGS_BOUNDS = [
  [-125.0, 24.0, -66.5, 49.5], // contiguous US
  [-170.0, 51.0, -129.0, 72.0], // Alaska
  [-161.0, 18.0, -154.0, 23.0], // Hawaii
];

const inUSGS = ([lon, lat]) =>
  USGS_BOUNDS.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n);

// Which provider answers a precision request here, and how far apart to
// sample when deriving slope from it. Sampling much tighter than the source
// invents detail that isn't there; much wider smooths real terrain away.
export function pickProvider(pt) {
  return inUSGS(pt)
    ? { name: 'USGS 3DEP', resolutionM: 1, spacingM: 30 }
    : { name: 'Open-Meteo', resolutionM: 90, spacingM: 90 };
}

// ---------- cache keys ----------
// Namespaced per provider: a 90 m answer and a 1 m answer for the same
// ground are different numbers and must not satisfy each other's lookups.
const coarseKey = ([lon, lat]) => `${Math.round(lon * COARSE)},${Math.round(lat * COARSE)}`;
const fineKey = ([lon, lat]) => `u:${Math.round(lon * FINE)},${Math.round(lat * FINE)}`;

// ---------- fetchers ----------
async function fetchOpenMeteoBatch(pts) {
  const lats = pts.map((p) => p[1].toFixed(5)).join(',');
  const lons = pts.map((p) => p[0].toFixed(5)).join(',');
  const res = await fetch(`${OPEN_METEO}?latitude=${lats}&longitude=${lons}`);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const { elevation } = await res.json();
  return elevation || [];
}

async function fetchUsgsPoint([lon, lat]) {
  const res = await fetch(
    `${EPQS}?x=${lon.toFixed(6)}&y=${lat.toFixed(6)}&units=Meters&wkid=4326&includeDate=false`
  );
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  const v = parseFloat((await res.json()).value);
  // EPQS reports no-data as a large negative sentinel rather than an error.
  if (!Number.isFinite(v) || v < -1000) throw new Error('USGS no data');
  return v;
}

// Run fn over items with a concurrency cap. Failures resolve to undefined
// so one dead point does not sink the batch.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- bulk path ----------
// Elevations in metres for a list of [lon, lat], same order. Terrain does
// not change, so every point ever looked up stays reusable. Missing points
// resolve to 0 rather than throwing: a route with one bad sample is still a
// usable route.
export async function elevations(pts) {
  const keys = pts.map(coarseKey);
  const out = new Array(pts.length);
  const missing = new Map(); // key -> pt, deduped by grid cell

  keys.forEach((k, i) => {
    const v = getPoint(k);
    if (v === undefined) missing.set(k, pts[i]);
    else out[i] = v;
  });

  let fetched = 0;
  let failed = false;
  const need = [...missing.entries()];

  for (let i = 0; i < need.length; i += OM_BATCH) {
    const chunk = need.slice(i, i + OM_BATCH);
    try {
      const eles = await fetchOpenMeteoBatch(chunk.map(([, p]) => p));
      const fresh = {};
      chunk.forEach(([k], j) => {
        if (typeof eles[j] === 'number') fresh[k] = eles[j];
      });
      setPoints(fresh);
      fetched += Object.keys(fresh).length;
    } catch {
      failed = true; // partial results are fine; gaps fall back to 0
    }
  }

  keys.forEach((k, i) => {
    if (out[i] === undefined) out[i] = getPoint(k) ?? 0;
  });

  record('Elevation', {
    provider: 'Open-Meteo',
    detail: `${pts.length - missing.size} cached · ${fetched} fetched`,
    stale: failed,
  });

  return out;
}

// ---------- precision path ----------
// Used where accuracy matters more than volume. Falls back to the bulk
// provider per point, so a 3DEP outage degrades the numbers rather than
// emptying the card.
export async function preciseElevations(pts) {
  const provider = pickProvider(pts[0]);
  if (provider.name !== 'USGS 3DEP') {
    return { values: await elevations(pts), provider: 'Open-Meteo', resolutionM: 90 };
  }

  const keys = pts.map(fineKey);
  const out = new Array(pts.length);
  const misses = [];

  keys.forEach((k, i) => {
    const v = getPoint(k);
    if (v === undefined) misses.push(i);
    else out[i] = v;
  });

  if (misses.length) {
    const got = await pool(
      misses.map((i) => pts[i]),
      USGS_CONCURRENCY,
      fetchUsgsPoint
    );
    const fresh = {};
    got.forEach((v, j) => {
      if (typeof v === 'number') {
        const i = misses[j];
        out[i] = v;
        fresh[keys[i]] = v;
      }
    });
    setPoints(fresh);
  }

  // Anything 3DEP could not answer falls back to the coarse provider.
  const gaps = out.reduce((acc, v, i) => (v === undefined ? [...acc, i] : acc), []);
  let degraded = false;
  if (gaps.length) {
    degraded = true;
    const fill = await elevations(gaps.map((i) => pts[i]));
    gaps.forEach((i, j) => (out[i] = fill[j]));
  }

  record('Elevation', {
    provider: degraded ? 'USGS 3DEP + Open-Meteo' : 'USGS 3DEP',
    detail: degraded
      ? `${pts.length - gaps.length} at 1 m · ${gaps.length} fell back`
      : `${pts.length - misses.length} cached · ${misses.length} fetched · 1 m`,
    stale: degraded,
  });

  return {
    values: out,
    provider: degraded ? 'USGS 3DEP with Open-Meteo fallback' : 'USGS 3DEP',
    resolutionM: degraded ? 90 : 1,
  };
}
