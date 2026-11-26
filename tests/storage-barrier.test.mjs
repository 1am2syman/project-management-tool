import test from 'node:test';
import assert from 'node:assert/strict';
import { openProjectStorage } from '../src/project_management_tool/web/js/storage.js';
import { changesBetween, sameJSON } from '../src/project_management_tool/web/js/changes.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import { Store } from '../src/project_management_tool/web/js/model.js';

const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const identity = '/isolated/plan.db';
function apply(state, changes) {
  const result = structuredClone(state);
  for (const change of changes) {
    let parent = result;
    for (const key of change.path.slice(0, -1)) parent = parent[key];
    const key = change.path.at(-1);
    if (change.op === 'set') parent[key] = change.value;
    else if (change.op === 'remove') delete parent[key];
    else { const array = change.path.length ? parent[key] : result; array.splice(change.start, change.deleteCount, ...change.items); }
  }
  return result;
}
function setup({ state = { workbook: { value: 0 }, browser: {} }, revision = '1', writer = true } = {}) {
  const badge = { dataset: {}, addEventListener(_name, handler) { this.click = handler; } };
  const model = { state, revision, identity, posts: [], calls: [], outcomes: [], healthStatus: 200, loadStatus: 200, lockHeld: false };
  globalThis.document = { documentElement: { dataset: {} }, baseURI: 'http://127.0.0.1:5173/', querySelector: s => s === '#save-status' ? badge : null };
  globalThis.window = { addEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, _options, fn) => { model.lockHeld = writer; try { return await fn(writer ? {} : null); } finally { model.lockHeld = false; } } } } });
  globalThis.localStorage = { getItem() { throw new Error('Legacy state must not be read'); }, setItem() { throw new Error('Shadow writes forbidden'); } };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname; model.calls.push(path);
    if (path === '/api/health') return response(model.healthStatus, { app: 'plan-local', dataFile: model.identity });
    if (!options.method) return response(model.loadStatus, { revision: model.revision, state: structuredClone(model.state), dataFile: model.identity });
    const body = JSON.parse(options.body); model.posts.push(body);
    const outcome = model.outcomes.shift();
    if (outcome === 'reject') return response(503, { error: 'disk full' });
    if (outcome === 'validation') return response(400, { error: 'Invalid task' });
    if (body.revision !== model.revision) return response(409, { error: 'revision conflict' });
    model.state = body.changes ? apply(model.state, body.changes) : body.state;
    model.revision = String(Number(model.revision || 0) + 1);
    if (outcome === 'lost') throw new TypeError('lost response');
    return response(200, { revision: model.revision, dataFile: model.identity });
  };
  return { model, badge };
}
async function open(options) {
  const fixture = setup(options), storage = await openProjectStorage();
  const store = { savedState: () => ({ workbook: { value: 0 }, browser: {} }), enableCommits(fn) { this.persist = fn; }, on() {}, whenIdle: async () => {}, adoptPending(state) { this.adopted = state; this.suspended = false; } };
  await storage.attach(store); return { ...fixture, storage, store };
}

test('startup reads health, acquires canonical lock, then loads without reading legacy storage', async () => {
  const { model, storage } = await open();
  assert.deepEqual(model.calls, ['/api/health', '/api/projects']);
  assert.equal(storage.writer, true); assert.equal(model.posts.length, 0);
});
test('startup fails closed on missing service, load failure, wrong identity, and unavailable locking', async () => {
  for (const status of [404, 405, 503]) { const { model } = setup(); model.healthStatus = status; await assert.rejects(openProjectStorage()); }
  { const { model } = setup(); model.loadStatus = 503; await assert.rejects(openProjectStorage()); }
  { setup(); globalThis.navigator.locks = null; await assert.rejects(openProjectStorage(), /writer lock/); }
  { setup(); const realFetch = fetch; globalThis.fetch = async (url, options) => new URL(url).pathname === '/api/projects' ? response(200, { state: {}, revision: '1', dataFile: '/wrong.db' }) : realFetch(url, options); await assert.rejects(openProjectStorage(), /identity/); }
});
test('second same-profile tab loads read-only; empty database bootstraps once with explicit null base', async () => {
  const readonly = await open({ writer: false }); assert.equal(readonly.store.locked, true); assert.equal(readonly.model.posts.length, 0);
  await assert.rejects(readonly.store.persist({ workbook: {} }), /read-only/);
  const fresh = await open({ state: null, revision: null });
  assert.equal(fresh.model.posts.length, 1); assert.equal(fresh.model.posts[0].revision, null);
  assert.deepEqual(fresh.model.posts[0].state, fresh.store.savedState());
});
test('ordinary edits send final changed data and barrier verifies service identity', async () => {
  const { model, store, storage } = await open();
  await store.persist({ workbook: { value: 1 }, browser: {} });
  assert.deepEqual(model.posts[0], { revision: '1', changes: [{ op: 'set', path: ['workbook', 'value'], value: 1 }] });
  assert.equal(await storage.barrier(), '2');
  model.identity = '/replaced.db'; await assert.rejects(storage.barrier(), /identity/);
});
test('lost acknowledgement adopts structurally matching disk result without replay', async () => {
  const { model, store, storage } = await open(); model.outcomes = ['lost'];
  const candidate = { workbook: { value: 1 }, browser: {} };
  await assert.rejects(store.persist(candidate), /lost response/);
  await assert.rejects(storage.barrier());
  model.state = { browser: {}, workbook: { value: 1 } };
  await storage.retry(); assert.deepEqual(store.adopted, candidate); assert.equal(model.posts.length, 1); assert.equal(await storage.barrier(), '2');
});
test('rejected commit resends exact immutable change set only after original base is verified', async () => {
  const { model, store, storage } = await open(); model.outcomes = ['reject'];
  const candidate = { workbook: { value: 1 }, browser: {} };
  await assert.rejects(store.persist(candidate), /disk full/);
  await storage.retry(); assert.deepEqual(model.posts[0], model.posts[1]); assert.deepEqual(store.adopted, candidate);
});
test('same revision at wrong identity and different disk content never permit retry writes', async () => {
  for (const wrongIdentity of [false, true]) {
    const { model, store, storage } = await open(); model.outcomes = ['reject'];
    await assert.rejects(store.persist({ workbook: { value: 1 }, browser: {} }));
    if (wrongIdentity) model.identity = '/wrong.db'; else model.state.workbook.value = 9;
    await storage.retry(); assert.equal(model.posts.length, 1); assert.equal(store.adopted, undefined); await assert.rejects(storage.barrier());
  }
});
test('validation error leaves prior state and permits corrected resubmission', async () => {
  const { model, store, storage } = await open(); model.outcomes = ['validation'];
  await assert.rejects(store.persist({ workbook: { value: 'bad' }, browser: {} }), error => error.validation);
  assert.equal(model.state.workbook.value, 0);
  // User correction is a new candidate; the rejected request cannot be retried.
  await storage.retry(); assert.equal(model.posts.length, 1);
});
test('real Store barrier recovers after rejected input is discarded without needing another edit', async () => {
  const store = new Store(null, { disk: true });
  const { model } = setup({ state: store.savedState() }), storage = await openProjectStorage();
  await storage.attach(store);
  const original = store.tasks[0].name;
  store.unsubmitted = true;
  model.outcomes = ['validation'];
  await assert.rejects(store.setCell(store.tasks[0].id, 'name', 'Rejected edit'), /Invalid task/);
  assert(!store.pending); assert(!store.suspended); assert.equal(store.pendingCandidate, null);
  assert.equal(store.tasks[0].name, original);
  await assert.rejects(storage.barrier(), /unsubmitted input/);
  // Cancelling the rejected editor discards its text; no Store command is run.
  store.unsubmitted = false;
  assert.equal(await storage.barrier(), '1');
  assert.equal(model.posts.length, 1);
  model.identity = '/replaced.db';
  await assert.rejects(storage.barrier(), /identity/);
});

test('change derivation handles array edits, escaped keys, capped undo splice and structural equality', () => {
  const history = Array.from({ length: 150 }, (_, i) => `snapshot-${i}`);
  const before = { 'a/b~%': { tasks: [{ id: 1, name: 'one' }], history }, unchanged: { text: 'x'.repeat(100000) } };
  const after = { ...before, 'a/b~%': { tasks: [{ id: 1, name: 'edited' }], history: [...history.slice(1), 'new'] } };
  const patch = changesBetween(before, after);
  assert.deepEqual(apply(before, patch), after);
  assert(!JSON.stringify(patch).includes('xxxxx'));
  assert(sameJSON({ a: [1], b: 2 }, { b: 2, a: [1] })); assert(!sameJSON([1, 2], [2, 1]));
  // A capped stack shift must send the new snapshot alone, not all retained snapshots.
  assert(JSON.stringify(patch).length < 1000);
});
test('disk app settings have isolated draft contexts and no shadow writes', async () => {
  setup(); appState.restore({ 'pm-focus': '1', 'pm-selection': '{}' }, { disk: true });
  const draft = appState.snapshot(); appState.withContext(draft, () => appState.setItem('pm-focus', '0'));
  assert.equal(appState.getItem('pm-focus'), '1'); assert.equal(draft['pm-focus'], '0');
  appState.setItem('pm-selection', '{"s1":1}');
  appState.adoptCommitted(draft); assert.equal(appState.getItem('pm-selection'), '{"s1":1}');
});

test('failed empty bootstrap releases lock and has no active retry into an unmounted coordinator', async () => {
  for (const outcome of ['reject', 'lost']) {
    const { model, badge } = setup({ state: null, revision: null });
    const storage = await openProjectStorage(); model.outcomes = [outcome];
    const store = { savedState: () => ({ workbook: { value: 0 }, browser: {} }), enableCommits() {}, suspend() {}, on() {} };
    await assert.rejects(storage.attach(store), /disk full|lost response/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.lockHeld, false);
    const count = model.posts.length;
    await storage.retry(); badge.click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.posts.length, count, 'startup error must not retain a retry writer');
    if (outcome === 'lost') assert.equal(model.state.workbook.value, 0, 'committed lost ack is found on reopening');
  }
});
test('read-only tab cannot display fabricated state while empty database is initializing', async () => {
  const { model } = setup({ state: null, revision: null, writer: false });
  await assert.rejects(openProjectStorage(), /initializing.*empty database/);
  assert.equal(model.posts.length, 0);
});
test('simultaneous retry clicks reconcile once and wrong-identity acknowledgement disables retry', async () => {
  const { model, store, storage } = await open(); model.outcomes = ['reject'];
  await assert.rejects(store.persist({ workbook: { value: 1 }, browser: {} }));
  await Promise.all([storage.retry(), storage.retry()]);
  assert.equal(model.posts.length, 2);
  assert.equal(store.adopted.workbook.value, 1);
  const fresh = await open(); const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const result = await realFetch(url, options);
    if (options?.method) return response(200, { revision: '2', dataFile: '/wrong.db' });
    return result;
  };
  await assert.rejects(fresh.store.persist({ workbook: { value: 2 }, browser: {} }), /identity/);
  assert.equal(fresh.badge.disabled, true); assert.match(fresh.badge.textContent, /Wrong database/);
});
test('validation rejection remains visible until corrected candidate is accepted', async () => {
  const { model, store, storage, badge } = await open(); model.outcomes = ['validation'];
  await assert.rejects(store.persist({ workbook: { value: 'bad' }, browser: {} }));
  assert.match(badge.textContent, /Action rejected/);
  await store.persist({ workbook: { value: 3 }, browser: {} });
  assert.equal(await storage.barrier(), '2'); assert.equal(badge.dataset.state, 'saved');
});

test('large affected component diff stays within patch dialect operation count without unrelated data', () => {
  const tasks = Array.from({ length: 3000 }, (_, id) => ({ id: id + 1, name: `Task ${id}`, start: 1, dur: 1 }));
  const before = { workbook: { active: 's1', sheets: [{ id: 's1', data: { tasks, links: [] } }, { id: 's2', data: { tasks: [{ id: 1, name: 'unrelated project' }] } }] }, history: { s2: { u: ['unrelated history'.repeat(10000)] } } };
  const after = { ...before, workbook: { ...before.workbook, sheets: [{ ...before.workbook.sheets[0], data: { tasks: tasks.map(task => ({ ...task, name: `${task.name} changed` })), links: [] } }, before.workbook.sheets[1]] } };
  const patch = changesBetween(before, after);
  assert.equal(patch.length, 1);
  assert.deepEqual(patch[0].path, ['workbook', 'sheets', 0, 'data', 'tasks']);
  assert.deepEqual(apply(before, patch), after);
  assert(!JSON.stringify(patch).includes('unrelated'));
});
