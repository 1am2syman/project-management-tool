import { appState } from './appstate.js';
import { diagnostics } from './diagnosticlog.js';
import { changesBetween, sameJSON } from './changes.js';

// SQLite production startup is fail-closed. Static previews opt in explicitly.
export async function openProjectStorage() {
  const endpoint = new URL('api/projects', document.baseURI);
  const healthEndpoint = new URL('api/health', document.baseURI);
  const badge = document.querySelector('#save-status'), historyButton = document.querySelector('#historybtn');
  const browserOnly = document.documentElement?.dataset.storage === 'browser';
  let store, initial = null, base = null, revision = null, dataFile = null;
  let attempt = null, fault = null, rejected = null, blocked = false, retrying = false, writer = browserOnly, releaseLock;
  const acknowledged = new Set();
  const paint = (text, kind = '', detail = '', clickable = false) => {
    if (badge) { badge.textContent = text; badge.dataset.state = kind; badge.title = detail || text; badge.disabled = !clickable; }
    if (historyButton) historyButton.disabled = browserOnly || !!fault || !!store?.pending;
    diagnostics.record('storage.status', { mode: browserOnly ? 'browser' : 'disk', status: kind, message: text }, kind === 'error' ? 'error' : 'info');
  };
  const saved = () => paint(writer ? 'Saved to this computer' : 'Read-only · Writer in another tab', writer ? 'saved' : 'readonly', writer ? `Accepted actions are committed to ${dataFile}` : 'Close the editing tab, then reload to edit.');
  const json = async (url, options = {}) => {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
    let result;
    try { result = await response.json(); } catch { throw new Error('The local service returned an unreadable response.'); }
    if (!response.ok) {
      const error = new Error(result.error || `Local storage request failed (${response.status}).`);
      error.status = response.status; error.validation = response.status === 400 || response.status === 413;
      throw error;
    }
    return result;
  };
  function verifyIdentity(result) {
    if (typeof result.dataFile !== 'string' || result.dataFile !== dataFile) {
      blocked = true;
      throw new Error('The database identity changed. Close all tabs and restart Plan with the expected database.');
    }
  }
  async function health() {
    const result = await json(healthEndpoint);
    if (result.app !== 'plan-local' || typeof result.dataFile !== 'string' || !result.dataFile) throw new Error('Cannot verify the local Plan database.');
    if (dataFile !== null) verifyIdentity(result);
    return result;
  }
  async function read() {
    const result = await json(endpoint); verifyIdentity(result);
    if (!Object.hasOwn(result, 'state') || !(typeof result.revision === 'string' || result.revision === null) || (result.state === null) !== (result.revision === null)) throw new Error('Unknown app storage format.');
    return result;
  }
  async function acquire() {
    if (!globalThis.navigator?.locks?.request) throw new Error('This browser does not support the writer lock. Open Plan in a browser with Web Locks support.');
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const held = new Promise(resolve => { releaseLock = resolve; });
    void navigator.locks.request(`plan-workspace:${dataFile}`, { mode: 'exclusive', ifAvailable: true }, lock => {
      resolveReady(!!lock);
      return lock ? held : undefined;
    }).catch(rejectReady);
    return ready;
  }
  function markStale() {
    blocked = true; fault = new Error('App state changed in another window. Copy the pending project, then reload.');
    if (store) { store.stale = true; store.suspend?.(fault); }
    paint('Changed elsewhere · Copy, then reload', 'error', fault.message);
  }
  function acknowledge(state, result) {
    verifyIdentity(result);
    if (typeof result.revision !== 'string') throw new Error('Save acknowledgement is incomplete.');
    base = state; revision = result.revision; acknowledged.add(revision);
    attempt = null; fault = null; rejected = null; saved();
    return result;
  }
  async function send(frozenAttempt) {
    const operation = diagnostics.begin('storage.commit', { bytes: new TextEncoder().encode(frozenAttempt.body).length, bootstrap: frozenAttempt.base === null });
    paint('Pending · Committing action…', 'saving');
    try {
      const result = await json(frozenAttempt.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: frozenAttempt.body });
      const ack = acknowledge(frozenAttempt.result, result); operation.end(); return ack;
    } catch (error) {
      operation.fail(error); fault = error;
      if (error.validation) { attempt = null; fault = null; rejected = error; }
      paint(blocked ? 'Wrong database · Reload required' : error.validation ? 'Action rejected · Correct the input' : 'Action unconfirmed · Retry or Download copy', 'error', `${error.message} Download copy remains available.`, !blocked && !error.validation);
      throw error;
    }
  }
  async function commit(candidate) {
    if (!writer) throw new Error('This tab is read-only. Close the writer and reload before editing.');
    if (blocked || fault || attempt) throw fault || new Error('Resolve the previous action before editing.');
    rejected = null;
    const changes = base === null ? null : changesBetween(base, candidate);
    if (changes?.length === 0) return { revision, dataFile };
    // Exact base/result and serialized change set are retained unchanged until
    // acknowledgement or read-before-retry reconciliation has determined outcome.
    attempt = { base, revision, result: candidate,
      url: changes === null ? endpoint : new URL('api/projects/changes', document.baseURI),
      body: JSON.stringify(changes === null ? { revision, state: candidate } : { revision, changes }) };
    return send(attempt);
  }
  async function retry() {
    if (!attempt || blocked || retrying || !writer || store?.pending) return;
    retrying = true;
    const pending = attempt;
    paint('Checking unconfirmed action…', 'saving');
    try {
      await health();
      const current = await read();
      let ack;
      if (sameJSON(current.state, pending.result)) ack = acknowledge(pending.result, current);
      else if (current.revision === pending.revision && sameJSON(current.state, pending.base)) {
        // A delayed original competes with this immutable retry at the same
        // expected revision. A 409 is reconciled on the next explicit retry.
        fault = null; ack = await send(pending);
      } else { markStale(); return; }
      store?.adoptPending(pending.result, ack);
    } catch (error) {
      fault = error;
      paint(blocked ? 'Wrong database · Reload required' : 'Action unconfirmed · Retry or Download copy', 'error', error.message, !blocked);
    } finally { retrying = false; }
  }

  paint('Loading saved app state…');
  if (browserOnly) { appState.restore(null, { disk: false }); paint('Saved in this browser'); }
  else {
    try {
      dataFile = (await health()).dataFile;
      writer = await acquire();
      const result = await read();
      initial = result.state; base = initial; revision = result.revision;
      if (base === null && !writer) throw new Error('The editing tab is initializing this empty database. Reload once it finishes.');
      if (revision !== null) acknowledged.add(revision);
      appState.restore(initial?.browser || {}, { disk: true }); saved();
    } catch (error) {
      releaseLock?.(); paint('Storage unavailable · Open Log', 'error', error.message);
      diagnostics.record('storage.startup.failure', { error }, 'error'); throw error;
    }
  }
  badge?.addEventListener('click', () => { if (blocked) return; void retry(); });
  window.addEventListener('beforeunload', event => {
    if (attempt || store?.pending || store?.unsubmitted) { event.preventDefault(); event.returnValue = ''; }
  });
  return {
    initial, writer, markStale, retry, commit,
    mode: () => browserOnly ? 'browser' : 'disk',
    expectedDataFile: () => dataFile,
    async ownsRevision(value) { await store?.whenIdle?.(); return acknowledged.has(value); },
    async currentRevision() { await health(); return (await read()).revision; },
    async barrier() {
      if (browserOnly) return null;
      await store?.whenIdle?.();
      if (blocked || fault || attempt || store?.suspended) throw fault || new Error('Resolve the unconfirmed workspace action before saving. Use Download copy during an outage.');
      if (store?.unsubmitted) throw new Error('Finish or correct the unsubmitted input before saving. Download copy can save the current accepted project.');
      await health();
      return revision;
    },
    async attach(value) {
      store = value;
      if (browserOnly) return;
      store.locked = !writer;
      store.enableCommits(commit);
      if (base === null && writer) {
        try { await commit(store.savedState()); }
        catch (error) {
          // No editable app has been mounted yet. Release the writer and make
          // startup fail cleanly; reopening reconciles any committed lost ack.
          attempt = null; blocked = true; fault = error; releaseLock?.();
          store.suspend?.(error);
          paint('Storage initialization failed · Reload', 'error', error.message);
          throw error;
        }
      }
      appState.onChange((key, value) => store.commit(draft => {
        draft.appState.setItem(key, value);
      }).catch(error => { diagnostics.record('storage.preference.failure', { error }, 'error'); throw error; }));
      store.on(kind => {
        // A definitive rejection describes input that is still held. Once that
        // input is discarded or corrected (unsubmitted cleared), nothing is left
        // to correct, so the status returns to the accepted state.
        if (rejected && kind !== 'pending' && kind !== 'suspended' && !store.unsubmitted && !store.pending && !store.suspended) rejected = null;
        if (kind === 'pending') paint('Pending · Committing action…', 'saving');
        else if (rejected) paint('Action rejected · Correct the input', 'error', rejected.message);
        else if (store.unsubmitted && !fault && !attempt) paint('Unsubmitted input · Press Enter or Apply', 'unsaved');
        else if (!fault && !attempt) saved();
      });
      saved();
    },
  };
}
