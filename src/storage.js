// Saved routes in localStorage: { [name]: { waypoints, legs, savedAt } }

const KEY = 'route-builder:routes';

export function listRoutes() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export function saveRoute(name, data) {
  const all = listRoutes();
  all[name] = { ...data, savedAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function deleteRoute(name) {
  const all = listRoutes();
  delete all[name];
  localStorage.setItem(KEY, JSON.stringify(all));
}
