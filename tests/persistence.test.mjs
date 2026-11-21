import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';

let memory;
beforeEach(() => {
  memory = new Map();
  globalThis.localStorage = {
    get length() { return memory.size; },
    key: (index) => [...memory.keys()][index],
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
  };
  appState.onChange(() => {}); appState.restore({});
});
const saved = (store) => JSON.parse(JSON.stringify(store.savedState()));

test('fresh browser restores separate project undo/redo stacks and their edits', () => {
  const store = new Store(); store.auto = false;
  const first = store.wb.active, original = store.byId.get(3).name;
  store.setCell(3, 'name', 'Alpha edited');
  const second = store.newBlank(); store.setCell(2, 'name', 'Beta edited'); store.undo();
  store.switchSheet(first); const state = saved(store);
  memory.clear(); const restored = new Store(state);
  assert.equal(restored.byId.get(3).name, 'Alpha edited');
  restored.undo(); assert.equal(restored.byId.get(3).name, original);
  restored.redo(); assert.equal(restored.byId.get(3).name, 'Alpha edited');
  restored.switchSheet(second); assert.equal(restored.byId.get(2).name, 'First task');
  restored.redo(); assert.equal(restored.byId.get(2).name, 'Beta edited');
  restored.undo(); assert.equal(restored.byId.get(2).name, 'First task');
});

test('repeated restore does not inflate next task, link or project IDs or change saved state', () => {
  let store = new Store(); store.save(); store = new Store(saved(store)); store.save(); const state = saved(store);
  for (let i = 0; i < 6; i++) { store = new Store(saved(store)); store.save(); }
  assert.deepEqual(saved(store), state);
  const ids = new Set(store.tasks.map((task) => task.id));
  const next = store.nextId; store.addTask(null); assert(store.byId.has(next)); assert(!ids.has(next));
});

test('invalid undo entries are ignored while valid snapshots remain usable', () => {
  const store = new Store(); store.auto = false; const original = store.byId.get(3).name;
  store.setCell(3, 'name', 'After'); const state = saved(store);
  state.history[store.wb.active].u.push('broken', 'null', '{}', 2, { tasks: [], links: [] });
  state.history.missing = { u: ['{}'], r: [] };
  const restored = new Store(state);
  assert.equal(restored.undoStack.length, 1); assert.equal(restored.hist.has('missing'), false);
  restored.undo(); assert.equal(restored.byId.get(3).name, original);
});

test('app settings migrate and restore independently of browser credentials and workbook caches', () => {
  localStorage.setItem('pm-density', 'roomy'); localStorage.setItem('msal.token', 'private');
  localStorage.setItem('pm-workbook-v1', '{"cache":true}'); appState.restore(null);
  assert.deepEqual(appState.snapshot(), { 'pm-density': 'roomy' });
  let calls = 0; appState.onChange(() => calls++);
  appState.setItem('pm-density', 'roomy'); assert.equal(calls, 0);
  appState.setItem('pm-gridw', 770); assert.equal(calls, 1);
  const state = appState.snapshot(); memory.clear();
  appState.restore({ ...state, 'msal.token': 'must-exclude', 'pm-workbook-v1': '{}' });
  assert.deepEqual(appState.snapshot(), state); assert.equal(appState.getItem('pm-gridw'), '770');
  appState.restore({}); assert.equal(appState.getItem('pm-density'), null, 'disk state overrides browser settings');
});

test('full browser quota cannot prevent app persistence callbacks', () => {
  const store = new Store(); let persisted;
  store.persist = (state) => { persisted = JSON.parse(JSON.stringify(state)); };
  localStorage.setItem = () => { throw new Error('Quota exceeded'); };
  store.setCell(3, 'name', 'Saved outside browser');
  assert.equal(persisted.workbook.sheets[0].data.tasks.find(task => task.id === 3).name, 'Saved outside browser');
  store.saveTemplate('Still works'); assert.equal(persisted.templates[0].name, 'Still works');
});

test('typed and dragged edits share the retained undo limit across a fresh restore', () => {
  const store = new Store(); store.auto = false;
  for (let i = 0; i < 151; i++) store.setCell(3, 'name', `Edit ${i}`);
  assert.equal(store.undoStack.length, 150);
  store.beginDrag(); store.dragApply(() => store.dragMove(3, 1)); store.endDrag();
  assert.equal(store.undoStack.length, 150);
  assert.equal(new Store(saved(store)).undoStack.length, 150);
});

test('three-way critical path mode persists and stays compatible with boolean critical preference', () => {
  const store = new Store();
  assert.equal(store.criticalMode(), 'show');
  assert.equal(store.critical, true);
  assert.equal(store.criticalOnly, false);

  store.setCriticalMode('only');
  assert.equal(store.criticalMode(), 'only');
  assert.equal(store.critical, true);
  assert.equal(store.criticalOnly, true);
  const restoredOnly = new Store(saved(store));
  assert.equal(restoredOnly.criticalMode(), 'only');
  assert.equal(restoredOnly.critical, true);
  assert.equal(restoredOnly.criticalOnly, true);

  store.setCriticalMode('off');
  assert.equal(store.criticalMode(), 'off');
  assert.equal(store.critical, false);
  assert.equal(store.criticalOnly, false);
  assert.equal(new Store(saved(store)).criticalMode(), 'off');

  store.setCriticalMode('only');
  store.setPref('critical', false);
  assert.equal(store.criticalMode(), 'off');
  assert.equal(store.criticalOnly, false);
});
