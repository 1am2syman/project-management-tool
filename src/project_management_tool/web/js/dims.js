// Shared row geometry. CSS reads the same values through custom properties set by apply().
export const DENSITY = { compact: { row: 24, bar: 15 }, roomy: { row: 34, bar: 22 } };
export const dims = { row: 24, bar: 15, msz: 11, name: 'compact' };

export function setDensity(name) {
  const d = DENSITY[name] || DENSITY.compact;
  Object.assign(dims, d, { name, msz: Math.round(d.bar * 0.75) });
  apply();
  try { localStorage.setItem('pm-density', name); } catch { /* storage unavailable */ }
}
export function apply() {
  const s = document.documentElement.style;
  s.setProperty('--row', `${dims.row}px`);
  s.setProperty('--bar', `${dims.bar}px`);
  s.setProperty('--msz', `${dims.msz}px`);
  document.documentElement.dataset.density = dims.name;
}
export function initDensity() {
  let n = 'compact';
  try { n = localStorage.getItem('pm-density') || n; } catch { /* storage unavailable */ }
  setDensity(n);
}
