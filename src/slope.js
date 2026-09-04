// Terrain overlays (slope angle, aspect), computed in the browser.
//
// MapLibre ships a hillshade layer for raster-DEM sources but nothing that
// colours by slope or aspect, so each overlay registers a custom protocol:
// MapLibre asks for slope://…/{z}/{x}/{y}.png, we fetch the matching
// Terrarium elevation tile, decode it, run Horn's method per pixel, and hand
// back a PNG of coloured terrain.
//
// Terrarium tiles come from AWS Open Data — no key, CORS open — which keeps
// the app a static site.

import maplibregl from 'maplibre-gl';
import { record } from './provenance.js';

const HOST = 's3.amazonaws.com/elevation-tiles-prod/terrarium';
// Terrarium publishes to z15. Past the source zoom the extra detail is
// interpolation, so let MapLibre overzoom rather than inventing terrain.
export const OVERLAY_MAXZOOM = 14;

const TILE_RE = /\/(\d+)\/(\d+)\/(\d+)\.png$/;
const ALPHA = 120; // ~47%, enough to read contours through

// Slope bands. Most slab avalanches release between 30 and 45 degrees, so
// that range carries the loudest colours; below 27 stays clear so the topo
// underneath reads normally.
const SLOPE_BANDS = [
  [27, [242, 224, 74]], // 27–30  yellow
  [30, [240, 160, 60]], // 30–35  orange
  [35, [227, 79, 60]], // 35–40  red, the heart of the slab band
  [40, [186, 48, 92]], // 40–45  deep red
  [45, [138, 62, 158]], // 45–50  purple
  [50, [70, 78, 150]], // 50+    blue
];

// Eight compass sectors on a colour wheel, so opposing aspects read as
// opposing colours. North is blue (holds snow, stays cold), south is amber.
const ASPECT_SECTORS = [
  [74, 127, 212], // N
  [70, 179, 196], // NE
  [79, 179, 106], // E
  [168, 188, 74], // SE
  [224, 168, 60], // S
  [224, 102, 60], // SW
  [201, 73, 143], // W
  [131, 85, 196], // NW
];
// Flat ground has no meaningful aspect, so the overlay only paints terrain
// steep enough for the direction to mean something.
const ASPECT_MIN_SLOPE = 20;

export const OVERLAYS = {
  slope: {
    label: '▲ Slope',
    tiles: `slope://${HOST}/{z}/{x}/{y}.png`,
    legend: [
      { label: '27–30°', color: 'rgb(242,224,74)' },
      { label: '30–35°', color: 'rgb(240,160,60)' },
      { label: '35–40°', color: 'rgb(227,79,60)' },
      { label: '40–45°', color: 'rgb(186,48,92)' },
      { label: '45–50°', color: 'rgb(138,62,158)' },
      { label: '50°+', color: 'rgb(70,78,150)' },
    ],
    note: 'Loudest colours mark 30–45°, where most slab avalanches release.',
  },
  aspect: {
    label: '◔ Aspect',
    tiles: `aspect://${HOST}/{z}/{x}/{y}.png`,
    legend: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((label, i) => ({
      label,
      color: `rgb(${ASPECT_SECTORS[i].join(',')})`,
    })),
    note: `Shown on slopes over ${ASPECT_MIN_SLOPE}°. Flatter ground has no meaningful aspect.`,
  },
};

// Ground distance covered by one pixel, which is the cell size Horn's method
// needs. Web Mercator stretches with latitude, so this is per-tile.
function metersPerPixel(z, y, tilePx) {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  const lat = Math.atan(Math.sinh(n));
  return (156543.03392804097 * Math.cos(lat)) / 2 ** z / (tilePx / 256);
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function slopeColour(deg) {
  if (deg < SLOPE_BANDS[0][0]) return null;
  for (let k = SLOPE_BANDS.length - 1; k >= 0; k--) {
    if (deg >= SLOPE_BANDS[k][0]) return SLOPE_BANDS[k][1];
  }
  return null;
}

// ESRI's aspect convention: 0 is north, increasing clockwise.
function aspectColour(deg, dzdx, dzdy) {
  if (deg < ASPECT_MIN_SLOPE) return null;
  let a = (Math.atan2(dzdy, -dzdx) * 180) / Math.PI;
  if (a < 0) a = 90 - a;
  else if (a > 90) a = 360 - a + 90;
  else a = 90 - a;
  return ASPECT_SECTORS[Math.round((a % 360) / 45) % 8];
}

async function renderTile(params, abortController, mode) {
  const m = params.url.match(TILE_RE);
  if (!m) throw new Error('bad overlay tile url');
  const z = +m[1];
  const y = +m[3];

  const src_url = params.url.replace(/^[a-z]+:\/\//, 'https://');
  const res = await fetch(src_url, { signal: abortController.signal });
  if (!res.ok) throw new Error(`Terrarium ${res.status}`);

  const bmp = await createImageBitmap(await res.blob());
  const w = bmp.width;
  const h = bmp.height;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();

  // Terrarium packs metres as (R * 256 + G + B / 256) - 32768.
  const src = ctx.getImageData(0, 0, w, h).data;
  const ele = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    ele[i] = src[p] * 256 + src[p + 1] + src[p + 2] / 256 - 32768;
  }

  const cell = metersPerPixel(z, y, h);
  const out = ctx.createImageData(w, h);
  const dst = out.data;
  // Edges clamp to the nearest in-tile pixel. That leaves a one-pixel seam
  // at tile boundaries, which is cheaper than fetching eight neighbours.
  const at = (x, yy) => ele[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, x))];

  for (let yy = 0; yy < h; yy++) {
    for (let x = 0; x < w; x++) {
      const a = at(x - 1, yy - 1);
      const b = at(x, yy - 1);
      const c = at(x + 1, yy - 1);
      const d = at(x - 1, yy);
      const f = at(x + 1, yy);
      const g = at(x - 1, yy + 1);
      const hh = at(x, yy + 1);
      const i2 = at(x + 1, yy + 1);

      const dzdx = (c + 2 * f + i2 - (a + 2 * d + g)) / (8 * cell);
      const dzdy = (g + 2 * hh + i2 - (a + 2 * b + c)) / (8 * cell);
      const deg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

      const colour = mode === 'aspect' ? aspectColour(deg, dzdx, dzdy) : slopeColour(deg);
      if (!colour) continue; // leave it transparent

      const p = (yy * w + x) * 4;
      dst[p] = colour[0];
      dst[p + 1] = colour[1];
      dst[p + 2] = colour[2];
      dst[p + 3] = ALPHA;
    }
  }

  ctx.putImageData(out, 0, 0);
  return { data: await (await toBlob(canvas)).arrayBuffer() };
}

let registered = false;
export function registerOverlayProtocols() {
  if (registered) return;
  for (const mode of Object.keys(OVERLAYS)) {
    maplibregl.addProtocol(mode, (params, ac) => renderTile(params, ac, mode));
  }
  registered = true;
}

export function recordOverlaySource(mode) {
  record(mode === 'aspect' ? 'Aspect' : 'Slope', {
    provider: 'AWS Terrain Tiles',
    detail: 'Terrarium DEM, computed in browser',
  });
}
