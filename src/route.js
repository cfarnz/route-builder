// Route state: waypoints + routed legs between them, stats, undo.
// Emits 'change' via the onChange callback whenever the route mutates.

import { routeLeg, trackLengthM } from './router.js';

const M_PER_MI = 1609.344;
const FT_PER_M = 3.28084;
// Ignore elevation wiggles under 3 m so SRTM noise doesn't inflate gain.
const GAIN_HYSTERESIS_M = 3;

export class Route {
  constructor(onChange) {
    this.waypoints = []; // [lon, lat]
    this.legs = [];      // { coords: [[lon,lat,ele],...], straight }
    this.undoStack = [];
    this.onChange = onChange;
    this.busy = 0;
  }

  snapshot() {
    this.undoStack.push(JSON.stringify({ waypoints: this.waypoints, legs: this.legs }));
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const { waypoints, legs } = JSON.parse(prev);
    this.waypoints = waypoints;
    this.legs = legs;
    this.onChange();
  }

  async addWaypoint(lngLat) {
    this.snapshot();
    this.waypoints.push(lngLat);
    if (this.waypoints.length > 1) {
      await this.rebuildLeg(this.legs.length, 'push');
    }
    this.onChange();
  }

  async moveWaypoint(i, lngLat) {
    this.snapshot();
    this.waypoints[i] = lngLat;
    const jobs = [];
    if (i > 0) jobs.push(this.rebuildLeg(i - 1));
    if (i < this.waypoints.length - 1) jobs.push(this.rebuildLeg(i));
    await Promise.all(jobs);
    this.onChange();
  }

  async deleteWaypoint(i) {
    this.snapshot();
    this.waypoints.splice(i, 1);
    if (i === 0) {
      this.legs.shift();
    } else if (i === this.legs.length) {
      this.legs.pop();
    } else {
      this.legs.splice(i - 1, 2, null);
      await this.rebuildLeg(i - 1, 'replace-null');
    }
    this.onChange();
  }

  async rebuildLeg(i, mode) {
    this.busy++;
    this.onChange();
    try {
      const leg = await routeLeg(this.waypoints[i], this.waypoints[i + 1]);
      if (mode === 'push') this.legs.push(leg);
      else this.legs[i] = leg;
    } finally {
      this.busy--;
    }
  }

  clear() {
    this.snapshot();
    this.waypoints = [];
    this.legs = [];
    this.onChange();
  }

  // Full track as one coord array (legs already share endpoints closely enough).
  track() {
    const out = [];
    for (const leg of this.legs) {
      if (!leg) continue;
      const start = out.length ? 1 : 0; // skip duplicated joint point
      for (let i = start; i < leg.coords.length; i++) out.push(leg.coords[i]);
    }
    return out;
  }

  stats(coords = this.track()) {
    const distMi = trackLengthM(coords) / M_PER_MI;
    let gainM = 0;
    let ref = coords.length ? coords[0][2] ?? 0 : 0;
    for (const c of coords) {
      const e = c[2] ?? ref;
      if (e > ref + GAIN_HYSTERESIS_M) {
        gainM += e - ref;
        ref = e;
      } else if (e < ref - GAIN_HYSTERESIS_M) {
        ref = e;
      }
    }
    return { distMi, gainFt: gainM * FT_PER_M };
  }

  toJSON() {
    return { waypoints: this.waypoints, legs: this.legs };
  }

  fromJSON(data) {
    this.snapshot();
    this.waypoints = data.waypoints || [];
    this.legs = data.legs || [];
    this.onChange();
  }
}

export { M_PER_MI, FT_PER_M };
