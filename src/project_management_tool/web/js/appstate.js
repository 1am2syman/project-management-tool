// App-owned settings/activity. Sign-in tokens remain in MSAL's browser credential cache.
const owned = (key) => typeof key === 'string' && key.startsWith('pm-') && !['pm-workbook-v1', 'pm-templates-v1', 'pm-proto-v2', 'pm-proto-v2:prefs'].includes(key);
let values = Object.create(null), ready = false, changed = () => {};
export const appState = {
  restore(saved) {
    values = Object.create(null);
    if (saved) {
      for (const [key, value] of Object.entries(saved)) if (owned(key) && typeof value === 'string') values[key] = value;
    } else {
      try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (owned(key)) values[key] = localStorage.getItem(key); } } catch { /* browser storage blocked */ }
    }
    ready = true;
  },
  getItem(key) {
    if (ready || key in values) return values[key] ?? null;
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setItem(key, value) {
    value = String(value);
    const previous = this.getItem(key);
    values[key] = value;
    try { localStorage.setItem(key, value); } catch { /* SQLite can still save */ }
    if (previous !== value) changed();
  },
  snapshot: () => ({ ...values }),
  onChange: (fn) => { changed = fn; },
};
