// The app-wide list of delay causes, saved with the app's other settings (SQLite through appState), shared by every project.
import { appState } from './appstate.js';
import { cleanCauses } from './delays.js';

const KEY = 'pm-delay-causes';
export function loadCauses() {
  try { return cleanCauses(JSON.parse(appState.getItem(KEY))); } catch { return cleanCauses(null); }
}
export function saveCauses(causes) { appState.setItem(KEY, JSON.stringify(cleanCauses(causes))); }
