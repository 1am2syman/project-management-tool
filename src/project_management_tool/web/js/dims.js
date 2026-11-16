// Shared row geometry: adaptive rows use the actual Gantt body and visible task count.
import { appState } from './appstate.js';
export const DENSITY = { compact: { row: 24, bar: 18 }, roomy: { row: 34, bar: 26 } };
export const dims = { row: 24, bar: 18, msz: 14, name: 'compact' };

export function setDensity(name) {
  name = name === 'compact' ? 'compact' : 'auto';
  const d = name === 'compact' ? DENSITY.compact : DENSITY.roomy;
  Object.assign(dims, d, { name, msz: Math.round(d.bar * 0.75) });
  apply();
  try { appState.setItem('pm-density', name); } catch { /* storage unavailable */ }
}
export function fitDensity(height, count) {
  if (dims.name !== 'auto') return;
  // Grid and Gantt both include one total/blank row and 44px of bottom padding.
  const row = Math.max(24, Math.floor((height - 44) / Math.max(1, count + 1)));
  const bar = Math.min(32, Math.max(18, Math.round(row * 0.75)));
  if (row === dims.row && bar === dims.bar) return;
  Object.assign(dims, { row, bar, msz: Math.round(bar * 0.75) }); apply();
}
export function apply() {
  const s = document.documentElement.style;
  s.setProperty('--row', `${dims.row}px`);
  s.setProperty('--bar', `${dims.bar}px`);
  s.setProperty('--msz', `${dims.msz}px`);
  document.documentElement.dataset.density = dims.name;
}
export function initDensity() {
  let n = 'auto';
  try { n = appState.getItem('pm-density') || n; } catch { /* storage unavailable */ }
  setDensity(n);
}
