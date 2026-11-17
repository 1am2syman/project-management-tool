import test from 'node:test';
import assert from 'node:assert/strict';
import { openProjectStorage } from '../src/project_management_tool/web/js/storage.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function setup(fetch) {
  const badge = { dataset: {}, addEventListener(_name, handler) { this.click = handler; } };
  globalThis.document = { baseURI: 'http://127.0.0.1:5173/', querySelector: s => s === '#save-status' ? badge : null };
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.fetch = fetch;
  return badge;
}

// A minimal disk model: reads return the committed state; each POST consumes one outcome.
// 'ok' commits and acknowledges; 'reject' returns 503 without committing;
// 'lost' commits but drops the acknowledgement at the network layer.
function disk(initial = { workbook: { v: 0 } }) {
  const model = { revision: '1', state: initial, posts: [], outcomes: [], failGets: 0 };
  model.fetch = async (_url, options = {}) => {
    if (!options.method) {
      if (model.failGets > 0) { model.failGets -= 1; throw new TypeError('network'); }
      return response(200, { revision: model.revision, state: model.state });
    }
    const body = JSON.parse(options.body);
    model.posts.push(body);
    const outcome = model.outcomes.shift() || 'ok';
    if (outcome === 'reject') return response(503, { error: 'unavailable' });
    model.revision = String(Number(model.revision) + 1);
    model.state = body.state;
    if (outcome === 'lost') throw new TypeError('lost response');
    return response(200, { revision: model.revision });
  };
  return model;
}

async function open(model) {
  const badge = setup(model.fetch);
  const storage = await openProjectStorage();
  const store = { stale: false, savedState() { return {}; } };
  storage.attach(store);
  return { storage, store, badge };
}

test('storage barrier waits for queued writes and returns the acknowledged revision', async () => {
  const first = deferred(), second = deferred(); let posts = 0;
  setup(async (_url, options) => {
    if (!options.method) return response(200, { revision: '1', state: { workbook: {} } });
    return (++posts === 1 ? first : second).promise;
  });
  const storage = await openProjectStorage();
  const store = { stale: false, savedState() { return {}; } }; storage.attach(store);
  store.persist({ edit: 1 });
  store.persist({ edit: 2 });
  let settled = false;
  const result = storage.barrier().then(value => { settled = true; return value; });
  first.resolve(response(200, { revision: '2' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  second.resolve(response(200, { revision: '3' }));
  assert.equal(await result, '3');
});

test('storage barrier fails closed on failed or stale saves', async () => {
  setup(async (_url, options) => !options.method
    ? response(200, { revision: '1', state: { workbook: {} } })
    : response(503, { error: 'unavailable' }));
  const storage = await openProjectStorage();
  const store = { stale: false, savedState() { return {}; } }; storage.attach(store);
  store.persist({ edit: 1 });
  await assert.rejects(storage.barrier(), /could not be saved/);
  storage.markStale();
  await assert.rejects(storage.barrier(), /changed in another window/);
});

test('reverting to the last acknowledged state after a lost ack reconciles the committed save first', async () => {
  const model = disk(); model.outcomes = ['lost'];
  const { storage, store } = await open(model);
  store.persist({ workbook: { v: 1 } });
  await assert.rejects(storage.barrier(), /could not be saved/);
  // Reverting equals lastSaved, which must not clear the uncertain write without reconciling.
  store.persist({ workbook: { v: 0 } });
  assert.equal(await storage.barrier(), '3');
  assert.deepEqual(model.state, { workbook: { v: 0 } });
  assert.equal(model.posts[1].revision, '2');
});

test('reverting after a rejected save retries against the unchanged revision', async () => {
  const model = disk(); model.outcomes = ['reject'];
  const { storage, store } = await open(model);
  store.persist({ workbook: { v: 1 } });
  await assert.rejects(storage.barrier(), /could not be saved/);
  store.persist({ workbook: { v: 0 } });
  assert.equal(await storage.barrier(), '2');
  assert.equal(model.posts[1].revision, '1');
});

test('a lost ack followed by a different committed state is reported stale, not overwritten', async () => {
  const model = disk(); model.outcomes = ['lost'];
  const { storage, store } = await open(model);
  store.persist({ workbook: { v: 1 } });
  await assert.rejects(storage.barrier(), /could not be saved/);
  model.state = { workbook: { v: 9 } }; model.revision = '5'; // another window committed
  store.persist({ workbook: { v: 0 } });
  await assert.rejects(storage.barrier(), /changed in another window/);
  assert.equal(model.posts.length, 1);
  assert.deepEqual(model.state, { workbook: { v: 9 } });
});

test('a failed reconciliation keeps the error until Retry reconciles and saves', async () => {
  const model = disk(); model.outcomes = ['reject'];
  const { storage, store, badge } = await open(model);
  store.persist({ workbook: { v: 1 } });
  await assert.rejects(storage.barrier(), /could not be saved/);
  model.failGets = 1;
  store.persist({ workbook: { v: 0 } });
  await assert.rejects(storage.barrier(), /could not be saved/);
  assert.equal(model.posts.length, 1);
  badge.click(); // Retry
  assert.equal(await storage.barrier(), '2');
  assert.equal(model.posts.length, 2);
  assert.deepEqual(model.state, { workbook: { v: 0 } });
});
