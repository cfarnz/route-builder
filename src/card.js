// Renders a location summary into a map popup. Built as DOM rather than an
// HTML string: alert headlines and zone names come from remote feeds and
// should never be parsed as markup.

import { compass, slopeBand } from './summary.js';

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

function row(parent, label, value, className) {
  if (value === null || value === undefined || value === '') return;
  const r = el('div', 'card-row' + (className ? ` ${className}` : ''));
  r.append(el('span', 'card-label', label), el('span', 'card-value', value));
  parent.appendChild(r);
}

function section(parent, title) {
  const s = el('div', 'card-section');
  s.appendChild(el('h4', null, title));
  parent.appendChild(s);
  return s;
}

export function renderCard(summary) {
  const { point, terrain, weather, alerts, avalanche } = summary;
  const card = el('div', 'summary-card');

  const head = el('div', 'card-head');
  head.appendChild(
    el('b', null, terrain ? `${Math.round(terrain.elevationFt).toLocaleString()} ft` : 'Elevation unavailable')
  );
  head.appendChild(el('span', 'card-coords', `${point[1].toFixed(4)}, ${point[0].toFixed(4)}`));
  card.appendChild(head);

  // ---------- terrain ----------
  if (terrain) {
    const s = section(card, 'Terrain');
    const band = slopeBand(terrain.slopeDeg);
    row(
      s,
      'Slope',
      `${terrain.slopeDeg.toFixed(0)}°`,
      band === 'avy' ? 'warn' : band === 'steep' ? 'danger' : null
    );
    row(
      s,
      'Aspect',
      terrain.aspectDeg === null
        ? 'flat'
        : `${compass(terrain.aspectDeg)} (${Math.round(terrain.aspectDeg)}°)`
    );
    if (band === 'avy') {
      s.appendChild(el('p', 'card-note warn', 'In the 30–45° band where most slab avalanches release.'));
    }
    s.appendChild(
      el(
        'p',
        'card-note',
        `Derived from ${terrain.demProvider} at ${terrain.demResolutionM} m, ` +
          `sampled ${terrain.spacingM} m apart. Treat as approximate.`
      )
    );
  }

  // ---------- weather ----------
  if (weather) {
    const s = section(card, 'Weather');
    if (weather.tempF !== undefined) {
      row(s, 'Now', `${Math.round(weather.tempF)}°F${weather.conditions ? `, ${weather.conditions}` : ''}`);
    }
    if (weather.windMph !== undefined) {
      row(
        s,
        'Wind',
        `${Math.round(weather.windMph)} mph${weather.windDir !== undefined ? ` from ${compass(weather.windDir)}` : ''}`
      );
    }
    if (weather.highF !== undefined) {
      row(s, 'Today', `${Math.round(weather.highF)}° / ${Math.round(weather.lowF)}°`);
    }
    const precip = (weather.precipIn || []).reduce((a, b) => a + (b || 0), 0);
    if (precip > 0) row(s, 'Precip, 3 day', `${precip.toFixed(2)}"`);
  }

  // ---------- avalanche ----------
  if (avalanche) {
    const s = section(card, 'Avalanche');
    row(s, 'Zone', avalanche.zone);
    if (avalanche.offSeason) {
      s.appendChild(el('p', 'card-note', 'No rating issued. CAIC forecasts run roughly November through May.'));
    } else {
      const level = el('div', 'card-row');
      level.append(el('span', 'card-label', 'Danger'));
      const v = el('span', 'card-value danger-pill', `${avalanche.level} — ${avalanche.danger}`);
      if (avalanche.color) {
        v.style.background = avalanche.color;
        v.style.color = '#111';
      }
      level.appendChild(v);
      s.appendChild(level);
      if (avalanche.warning) s.appendChild(el('p', 'card-note danger', avalanche.warning));
      if (avalanche.advice) s.appendChild(el('p', 'card-note', avalanche.advice));
    }
  }

  // ---------- alerts ----------
  if (alerts && alerts.length) {
    const s = section(card, `Active alerts (${alerts.length})`);
    for (const a of alerts.slice(0, 3)) {
      s.appendChild(el('p', 'card-note danger', a.headline || a.event));
    }
  }

  // Always last, always present. A slope angle and a danger rating shown
  // together read as a recommendation unless something says otherwise.
  const disc = el('p', 'card-disclaimer');
  disc.append(
    el('b', null, 'Not an avalanche forecast. '),
    document.createTextNode(
      'This is reference data from automated sources. Read the full CAIC bulletin ' +
        'and make your own field observations before committing to terrain.'
    )
  );
  card.appendChild(disc);

  return card;
}
