// Provider cache: per-dataset TTLs, stale fallback, and eviction.
//
// Borrowed from PeakHut (pedromarques.io/peakhut): different datasets have
// different shelf lives, and when a source goes down the honest move is to
// serve the last good answer with its age attached rather than an error.

const PREFIX = 'route-builder:cache:';

export const TTL = {
  elevation: 365 * 24 * 3600e3, // terrain does not move
  trailheads: 7 * 24 * 3600e3, // OSM trailhead edits land slowly
  weather: 1 * 3600e3,
  avalanche: 3 * 3600e3, // CAIC issues bulletins on roughly this cadence
  alerts: 15 * 60e3, // watches and warnings change fast, so keep this short
};

function read(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  const entry = JSON.stringify({ v: value, t: Date.now() });
  try {
    localStorage.setItem(PREFIX + key, entry);
  } catch {
    evictOldest(0.25);
    try {
      localStorage.setItem(PREFIX + key, entry);
    } catch {
      /* still full — run uncached rather than break the app */
    }
  }
}

// Drop the oldest fraction of cache entries. Only keys under the cache
// prefix are touched; saved routes live elsewhere and are never evicted.
function evictOldest(frac) {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    let t = 0;
    try {
      t = JSON.parse(localStorage.getItem(k)).t || 0;
    } catch {
      /* unparseable entry sorts oldest and gets dropped first */
    }
    entries.push([k, t]);
  }
  entries.sort((a, b) => a[1] - b[1]);
  for (const [k] of entries.slice(0, Math.ceil(entries.length * frac))) {
    localStorage.removeItem(k);
  }
}

// Fetch through the cache. Returns the value plus where it came from, so
// callers can report provenance instead of silently guessing.
export async function cached(key, ttlMs, fetcher) {
  const hit = read(key);
  if (hit && Date.now() - hit.t < ttlMs) {
    return { value: hit.v, fetchedAt: hit.t, stale: false, fromCache: true };
  }
  try {
    const value = await fetcher();
    write(key, value);
    return { value, fetchedAt: Date.now(), stale: false, fromCache: false };
  } catch (err) {
    // Source is down. The last good answer beats an error, as long as the
    // UI says how old it is.
    if (hit) return { value: hit.v, fetchedAt: hit.t, stale: true, fromCache: true };
    throw err;
  }
}

// ---------- point cache ----------
// Elevation is looked up thousands of points at a time, so a single blob
// beats thousands of localStorage keys. Kept in memory and flushed on write.

const POINT_KEY = 'points:elevation';
const MAX_POINTS = 20000;
let points = null;

function loadPoints() {
  if (!points) points = read(POINT_KEY)?.v || {};
  return points;
}

export const getPoint = (k) => loadPoints()[k];

export function setPoints(fresh) {
  const p = loadPoints();
  Object.assign(p, fresh);
  const keys = Object.keys(p);
  // Insertion-ordered, so the earliest-inserted points fall off first.
  if (keys.length > MAX_POINTS) {
    for (const k of keys.slice(0, keys.length - MAX_POINTS)) delete p[k];
  }
  write(POINT_KEY, p);
}

export function cacheStats() {
  let entries = 0;
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    entries++;
    bytes += (localStorage.getItem(k) || '').length;
  }
  return { entries, points: Object.keys(loadPoints()).length, bytes };
}

export function clearCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  points = null;
}
