// Slope-angle tint, computed in the browser.
//
// MapLibre ships a hillshade layer for raster-DEM sources but nothing that
// colours by slope angle, so this registers a custom protocol: MapLibre asks
// for slope://…/{z}/{x}/{y}.png, we fetch the matching Terrarium elevation
// tile, decode it, run Horn's method per pixel, and hand back a PNG of
// coloured slope.
//
// Terrarium tiles come from AWS Open Data — no key, CORS open — which keeps
// the app a static site.

import maplibregl from 'maplibre-gl';
import { record } from './provenance.js';

const TERRARIUM_HOST = 's3.amazonaws.com/elevation-tiles-prod/terrarium';
export const SLOPE_TILES = `slope://${TERRARIUM_HOST}/{z}/{x}/{y}.png`;
// Terrarium publishes to z15. Past the source zoom the extra detail is
// interpolation, so let MapLibre overzoom rather than inventing slope.
export const SLOPE_MAXZOOM = 14;

const TILE_RE = /\/(\d+)\/(\d+)\/(\d+)\.png$/;

// Slope bands. Most slab avalanches release between 30 and 45 degrees, so
// that range carries the loudest colours; below 27 stays clear so the topo
// underneath reads normally.
const BANDS = [
  [27, [242, 224, 74]], // 27–30  yellow
  [30, [240, 160, 60]], // 30–35  orange
  [35, [227, 79, 60]], // 35–40  red, the heart of the slab band
  [40, [186, 48, 92]], // 40–45  deep red
  [45, [138, 62, 158]], // 45–50  purple
  [50, [70, 78, 150]], // 50+    blue
];
const ALPHA = 120; // ~47%, enough to read contours through

export const SLOPE_LEGEND = [
  { label: '27–30°', color: 'rgb(242,224,74)' },
  { label: '30–35°', color: 'rgb(240,160,60)' },
  { label: '35–40°', color: 'rgb(227,79,60)' },
  { label: '40–45°', color: 'rgb(186,48,92)' },
  { label: '45–50°', color: 'rgb(138,62,158)' },
  { label: '50°+', color: 'rgb(70,78,150)' },
];

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

async function renderSlopeTile(params, abortController) {
  const m = params.url.match(TILE_RE);
  if (!m) throw new Error('bad slope tile url');
  const z = +m[1];
  const y = +m[3];

  const res = await fetch(params.url.replace(/^slope:\/\//, 'https://'), {
    signal: abortController.signal,
  });
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

      if (deg < BANDS[0][0]) continue; // leave it transparent
      let colour = BANDS[BANDS.length - 1][1];
      for (let k = BANDS.length - 1; k >= 0; k--) {
        if (deg >= BANDS[k][0]) {
          colour = BANDS[k][1];
          break;
        }
      }
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
export function registerSlopeProtocol() {
  if (registered) return;
  maplibregl.addProtocol('slope', renderSlopeTile);
  registered = true;
}

export function recordSlopeSource() {
  record('Slope', {
    provider: 'AWS Terrain Tiles',
    detail: 'Terrarium DEM, computed in browser',
  });
}
