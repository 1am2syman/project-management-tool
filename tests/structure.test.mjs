import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, D } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';

beforeEach(() => {
  const memory = new Map();
  globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
  appState.restore({});
});
const task = (id, name, level = 0, extra = {}) => ({ id, name, level, start: D('2026-11-02'), dur: 5, progress: 20, owner: 'Alex', email: 'alex@example.com', ms: false, ...extra });
function fixture() {
  const store = new Store(); store.auto = false;
  store.load({ tasks: [task(1, 'Commercial Procurement'), task(2, 'Sleeve'), task(3, 'Sleeve AW', 1), task(4, 'PM Connection', 1), task(5, 'CFC'), task(6, 'CFC AW', 1), task(7, 'CFC connection', 1), task(8, 'Shipping')], links: [{ id: 'l1', from: 3, to: 6, type: 'SS', lag: 2 }], collapsed: [] });
  return store;
}
const outline = (s) => s.tasks.map((t) => [t.id, t.level]);
const links = (s) => JSON.parse(s.serialize()).links;

test('Sleeve and CFC become siblings under Commercial Procurement with their own tasks intact', () => {
  const s = fixture(), originalLinks = links(s);
  assert.equal(s.indent(2, 1), null);
  assert.equal(s.indent(5, 1), null);
  assert.deepEqual(outline(s), [[1, 0], [2, 1], [3, 2], [4, 2], [5, 1], [6, 2], [7, 2], [8, 0]]);
  assert.equal(s.parentId(5), 1); assert.equal(s.parentId(7), 5);
  assert.deepEqual(links(s), originalLinks);
  assert.equal(s.info.get(1).sub, 6);
  assert.equal(s.indent(5, 1), null); // Previous sibling is Sleeve, not PM Connection.
  assert.equal(s.parentId(5), 2); assert.equal(s.parentId(6), 5);
  s.undo(); assert.equal(s.parentId(5), 1);
});

test('outdent moves a whole subtree after its parent without adopting remaining siblings', () => {
  const s = fixture(); s.indent(2, 1); s.indent(5, 1);
  assert.equal(s.indent(2, -1), null);
  assert.deepEqual(outline(s), [[1, 0], [5, 1], [6, 2], [7, 2], [2, 0], [3, 1], [4, 1], [8, 0]]);
  assert.equal(s.parentId(5), 1); assert.equal(s.parentId(4), 2);
});

test('collapsed cascades move as intact blocks and retain hidden descendants and collapse state', () => {
  const s = fixture(); s.toggle(2);
  assert.equal(s.moveTask(2, 5, 'after'), null);
  assert.deepEqual(s.tasks.map((t) => t.id), [1, 5, 6, 7, 2, 3, 4, 8]);
  assert.deepEqual(s.rows.map((t) => t.id), [1, 5, 6, 7, 2, 8]);
  assert(s.collapsed.has(2)); assert.equal(s.undoStack.length, 1);
  s.undo(); assert.deepEqual(s.tasks.map((t) => t.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  s.redo(); assert.equal(s.tasks[4].id, 2);
});

test('before, after and child insertion respect nested and collapsed boundaries', () => {
  const s = fixture(); s.toggle(2);
  const above = s.insertTask(2, false, 'before').id;
  const below = s.insertTask(2, true, 'after').id;
  assert.equal(s.tasks[s.info.get(2).i - 1].id, above);
  assert.equal(s.tasks[s.info.get(2).sub + 1].id, below);
  assert.equal(s.byId.get(below).level, 0); assert(s.byId.get(below).ms);
  const child = s.insertTask(2, false, 'child').id;
  assert.equal(s.parentId(child), 2); assert(!s.collapsed.has(2));
  const between = s.insertTask(4, true, 'before').id;
  assert.equal(s.parentId(between), 2); assert.equal(s.tasks[s.info.get(4).i - 1].id, between);
  const last = s.insertTask(null).id; assert.equal(s.byId.get(last).level, 0);
});

test('linked leaves and milestones cannot silently become summaries', () => {
  const s = fixture(); const ms = s.insertTask(null, true).id;
  const before = s.snap(), history = s.undoStack.length;
  for (const id of [3, ms]) {
    assert(s.insertTask(id, false, 'child').error);
    assert(s.moveTask(8, id, 'child'));
  }
  assert.equal(s.snap(), before); assert.equal(s.undoStack.length, history); assert.equal(s.links.length, 1);
});

test('moves reject self, descendants, deleted IDs and unknown positions without edits', () => {
  const s = fixture(), before = s.snap();
  for (const args of [[2, 2, 'after'], [2, 4, 'child'], [999, 2, 'before'], [2, 999, 'after'], [2, 5, 'unknown'], [2, null, 'after']]) assert.equal(typeof s.moveTask(...args), 'string');
  assert.equal(s.snap(), before); assert.equal(s.undoStack.length, 0);
  assert(s.insertTask(999).error); assert(s.insertTask(null, false, 'child').error);
});

test('no-op reorder does not create undo history and invalid indentation explains why', () => {
  const s = fixture(); assert.equal(s.moveTask(5, 2, 'after'), null);
  assert.equal(s.undoStack.length, 0);
  assert.match(s.indent(1, 1), /previous sibling/);
  assert.match(s.indent(1, -1), /top level/);
});

test('task and milestone conversion preserves identity, relationship data and undo/redo', () => {
  const s = fixture(), initial = { ...s.byId.get(3) }, originalLinks = links(s);
  assert.equal(s.setTaskKind(3, true), null);
  assert.deepEqual(s.byId.get(3), { ...initial, ms: true, dur: 0 });
  assert.deepEqual(links(s), originalLinks);
  s.undo(); assert.deepEqual(s.byId.get(3), initial);
  s.redo(); assert(s.byId.get(3).ms);
  assert.equal(s.setTaskKind(3, false), null); assert.equal(s.byId.get(3).dur, 1);
  assert.deepEqual(links(s), originalLinks);
  assert.match(s.setTaskKind(2, true), /cascade/);
});

test('structure edits, insertion, calendar edits and conversion reject read-only and stale projects', () => {
  for (const condition of ['readOnly', 'stale']) {
    const s = fixture(); if (condition === 'readOnly') s.sheet().readOnly = true; else s.stale = true;
    const before = s.snap();
    assert(s.insertTask(1).error); assert(s.moveTask(2, 5, 'after')); assert(s.indent(2, 1)); assert(s.setTaskKind(3, true));
    assert(s.setCalendar({ workdays: [1, 2, 3, 4, 5], holidays: [] }));
    assert.equal(s.snap(), before); assert.equal(s.undoStack.length, 0);
  }
});

test('nested order, milestones, links and undo survive a fresh saved-state restore', () => {
  const s = fixture(); s.indent(2, 1); s.indent(5, 1); s.setTaskKind(3, true); s.save();
  const restored = new Store(JSON.parse(JSON.stringify(s.savedState())));
  assert.deepEqual(outline(restored), outline(s)); assert.deepEqual(links(restored), links(s));
  assert.equal(restored.parentId(5), 1); assert(restored.byId.get(3).ms);
  restored.undo(); assert(!restored.byId.get(3).ms);
  restored.undo(); assert.equal(restored.parentId(5), null);
});
