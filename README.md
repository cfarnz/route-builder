# Route Builder

A web app for planning mountain trail-running and hiking routes. Built to solve my own problem:
planning routes for a 50K race build on real topo maps, exported straight to my watch, without
fighting someone else's app.

## What it does

- **Click-to-build routes** that snap to real trails (topo basemaps: OpenTopoMap + USGS)
- **Off-trail fallback** — where no trail exists, segments go straight-line (dashed) with real
  elevation sampled along them, so alpine ridge links still work
- **Distance slider** — set a target; an out-and-back mode mirrors the route home and the slider
  moves the turnaround point live
- **Discover** — finds real trailheads near you (up to 120 mi), generates loop candidates from
  each, and filters by distance, difficulty, and high point. A ⛰ mountains-only toggle keeps
  only trailheads above 8,000 ft
- **Elevation profile** with hover sync to the map; live distance/gain stats
- **GPX export** (with per-point elevation) — imports clean into COROS, Gaia, etc.
- **Saved routes** in localStorage. No backend, no accounts, no API keys.
- **Inspect a point** — tap anywhere for a single card: elevation, slope angle, aspect, current
  weather and 3-day precip, active NWS alerts, and the CAIC avalanche zone and danger rating.
  Slopes in the 30–45° band get flagged, since that's where most slab avalanches release
- **Geography-aware elevation** — a resolver picks the provider by location and by what the
  caller needs. Summary cards get USGS 3DEP at 1 m (US only, one point per request); routes and
  Discover get Open-Meteo at ~90 m (global, 100 points per request). 3DEP failures fall back
  per-point rather than emptying the card
- **Cached providers** — elevation points are cached indefinitely (terrain doesn't move),
  trailhead queries for a week. When a source goes down, the last good answer is served with
  its age shown rather than an error.
- **Data sources panel** — every provider reports what answered, how much came from cache, and
  how fresh it was. Green = live, blue = cached, amber = stale.

## Difficulty scoring

`effort = miles + (elevation gain in feet / 500)` — a flat 10-miler ≈ 10, a 7-miler with
3,500 ft ≈ 14. Bucketed: Easy < 8, Moderate 8–14, Hard 14–20, Very Hard 20+.

## Stack

Vite + vanilla JS + [MapLibre GL](https://maplibre.org/). Routing and elevation from free public
services: [BRouter](https://brouter.de) (mountain-hiking profile — returns elevation per point),
[Overpass API](https://overpass-api.de) (trailhead search), [Open-Meteo](https://open-meteo.com)
(bulk elevation), [USGS 3DEP](https://epqs.nationalmap.gov) (1 m elevation for summary cards),
[NWS](https://api.weather.gov) (active alerts), and the
[National Avalanche Center API](https://api.avalanche.org) (CAIC zones and danger).
MapLibre was chosen over Leaflet for raster-DEM support —
slope-angle and aspect overlays are on the roadmap.

## Run it

```bash
npm install
npm run dev     # → http://localhost:5173
```

## The interesting problems

The code was the easy part. Two bugs only surfaced against real terrain:

1. **Loop overshoot.** Generating loops by placing routing via-points on a circle sized from
   geometry produced loops 1.5–8× the target distance — mountain trail networks stretch routes
   far beyond what a circle predicts. Fix: route, measure, scale the circle by target/actual,
   retry. An 8-mile target now lands within ~10–20%.
2. **Nearest-trailhead bias.** The trailhead search sorted by distance and took the closest five,
   so a 118-mile search radius still returned only city routes. Fix: stratified sampling — one
   random trailhead per distance band, near to far.

## Roadmap

Tap-anywhere location summary (elevation, slope, aspect, weather, avalanche danger in one card),
CAIC avalanche integration, slope-angle tint + aspect overlays, auto-loops from a dropped pin,
sorting discovered routes by high point, COROS workout scheduling.

## Credit

The caching, provenance, and geography-aware provider ideas come from Pedro Marques'
[PeakHut](https://www.pedromarques.io/peakhut/), a backend that aggregates fourteen European
mountain data sources behind one API. This app borrows the concepts at a much smaller scale and
keeps everything client-side.
