// Elevation provider. Open-Meteo (global, no key) behind a point cache.
//
// Terrain does not change, so every point ever looked up stays reusable.
// Re-running Discover over the same range now costs almost no requests.

import { getPoint, setPoints } from './cache.js';
import { record } from './provenance.js';

const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100; // Open-Meteo's per-request coordinate limit
// ~11 m grid: rounds nearby lookups onto shared cache keys without
// meaningfully changing the answer.
const GRID = 1e4;

const keyFor = ([lon, lat]) => `${Math.round(lon * GRID)},${Math.round(lat * GRID)}`;

// Elevations in metres for a list of [lon, lat] points, in the same order.
// Missing points resolve to 0 rather than throwing — a route with one bad
// elevation sample is still a usable route.
export async function elevations(pts) {
  const keys = pts.map(keyFor);
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

  for (let i = 0; i < need.length; i += BATCH) {
    const chunk = need.slice(i, i + BATCH);
    try {
      const lats = chunk.map(([, p]) => p[1].toFixed(5)).join(',');
      const lons = chunk.map(([, p]) => p[0].toFixed(5)).join(',');
      const res = await fetch(`${ENDPOINT}?latitude=${lats}&longitude=${lons}`);
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
      const { elevation } = await res.json();
      const fresh = {};
      chunk.forEach(([k], j) => {
        const m = elevation?.[j];
        if (typeof m === 'number') fresh[k] = m;
      });
      setPoints(fresh);
      fetched += Object.keys(fresh).length;
    } catch {
      failed = true; // partial results are fine; the gaps fall back to 0
    }
  }

  keys.forEach((k, i) => {
    if (out[i] === undefined) out[i] = getPoint(k) ?? 0;
  });

  const cachedCount = pts.length - missing.size;
  record('Elevation', {
    provider: 'Open-Meteo',
    detail: `${cachedCount} cached · ${fetched} fetched`,
    stale: failed,
  });

  return out;
}
