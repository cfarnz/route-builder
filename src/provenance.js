// Provenance: which source answered, when, and whether it was cached or stale.
//
// Every provider reports here and the sidebar renders it. Borrowed from
// PeakHut, where each response carries its provider and fetch time so you can
// tell a bad source from a bad mapping.

const sources = new Map();
const listeners = new Set();

export function record(name, info = {}) {
  sources.set(name, { name, at: Date.now(), ...info });
  listeners.forEach((fn) => fn(list()));
}

export const list = () => [...sources.values()].sort((a, b) => b.at - a.at);

export function onChange(fn) {
  listeners.add(fn);
  fn(list());
}

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`;
}
