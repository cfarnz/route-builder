import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Route } from './route.js';
import { outAndBack } from './slider.js';
import { downloadGPX } from './gpx.js';
import { Profile } from './profile.js';
import { listRoutes, saveRoute, deleteRoute } from './storage.js';
import { discover, effortBucket } from './discover.js';
import { onChange, ago } from './provenance.js';
import { cacheStats, clearCache } from './cache.js';
import { locationSummary } from './summary.js';
import { renderCard } from './card.js';
import {
  registerOverlayProtocols,
  recordOverlaySource,
  OVERLAYS,
  OVERLAY_MAXZOOM,
} from './slope.js';

registerOverlayProtocols();

// ---------- basemaps ----------
const BASEMAPS = {
  opentopo: {
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    attribution: '© OpenTopoMap (CC-BY-SA) © OpenStreetMap contributors',
    maxzoom: 17,
  },
  usgs: {
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'USGS The National Map',
    maxzoom: 16,
  },
};

function styleFor(name) {
  const b = BASEMAPS[name];
  return {
    version: 8,
    sources: { base: { type: 'raster', tileSize: 256, ...b } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: styleFor('opentopo'),
  center: [-105.28, 39.995], // Boulder — Chautauqua-ish
  zoom: 12,
});
map.addControl(new maplibregl.NavigationControl(), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }));

// ---------- state ----------
let obActive = false; // out-and-back mode
const route = new Route(render);

const $ = (id) => document.getElementById(id);
const els = {
  name: $('route-name'),
  dist: $('stat-dist'),
  gain: $('stat-gain'),
  slider: $('target-slider'),
  targetLabel: $('target-label'),
  progressFill: $('target-progress-fill'),
  outback: $('btn-outback'),
  undo: $('btn-undo'),
  clear: $('btn-clear'),
  export: $('btn-export'),
  save: $('btn-save'),
  savedList: $('saved-list'),
};

// ---------- route layers ----------
function ensureRouteLayers() {
  ensureOverlayLayers(); // first, so the tints sit under the route line
  if (map.getSource('route')) return;
  map.addSource('route', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    filter: ['!', ['get', 'straight']],
    paint: { 'line-color': '#e0453f', 'line-width': 4, 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'route-line-straight',
    type: 'line',
    source: 'route',
    filter: ['get', 'straight'],
    paint: {
      'line-color': '#e0453f',
      'line-width': 3,
      'line-opacity': 0.85,
      'line-dasharray': [2, 2],
    },
  });
  map.addSource('preview', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'preview-line',
    type: 'line',
    source: 'preview',
    paint: { 'line-color': '#4f9de0', 'line-width': 3, 'line-opacity': 0.8 },
  });
}
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
map.on('load', ensureRouteLayers);
map.on('styledata', ensureRouteLayers); // re-add after basemap switch

// ---------- terrain overlays ----------
// Tiles are decoded and coloured in the browser via a custom protocol, so
// the layers are always present and only visibility toggles. MapLibre skips
// fetching tiles for a hidden layer, so nothing downloads until asked.
//
// Only one overlay shows at a time: two translucent tints stacked produce a
// colour that means neither thing. Clicking the active one turns it off.
let activeOverlay = null;

// Only ever called from the load/styledata handler, where adding sources is
// legal. The toggles never add anything, they just flip visibility.
function ensureOverlayLayers() {
  for (const [key, cfg] of Object.entries(OVERLAYS)) {
    if (map.getSource(key)) continue;
    map.addSource(key, {
      type: 'raster',
      tiles: [cfg.tiles],
      tileSize: 256,
      maxzoom: OVERLAY_MAXZOOM,
      attribution:
        'Terrain from <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
    });
    map.addLayer({
      id: `${key}-layer`,
      type: 'raster',
      source: key,
      layout: { visibility: activeOverlay === key ? 'visible' : 'none' },
      paint: { 'raster-opacity': 1 },
    });
  }
}

const overlayBtns = { slope: $('btn-slope'), aspect: $('btn-aspect') };
const overlayLegend = $('overlay-legend');
const overlayNote = $('overlay-note');

function renderOverlayUI() {
  for (const [key, btn] of Object.entries(overlayBtns)) {
    btn.textContent = OVERLAYS[key].label;
    btn.classList.toggle('active', activeOverlay === key);
  }
  const cfg = activeOverlay ? OVERLAYS[activeOverlay] : null;
  overlayLegend.hidden = !cfg;
  overlayNote.hidden = !cfg;
  overlayLegend.innerHTML = '';
  if (!cfg) return;
  for (const band of cfg.legend) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const sw = document.createElement('i');
    sw.style.background = band.color;
    item.append(sw, document.createTextNode(band.label));
    overlayLegend.appendChild(item);
  }
  overlayNote.textContent = cfg.note;
}

function setOverlay(key) {
  activeOverlay = activeOverlay === key ? null : key;
  renderOverlayUI();
  for (const k of Object.keys(OVERLAYS)) {
    const id = `${k}-layer`;
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', activeOverlay === k ? 'visible' : 'none');
    }
  }
  // Decoding is async and the first paint can lag the toggle by a beat.
  map.triggerRepaint();
  if (activeOverlay) recordOverlaySource(activeOverlay);
}

for (const key of Object.keys(overlayBtns)) {
  overlayBtns[key].addEventListener('click', () => setOverlay(key));
}
renderOverlayUI();

function routeGeoJSON() {
  if (obActive) {
    return {
      type: 'FeatureCollection',
      features: [feat(activeTrack(), false)],
    };
  }
  return {
    type: 'FeatureCollection',
    features: route.legs.filter(Boolean).map((leg) => feat(leg.coords, leg.straight)),
  };
}
const feat = (coords, straight) => ({
  type: 'Feature',
  properties: { straight },
  geometry: { type: 'LineString', coordinates: coords.map((c) => [c[0], c[1]]) },
});

// ---------- waypoint markers ----------
let markers = [];
function rebuildMarkers() {
  markers.forEach((m) => m.remove());
  markers = route.waypoints.map((wp, i) => {
    const el = document.createElement('div');
    el.className = 'wp-marker' + (i === 0 ? ' start' : '');
    const m = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(wp)
      .addTo(map);
    m.on('dragend', () => {
      exitOB();
      const { lng, lat } = m.getLngLat();
      route.moveWaypoint(i, [lng, lat]);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      exitOB();
      route.deleteWaypoint(i);
    });
    return m;
  });
}

map.on('click', (e) => {
  const pt = [e.lngLat.lng, e.lngLat.lat];
  if (inspectMode) return showSummary(pt);
  exitOB();
  route.addWaypoint(pt);
});

// ---------- inspect a point ----------
// One tap fans out to every provider and comes back as a single card, the
// way PeakHut's location summary does. Providers that fail drop out of the
// card rather than failing the whole tap.
let inspectMode = false;
let summaryPopup = null;
let summaryReq = 0;

const inspectBtn = $('btn-inspect');
inspectBtn.addEventListener('click', () => {
  inspectMode = !inspectMode;
  inspectBtn.classList.toggle('active', inspectMode);
  inspectBtn.textContent = inspectMode ? '\u{1F4CD} Inspecting — tap the map' : '\u{1F4CD} Inspect a point';
  map.getCanvas().style.cursor = inspectMode ? 'crosshair' : '';
  if (!inspectMode && summaryPopup) {
    summaryPopup.remove();
    summaryPopup = null;
  }
});

async function showSummary(pt) {
  const id = ++summaryReq;
  if (summaryPopup) summaryPopup.remove();

  const loading = document.createElement('div');
  loading.className = 'summary-card';
  loading.textContent = 'Reading terrain…';
  const popup = new maplibregl.Popup({ maxWidth: '320px', closeOnMove: false })
    .setLngLat(pt)
    .setDOMContent(loading)
    .addTo(map);
  summaryPopup = popup;

  const summary = await locationSummary(pt);
  if (id !== summaryReq) return; // a newer tap already won
  popup.setDOMContent(renderCard(summary));
}

// ---------- out-and-back ----------
function activeTrack() {
  const base = route.track();
  return obActive ? outAndBack(base, targetMi()) : base;
}
const targetMi = () => parseFloat(els.slider.value);

function exitOB() {
  if (obActive) {
    obActive = false;
    els.outback.textContent = '⇄ Out-and-back to target';
  }
}

els.outback.addEventListener('click', () => {
  obActive = !obActive;
  els.outback.textContent = obActive ? '⇄ Exit out-and-back' : '⇄ Out-and-back to target';
  render();
});

els.slider.addEventListener('input', () => {
  els.targetLabel.textContent = `${targetMi().toFixed(1)} mi`;
  render();
});

// ---------- profile + hover marker ----------
const hoverDot = new maplibregl.Marker({
  element: Object.assign(document.createElement('div'), { className: 'wp-marker' }),
});
let hoverShown = false;
const profile = new Profile($('profile'), $('profile-tip'), (lngLat) => {
  if (lngLat) {
    hoverDot.setLngLat(lngLat);
    if (!hoverShown) {
      hoverDot.addTo(map);
      hoverShown = true;
    }
  } else if (hoverShown) {
    hoverDot.remove();
    hoverShown = false;
  }
});

// ---------- buttons ----------
els.undo.addEventListener('click', () => {
  exitOB();
  route.undo();
});
els.clear.addEventListener('click', () => {
  exitOB();
  route.clear();
});
els.export.addEventListener('click', () => downloadGPX(activeTrack(), els.name.value));
els.save.addEventListener('click', () => {
  const name = els.name.value.trim() || `Route ${new Date().toLocaleDateString()}`;
  saveRoute(name, route.toJSON());
  els.name.value = name;
  renderSavedList();
});

$('layer-opentopo').addEventListener('click', () => setBasemap('opentopo'));
$('layer-usgs').addEventListener('click', () => setBasemap('usgs'));
function setBasemap(name) {
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  $(`layer-${name}`).classList.add('active');
  map.setStyle(styleFor(name)); // styledata handler restores route layers
  setTimeout(render, 200);
}

// ---------- discover ----------
const dEls = {
  dist: $('d-dist'),
  distLabel: $('d-dist-label'),
  eff: $('d-eff'),
  effLabel: $('d-eff-label'),
  hpMin: $('d-hp-min'),
  hpMax: $('d-hp-max'),
  hpLabel: $('d-hp-label'),
  rad: $('d-rad'),
  radLabel: $('d-rad-label'),
  btn: $('btn-discover'),
  status: $('d-status'),
  results: $('d-results'),
};

function updateDiscoverLabels() {
  dEls.distLabel.textContent = `${dEls.dist.value} mi`;
  const eff = parseFloat(dEls.eff.value);
  dEls.effLabel.textContent = `${effortBucket(eff)} (${eff})`;
  let lo = parseInt(dEls.hpMin.value);
  let hi = parseInt(dEls.hpMax.value);
  if (lo > hi) [lo, hi] = [hi, lo];
  dEls.hpLabel.textContent = `${lo.toLocaleString()}–${hi.toLocaleString()} ft`;
  dEls.radLabel.textContent = `${dEls.rad.value} mi`;
}
['d-dist', 'd-eff', 'd-hp-min', 'd-hp-max', 'd-rad'].forEach((id) =>
  $(id).addEventListener('input', updateDiscoverLabels)
);
updateDiscoverLabels();

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.longitude, pos.coords.latitude]),
      () => resolve(null),
      { timeout: 8000 }
    );
  });
}

const setPreview = (coords) => {
  if (!map.getSource('preview')) return;
  map
    .getSource('preview')
    .setData(
      coords
        ? { type: 'FeatureCollection', features: [feat(coords, false)] }
        : emptyFC()
    );
};

dEls.btn.addEventListener('click', async () => {
  dEls.btn.disabled = true;
  dEls.results.innerHTML = '';
  dEls.status.textContent = 'Locating…';

  let center = await getLocation();
  if (!center) {
    const c = map.getCenter();
    center = [c.lng, c.lat];
    dEls.status.textContent = 'Location unavailable — searching from map center. ';
  }

  let lo = parseInt(dEls.hpMin.value);
  let hi = parseInt(dEls.hpMax.value);
  if (lo > hi) [lo, hi] = [hi, lo];

  try {
    const found = await discover(
      {
        center,
        targetMi: parseFloat(dEls.dist.value),
        maxEffort: parseFloat(dEls.eff.value),
        hpMinFt: lo,
        hpMaxFt: hi,
        radiusMi: parseFloat(dEls.rad.value),
        mountainsOnly: $('d-mountains').checked,
      },
      (done, total) => {
        dEls.status.textContent = `Generating candidates… ${done}/${total}`;
      }
    );

    dEls.status.textContent = found.length
      ? `${found.length} route${found.length > 1 ? 's' : ''} found — hover to preview, click to load.`
      : 'No routes matched. Widen the sliders or search radius and try again.';

    for (const r of found) {
      const li = document.createElement('li');
      const bucket = effortBucket(r.eff);
      li.innerHTML =
        `<b>${r.name}</b><span class="badge ${bucket.replace(' ', '')}">${bucket}</span><br>` +
        `<span class="meta">${r.distMi.toFixed(1)} mi · ▲${Math.round(r.gainFt).toLocaleString()} ft · ` +
        `high ${Math.round(r.hpFt).toLocaleString()} ft · ${r.driveMi.toFixed(0)} mi away</span>`;
      li.addEventListener('mouseenter', () => setPreview(r.coords));
      li.addEventListener('mouseleave', () => setPreview(null));
      li.addEventListener('click', async () => {
        setPreview(null);
        exitOB();
        route.clear();
        dEls.status.textContent = 'Loading route into builder…';
        for (const v of r.vias) await route.addWaypoint(v);
        dEls.status.textContent = 'Loaded — edit, save, or export.';
        els.name.value = `${r.name} ${r.distMi.toFixed(0)}mi loop`;
      });
      dEls.results.appendChild(li);
    }

    if (found.length) {
      const all = found.flatMap((r) => r.coords);
      const lons = all.map((c) => c[0]);
      const lats = all.map((c) => c[1]);
      map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 60 }
      );
    }
  } catch (err) {
    dEls.status.textContent = `Search failed: ${err.message}. Try again in a minute.`;
  } finally {
    dEls.btn.disabled = false;
  }
});

// ---------- saved routes ----------
function renderSavedList() {
  const all = listRoutes();
  els.savedList.innerHTML = '';
  for (const name of Object.keys(all).sort()) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = name;
    span.title = 'Load route';
    span.addEventListener('click', () => {
      exitOB();
      route.fromJSON(all[name]);
      els.name.value = name;
      const t = route.track();
      if (t.length) {
        const lons = t.map((c) => c[0]);
        const lats = t.map((c) => c[1]);
        map.fitBounds(
          [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
          { padding: 60 }
        );
      }
    });
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Delete saved route';
    del.addEventListener('click', () => {
      if (confirm(`Delete saved route "${name}"?`)) {
        deleteRoute(name);
        renderSavedList();
      }
    });
    li.append(span, del);
    els.savedList.appendChild(li);
  }
}

// ---------- data sources ----------
// Every provider reports what answered and how fresh it was. Cached and
// stale answers are labelled rather than hidden, so a wrong elevation can be
// traced to a bad source instead of guessed at.
const srcEls = { list: $('source-list'), stats: $('cache-stats'), clear: $('btn-clear-cache') };

function renderCacheStats() {
  const { entries, points, bytes } = cacheStats();
  srcEls.stats.textContent = entries
    ? `${points.toLocaleString()} elevation points · ${Math.round(bytes / 1024)} KB cached`
    : 'Cache empty';
  srcEls.clear.disabled = !entries;
}

onChange((sources) => {
  srcEls.list.innerHTML = '';
  if (!sources.length) {
    const li = document.createElement('li');
    li.className = 'src empty';
    li.textContent = 'Nothing fetched yet';
    srcEls.list.appendChild(li);
  }
  for (const s of sources) {
    const li = document.createElement('li');
    li.className = 'src ' + (s.stale ? 'stale' : s.fromCache ? 'cached' : 'live');
    const head = document.createElement('b');
    head.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [s.provider, s.detail].filter(Boolean).join(' · ');
    const when = document.createElement('span');
    when.className = 'meta when';
    when.textContent = (s.stale ? 'stale · ' : '') + ago(s.at);
    li.append(head, meta, when);
    srcEls.list.appendChild(li);
  }
  renderCacheStats();
});

srcEls.clear.addEventListener('click', () => {
  if (confirm('Clear all cached elevation and trailhead data? Saved routes are not affected.')) {
    clearCache();
    renderCacheStats();
  }
});
renderCacheStats();

// ---------- render ----------
function render() {
  const track = activeTrack();
  const { distMi, gainFt } = route.stats(track);

  els.dist.textContent = distMi.toFixed(1);
  els.gain.textContent = Math.round(gainFt).toLocaleString();
  els.progressFill.style.width = `${Math.min(100, (distMi / targetMi()) * 100)}%`;

  const hasRoute = track.length > 1;
  els.outback.disabled = !hasRoute;
  els.undo.disabled = route.undoStack.length === 0;
  els.clear.disabled = route.waypoints.length === 0;
  els.export.disabled = !hasRoute;
  els.save.disabled = route.waypoints.length === 0;

  document.body.style.cursor = route.busy ? 'progress' : '';

  if (map.getSource('route')) map.getSource('route').setData(routeGeoJSON());
  rebuildMarkers();
  profile.render(track);
}

renderSavedList();
render();
