// App-owned settings. In SQLite mode only memory and the acknowledged database
// are authorities; old browser bytes are left intact for explicit legacy export.
const owned = (key) => typeof key === 'string' && key.startsWith('pm-') && !['pm-workbook-v1', 'pm-templates-v1', 'pm-proto-v2', 'pm-proto-v2:prefs'].includes(key);
const cosmetic = (key) => ['pm-selection', 'pm-grid-scroll', 'pm-gantt-views', 'pm-view-active'].includes(key);
let values = Object.create(null), ready = false, disk = false, changed = () => {}, context = null;
function read(target, key) { return target[key] ?? null; }
function clean(saved) { return Object.fromEntries(Object.entries(saved || {}).filter(([key, value]) => owned(key) && typeof value === 'string')); }
export const appState = {
  restore(saved, options = {}) {
    if ('disk' in options) disk = !!options.disk;
    if (context) { for (const key of Object.keys(context)) delete context[key]; Object.assign(context, clean(saved)); return; }
    const view = options.preserveView ? Object.fromEntries(Object.entries(values).filter(([key]) => cosmetic(key))) : {};
    values = Object.assign(Object.create(null), clean(saved), view);
    if (!saved && !disk) {
      try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (owned(key)) values[key] = localStorage.getItem(key); } } catch { /* browser storage blocked */ }
    }
    ready = true;
  },
  getItem(key) {
    if (context) return read(context, key);
    if (ready || key in values || disk) return read(values, key);
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setItem(key, value, { silent = false } = {}) {
    if (!owned(key)) return;
    value = String(value);
    const previous = this.getItem(key);
    if (previous === value) return;
    if (context) { context[key] = value; return; }
    // A substantive preference is accepted through the same boundary as an edit.
    if (disk && !silent && !cosmetic(key)) return changed(key, value);
    values[key] = value;
    if (!disk) {
      try { localStorage.setItem(key, value); } catch { /* browser preview storage unavailable */ }
      if (!silent) return changed(key, value);
    }
  },
  adopt(key, value) { if (owned(key) && typeof value === 'string') (context || values)[key] = value; },
  snapshot: () => ({ ...(context || values) }),
  onChange: (fn) => { changed = fn; },
  adoptCommitted(saved) { this.restore(saved, { disk: true, preserveView: true }); },
  // Deliberately synchronous: retaining a global context across an await would
  // divert unrelated UI activity into the pending draft. Bind each continuation.
  withContext(browserState, fn) {
    const previous = context; context = browserState;
    try { return fn(); } finally { context = previous; }
  },
  scope(browserState) {
    return { getItem: key => read(browserState, key), setItem: (key, value) => { if (owned(key)) browserState[key] = String(value); }, snapshot: () => ({ ...browserState }) };
  },
  isDisk: () => disk,
  isCosmetic: cosmetic,
};
