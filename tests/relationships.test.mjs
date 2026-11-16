import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, today } from '../src/project_management_tool/web/js/model.js';
import { mapSheet } from '../src/project_management_tool/web/js/import.js';

let memory;
beforeEach(() => {
  memory = new Map();
  globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
});
const task = (id, name = `Task ${id}`, level = 0) => ({ id, name, level, start: today, dur: 5, progress: 0, ms: false, owner: '' });
const link = (id, type = 'FS', lag = 3) => ({ id, from: 1, to: 2, type, lag });
function fixture(links = [link('l1')]) {
  const store = new Store();
  store.load({ tasks: [task(1), task(2), task(3)], links, collapsed: [] });
  return store;
}
const shape = (store) => store.links.map(({ id, from, to, type, lag }) => ({ id, from, to, type, lag }));

test('a task pair rejects every additional relationship type without creating undo history', () => {
  const store = fixture(), before = store.snap();
  for (const [from, to] of [['f', 's'], ['s', 's'], ['f', 'f'], ['s', 'f']]) {
    assert.match(store.addLink(1, from, 2, to), /already exists/);
    assert.equal(store.snap(), before);
  }
  assert.equal(store.undoStack.length, 0);
  assert.equal(store.addLink(1, 'f', 3, 's'), null);
  assert.equal(store.linksBetween(1, 3).length, 1);
});

test('changing a relationship preserves its ID and lag and supports undo/redo', () => {
  const store = fixture();
  assert.equal(store.updateLink('l1', { type: 'SS' }), null);
  assert.deepEqual(shape(store), [link('l1', 'SS')]);
  store.undo(); assert.deepEqual(shape(store), [link('l1')]);
  store.redo(); assert.deepEqual(shape(store), [link('l1', 'SS')]);
});

test('legacy multiple constraints load unchanged and require explicit resolution', () => {
  const links = [link('l1', 'SS', 5), link('l2', 'FF', 2)];
  const store = fixture(links), before = store.snap();
  assert.deepEqual(shape(store), links);
  assert.equal(store.linkConflicts().length, 1);
  assert.match(store.updateLink('l2', { type: 'SS' }), /choose one/);
  assert.equal(store.snap(), before);
  assert.equal(store.updateLink('l2', {}, { resolvePair: true }), null);
  assert.deepEqual(shape(store), [link('l2', 'FF', 2)]);
  assert.equal(store.linkConflicts().length, 0);
  store.undo(); assert.deepEqual(shape(store), links);
  store.redo(); assert.deepEqual(shape(store), [link('l2', 'FF', 2)]);
});

test('legacy identical duplicates also require explicit choice and are resolved once', () => {
  const store = fixture([link('l1'), link('l2')]);
  assert.equal(store.links.length, 2);
  assert.equal(store.updateLink('l2', { type: 'SF', lag: -2 }, { resolvePair: true }), null);
  assert.deepEqual(shape(store), [link('l2', 'SF', -2)]);
});

test('relationship updates reject stale IDs, invalid values and endpoint changes atomically', () => {
  const store = fixture(), before = store.snap();
  for (const [id, patch] of [['missing', { type: 'FF' }], ['l1', { type: 'XX' }], ['l1', { lag: 1.5 }], ['l1', { lag: Infinity }], ['l1', { from: 3 }], ['l1', { to: 3 }]]) {
    assert.equal(typeof store.updateLink(id, patch), 'string');
    assert.equal(store.snap(), before);
  }
});

test('self-links, missing tasks, summary links and cycles stay blocked', () => {
  const store = fixture();
  assert.match(store.addLink(2, 'f', 1, 's'), /cycle/);
  assert.match(store.addLink(1, 'f', 1, 's'), /itself/);
  assert.match(store.addLink(1, 'f', 99, 's'), /no longer exists/);
  store.load({ tasks: [task(1, 'Summary'), task(2, 'Child', 1), task(3)], links: [] });
  assert.match(store.addLink(1, 'f', 3, 's'), /Summary/);
});

test('read-only sheets cannot create, edit or consolidate relationships', () => {
  const store = fixture([link('l1'), link('l2', 'FF')]);
  store.sheet().readOnly = true;
  const before = store.snap();
  assert.match(store.addLink(1, 'f', 3, 's'), /read-only/);
  assert.match(store.updateLink('l1', { type: 'SS' }, { resolvePair: true }), /read-only/);
  assert.equal(store.snap(), before);
});

test('stale tabs cannot report successful relationship edits or consolidation', () => {
  const store = fixture([link('l1'), link('l2', 'FF')]), before = store.snap();
  store.stale = true;
  assert.match(store.addLink(1, 'f', 3, 's'), /reload/);
  assert.match(store.updateLink('l1', { type: 'SS' }, { resolvePair: true }), /reload/);
  assert.equal(store.snap(), before);
});

test('predecessor edits reject repeated sources even when their type or lag differs', () => {
  const store = fixture(), row = store.rowNum(1), before = store.snap();
  for (const input of [`${row}, ${row}`, `${row}SS+2, ${row}FF+5`, `${row}SS+2, ${row}SS+5`]) {
    assert.match(store.setCell(2, 'pred', input), /one relationship per task pair/);
    assert.equal(store.snap(), before);
  }
  assert.equal(store.setCell(2, 'pred', `${row}FF-2`), null);
  assert.equal(store.linksBetween(1, 2).length, 1);
});

test('distinct predecessors stay valid, reverse-direction cycles remain invalid', () => {
  const store = fixture([]);
  assert.equal(store.setCell(3, 'pred', `${store.rowNum(1)}SS, ${store.rowNum(2)}FF+2`), null);
  const before = store.snap();
  assert.match(store.setCell(1, 'pred', `${store.rowNum(3)}`), /cycle/);
  assert.equal(store.snap(), before);
});

test('confirmed single relationships survive saving and loading', () => {
  const store = fixture([link('l1', 'SS'), link('l2', 'FF', 7)]);
  assert.equal(store.updateLink('l2', {}, { resolvePair: true }), null);
  const reloaded = new Store();
  assert.deepEqual(shape(reloaded), [link('l2', 'FF', 7)]);
});

test('demo and every built-in template start with unique task pairs', () => {
  const store = new Store();
  assert.equal(store.linkConflicts().length, 0);
  for (const template of store.allTemplates()) {
    const pairs = template.links.map((l) => `${l.from}:${l.to}`);
    assert.equal(new Set(pairs).size, pairs.length, template.name);
  }
});

const importSheet = (pred) => ({ name: 'Tasks', outline: [], rows: [
  ['#', 'Task', 'Start', 'Days', 'Depends on'],
  [1, 'Predecessor', '2026-11-01', 5, ''],
  [2, 'Successor', '2026-11-01', 5, pred],
] });

test('imports include an identical repeated constraint once and report a warning', () => {
  const result = mapSheet(importSheet('1SS+2, 1SS+2'));
  assert.equal(result.ok, true);
  assert.equal(result.data.links.length, 1);
  assert.equal(result.data.links[0].lag, 2);
  assert.ok(result.issues.some((x) => x.lv === 'warn' && /included once/.test(x.msg)));
});

test('imports block differing types or lags for one pair with an actionable error', () => {
  for (const pred of ['1SS+2, 1FF+3', '1SS+2, 1SS+3']) {
    const result = mapSheet(importSheet(pred));
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((x) => x.lv === 'error' && /Keep one type and lag/.test(x.msg)));
  }
});
