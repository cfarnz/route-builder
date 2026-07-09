// SVG elevation profile with hover readout + synced map marker.

import { haversineM } from './router.js';
import { M_PER_MI, FT_PER_M } from './route.js';

export class Profile {
  constructor(svg, tip, onHover) {
    this.svg = svg;
    this.tip = tip;
    this.onHover = onHover; // (lngLat | null)
    this.points = []; // { distMi, eleFt, lngLat }
    svg.addEventListener('mousemove', (e) => this.hover(e));
    svg.addEventListener('mouseleave', () => {
      this.tip.hidden = true;
      this.onHover(null);
    });
  }

  render(coords) {
    this.points = [];
    this.svg.innerHTML = '';
    if (coords.length < 2) return;

    let acc = 0;
    for (let i = 0; i < coords.length; i++) {
      if (i > 0) acc += haversineM(coords[i - 1], coords[i]);
      this.points.push({
        distMi: acc / M_PER_MI,
        eleFt: (coords[i][2] ?? 0) * FT_PER_M,
        lngLat: [coords[i][0], coords[i][1]],
      });
    }

    const W = 1000;
    const H = 130;
    const PAD = 8;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const maxD = this.points[this.points.length - 1].distMi || 1;
    const eles = this.points.map((p) => p.eleFt);
    const minE = Math.min(...eles);
    const maxE = Math.max(...eles, minE + 100);
    const x = (d) => PAD + (d / maxD) * (W - 2 * PAD);
    const y = (e) => H - PAD - ((e - minE) / (maxE - minE)) * (H - 2 * PAD);
    this.x = x;
    this.maxD = maxD;

    const line = this.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.distMi).toFixed(1)},${y(p.eleFt).toFixed(1)}`).join('');
    const area = `${line}L${x(maxD).toFixed(1)},${H - PAD}L${PAD},${H - PAD}Z`;

    this.svg.innerHTML =
      `<path d="${area}" fill="#e07a3f33"/>` +
      `<path d="${line}" fill="none" stroke="#e07a3f" stroke-width="2"/>` +
      `<line id="cursor" x1="0" x2="0" y1="${PAD}" y2="${H - PAD}" stroke="#fff8" stroke-width="1" visibility="hidden"/>`;
  }

  hover(e) {
    if (!this.points.length) return;
    const rect = this.svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const d = frac * this.maxD;
    // nearest point by distance
    let best = this.points[0];
    for (const p of this.points) if (Math.abs(p.distMi - d) < Math.abs(best.distMi - d)) best = p;

    const cursor = this.svg.querySelector('#cursor');
    if (cursor) {
      cursor.setAttribute('x1', this.x(best.distMi));
      cursor.setAttribute('x2', this.x(best.distMi));
      cursor.setAttribute('visibility', 'visible');
    }
    this.tip.hidden = false;
    this.tip.style.left = `${frac * 100}%`;
    this.tip.style.top = '30%';
    this.tip.textContent = `${best.distMi.toFixed(1)} mi · ${Math.round(best.eleFt).toLocaleString()} ft`;
    this.onHover(best.lngLat);
  }
}
