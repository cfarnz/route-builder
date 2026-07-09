// Route discovery: find trailheads near a point (OSM Overpass), generate
// candidate loops from each (BRouter via-points on a circle), score and
// filter them against the user's sliders.

import { trackLengthM, haversineM } from './router.js';
import { M_PER_MI, FT_PER_M } from './route.js';

export const effortScore = (distMi, gainFt) => distMi + gainFt / 500;
export const effortBucket = (s) =>
  s < 8 ? 'Easy' : s < 14 ? 'Moderate' : s < 20 ? 'Hard' : 'Very Hard';

// Spherical destination point: from lon/lat, travel distM at bearingDeg.
function offset([lon, lat], bearingDeg, distM) {
  const R = 6371000;
  const br = (bearingDeg * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const d = distM / R;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br)
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2)
    );
  return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
}

// Trailheads above this are "mountains" in Colorado terms — foothills
// trailheads (Chautauqua ~5,700 ft) fall below, high country sits above.
const MOUNTAIN_TRAILHEAD_FT = 8000;

// Batch elevation lookup for trailhead nodes (Open-Meteo, 100 coords/request).
async function elevateNodes(nodes) {
  for (let i = 0; i < nodes.length; i += 100) {
    const chunk = nodes.slice(i, i + 100);
    try {
      const lats = chunk.map((n) => n.pt[1].toFixed(5)).join(',');
      const lons = chunk.map((n) => n.pt[0].toFixed(5)).join(',');
      const res = await fetch(
        `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`
      );
      const { elevation } = await res.json();
      chunk.forEach((n, j) => (n.eleFt = (elevation?.[j] ?? 0) * FT_PER_M));
    } catch {
      chunk.forEach((n) => (n.eleFt = 0));
    }
  }
  return nodes;
}

// Real trailheads within radius, sampled ACROSS the whole radius — one pick
// per distance band, so a big radius reaches the far mountains instead of
// always anchoring on the five trailheads nearest home.
export async function findTrailheads(center, radiusMi, limit = 5, mountainsOnly = false) {
  const r = Math.round(radiusMi * M_PER_MI);
  const around = `(around:${r},${center[1]},${center[0]})`;
  const q = `[out:json][timeout:25];(node["information"="trailhead"]${around};node["highway"="trailhead"]${around};);out 150;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: q,
    });
    const data = await res.json();
    let nodes = (data.elements || []).map((n) => ({
      pt: [n.lon, n.lat],
      name: n.tags?.name || 'Trailhead',
      d: haversineM(center, [n.lon, n.lat]),
    }));
    if (!nodes.length) return [];

    if (mountainsOnly) {
      await elevateNodes(nodes);
      nodes = nodes.filter((n) => n.eleFt >= MOUNTAIN_TRAILHEAD_FT);
      if (!nodes.length) return [];
    }

    const sepM = Math.max(2, radiusMi / 10) * M_PER_MI;
    const bandM = (radiusMi * M_PER_MI) / limit;
    const picked = [];
    const farEnough = (n) => picked.every((p) => haversineM(p.pt, n.pt) > sepM);

    // One random trailhead per distance band, near → far.
    for (let b = 0; b < limit; b++) {
      const inBand = nodes.filter(
        (n) => n.d >= b * bandM && n.d < (b + 1) * bandM && farEnough(n)
      );
      if (inBand.length) picked.push(inBand[Math.floor(Math.random() * inBand.length)]);
    }
    // Backfill from anywhere if some bands were empty.
    for (const n of [...nodes].sort(() => Math.random() - 0.5)) {
      if (picked.length >= limit) break;
      if (farEnough(n)) picked.push(n);
    }
    return picked;
  } catch {
    return [];
  }
}

async function brouterLoopOnce(anchor, bearing, r, signal) {
  const center = offset(anchor, bearing, r);
  const back = (bearing + 180) % 360; // bearing from circle center to anchor
  const v1 = offset(center, (back + 120) % 360, r);
  const v2 = offset(center, (back + 240) % 360, r);
  const vias = [anchor, v1, v2, anchor];
  const lonlats = vias.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join('|');
  const res = await fetch(
    `https://brouter.de/brouter?lonlats=${lonlats}&profile=hiking-mountain&alternativeidx=0&format=geojson`,
    { signal }
  );
  if (!res.ok) throw new Error(`BRouter ${res.status}`);
  const gj = await res.json();
  const coords = gj.features?.[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) throw new Error('empty geometry');
  return { coords, vias };
}

// One candidate loop, adaptively sized. Trail networks make loops come back
// far longer than circle geometry predicts (measured 1.5–8x in the Front
// Range), so: route, measure, scale the circle by target/actual, retry.
async function brouterLoop(anchor, targetMi, bearing, signal) {
  const targetM = targetMi * M_PER_MI;
  let r = (targetM / (2 * Math.PI)) * 0.8; // start small; mountains inflate
  let best = null;
  let bestErr = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cand = await brouterLoopOnce(anchor, bearing, r, signal);
    const actualM = trackLengthM(cand.coords);
    const err = Math.abs(actualM - targetM) / targetM;
    if (err < bestErr) {
      best = cand;
      bestErr = err;
    }
    if (err <= 0.3) return best;
    // Scale radius toward target, clamped so one weird result can't zero it.
    r *= Math.min(1.6, Math.max(0.25, targetM / actualM));
  }
  return best; // caller's distance filter makes the final call
}

function trackStats(coords) {
  const distMi = trackLengthM(coords) / M_PER_MI;
  let gainM = 0;
  let ref = coords[0][2] ?? 0;
  let maxEle = ref;
  for (const c of coords) {
    const e = c[2] ?? ref;
    if (e > maxEle) maxEle = e;
    if (e > ref + 3) {
      gainM += e - ref;
      ref = e;
    } else if (e < ref - 3) {
      ref = e;
    }
  }
  return { distMi, gainFt: gainM * FT_PER_M, hpFt: maxEle * FT_PER_M };
}

// opts: { center, targetMi, maxEffort, hpMinFt, hpMaxFt, radiusMi, mountainsOnly }
export async function discover(opts, onProgress = () => {}) {
  const { center, targetMi, maxEffort, hpMinFt, hpMaxFt, radiusMi, mountainsOnly } = opts;

  // Mountains-only skips the current-location anchor — that's the city.
  const anchors = [
    ...(mountainsOnly ? [] : [{ pt: center, name: 'Current location' }]),
    ...(await findTrailheads(center, radiusMi, mountainsOnly ? 6 : 5, mountainsOnly)),
  ];
  if (!anchors.length) return [];

  // Two loop directions per anchor, jittered so reruns give fresh options.
  const bearings = [0, 90, 180, 270].sort(() => Math.random() - 0.5).slice(0, 2);
  const jobs = [];
  for (const a of anchors)
    for (const b of bearings) jobs.push({ a, bearing: b + Math.random() * 40 - 20 });

  const results = [];
  let done = 0;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      try {
        const { coords, vias } = await brouterLoop(job.a.pt, targetMi, job.bearing, ctl.signal);
        const { distMi, gainFt, hpFt } = trackStats(coords);
        const eff = effortScore(distMi, gainFt);
        const keep =
          Math.abs(distMi - targetMi) <= targetMi * 0.3 &&
          eff <= maxEffort &&
          hpFt >= hpMinFt &&
          hpFt <= hpMaxFt;
        if (keep) {
          results.push({
            name: job.a.name,
            coords,
            vias,
            distMi,
            gainFt,
            hpFt,
            eff,
            driveMi: haversineM(center, job.a.pt) / M_PER_MI,
          });
        }
      } catch {
        /* dropped candidate — routing failed or timed out */
      } finally {
        clearTimeout(timer);
        onProgress(++done, jobs.length);
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));

  results.sort((a, b) => Math.abs(a.distMi - targetMi) - Math.abs(b.distMi - targetMi));
  return results.slice(0, 10);
}
