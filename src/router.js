// Routing adapter: BRouter public API with straight-line fallback.
// Returns legs as { coords: [[lon, lat, ele], ...], straight: bool }.

import { elevations } from './elevation.js';
import { record } from './provenance.js';

const BROUTER = 'https://brouter.de/brouter';
const PROFILE = 'hiking-mountain';
// A snapped path more than 3x the straight-line distance means the router
// wandered off to find a trail that isn't really "between" the points.
const INDIRECT_RATIO = 3;

export function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function trackLengthM(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversineM(coords[i - 1], coords[i]);
  return m;
}

async function snapLeg(from, to) {
  const lonlats = `${from[0]},${from[1]}|${to[0]},${to[1]}`;
  const url = `${BROUTER}?lonlats=${lonlats}&profile=${PROFILE}&alternativeidx=0&format=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BRouter ${res.status}`);
  const gj = await res.json();
  const coords = gj.features?.[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) throw new Error('BRouter empty geometry');
  return coords; // [lon, lat, ele]
}

// Sample elevations for a straight segment so gain stats and the profile
// stay honest off-trail. Goes through the cached elevation provider, so
// re-dragging a waypoint over ground already sampled costs no requests.
async function elevateStraight(from, to) {
  const distM = haversineM(from, to);
  const n = Math.min(60, Math.max(2, Math.round(distM / 100) + 1));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  const eles = await elevations(pts);
  return pts.map((p, i) => [p[0], p[1], eles[i]]);
}

export async function routeLeg(from, to) {
  const straightM = haversineM(from, to);
  try {
    const coords = await snapLeg(from, to);
    if (trackLengthM(coords) <= straightM * INDIRECT_RATIO || straightM < 50) {
      record('Routing', { provider: 'BRouter', detail: 'snapped to trail' });
      return { coords, straight: false };
    }
    record('Routing', { provider: 'BRouter', detail: 'no direct trail, straight line' });
  } catch {
    record('Routing', { provider: 'BRouter', detail: 'unreachable, straight line', stale: true });
  }
  return { coords: await elevateStraight(from, to), straight: true };
}
