import { appState } from './appstate.js';
import { diagnostics } from './diagnosticlog.js';

// The launcher supplies SQLite. Static previews retain their browser-only behavior.
export async function openProjectStorage() {
  const endpoint = new URL('api/projects', document.baseURI);
  const badge = document.querySelector('#save-status'), historyButton = document.querySelector('#historybtn');
  let mode = 'disk', initial = null, revision = null, store, dataFile = 'Documents/Plan/plan.db';
  let pending = null, inFlight = false, blocked = false, lastSaved = null, uncertain = null;
  const controls = () => { if (historyButton) historyButton.disabled = mode !== 'disk' || blocked || inFlight || pending !== null; };
  const paint = (text, kind = '', detail = '', clickable = false) => {
    badge.textContent = text; badge.dataset.state = kind; badge.title = detail || text; badge.disabled = !clickable; controls();
    diagnostics.record('storage.status', { mode, status: kind, message: text, ...(kind === 'error' ? { detail } : {}) }, kind === 'error' ? 'error' : 'info');
  };
  const saved = () => paint('Saved to this computer', 'saved', `App state and history save automatically to ${dataFile}`);
  paint('Loading saved app state…');
  const loadOperation = diagnostics.begin('storage.load');
  try {
    const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.status === 404 || response.status === 405) {
      mode = 'browser'; paint('Saved in this browser', '', 'Run start.bat to save app state and history to Documents/Plan/plan.db.');
    } else {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Cannot load saved app state');
      if (!('revision' in result) || !('state' in result)) throw new Error('Unknown app storage format');
      initial = result.state; revision = result.revision; dataFile = result.dataFile || dataFile;
      lastSaved = initial ? JSON.stringify(initial) : null; saved();
    }
  } catch (e) {
    loadOperation.fail(e);
    mode = 'unavailable';
    paint('Disk unavailable · Browser only', 'error', `${e.message}. Existing disk data is preserved. Check the server window, then reopen the app.`);
  }
  loadOperation.end({ mode, hasSavedState: !!initial });
  appState.restore(initial ? initial.browser || {} : null);

  function markStale() {
    diagnostics.record('storage.stale', {}, 'warn');
    blocked = true; pending = null;
    if (store) store.stale = true;
    paint('Changed elsewhere · Reload', 'error', 'Another window saved the app state. Reload to load its changes.', true);
  }

  async function flush() {
    if (mode !== 'disk' || inFlight || blocked || pending === null) return;
    if (store.stale) { markStale(); return; }
    if (pending === lastSaved) { pending = null; saved(); return; }
    const sent = pending; pending = null; inFlight = true;
    paint('Saving…', 'saving');
    const operation = diagnostics.begin('storage.save', { characters: sent.length, reconciling: uncertain !== null });
    let failed = false, attempted = false;
    try {
      // A lost response may follow a successful commit. Reconcile before retrying newer edits.
      if (uncertain !== null) {
        const check = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        const current = await check.json();
        if (!check.ok) throw new Error(current.error || 'Cannot check the previous save');
        if (current.revision !== revision && JSON.stringify(current.state) !== uncertain) { markStale(); return; }
        revision = current.revision; uncertain = null;
      }
      const body = `{"revision":${JSON.stringify(revision)},"state":${sent}}`;
      attempted = true;
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        keepalive: new Blob([body]).size < 60000, signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (response.status === 409) { markStale(); return; }
      if (!response.ok) throw new Error(result.error || 'Could not save app state');
      if (typeof result.revision !== 'string') throw new Error('Save acknowledgement is incomplete');
      revision = result.revision; lastSaved = sent; uncertain = null;
      if (!blocked) saved();
      operation.end();
    } catch (e) {
      operation.fail(e);
      failed = true;
      if (attempted) uncertain = sent;
      if (!blocked) {
        pending ??= sent;
        paint('Not saved to disk · Retry', 'error', e.message, true);
      }
    } finally {
      operation.end({ blocked });
      inFlight = false; controls();
      if (!failed && !blocked && pending !== null) void flush();
    }
  }

  badge.addEventListener('click', () => { if (blocked) location.reload(); else void flush(); });
  window.addEventListener('beforeunload', (e) => {
    window.dispatchEvent(new Event('pm-flush-view'));
    if (pending !== null || inFlight) { e.preventDefault(); e.returnValue = ''; }
  });

  return {
    initial, markStale,
    attach(value) {
      store = value;
      diagnostics.record('storage.attached', { mode });
      if (mode !== 'disk') return;
      store.persist = (state) => {
        if (blocked || store.stale) return;
        pending = JSON.stringify(state);
        void flush();
      };
      appState.onChange(() => store.persist(store.savedState()));
      // Only an empty database adopts browser projects. Existing SQLite state is authoritative.
      if (!initial) store.save();
    },
  };
}
