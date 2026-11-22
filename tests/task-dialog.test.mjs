import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, D } from '../src/project_management_tool/web/js/model.js';
import { encodeProjectFile, parseProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';

function makeStore() {
  const store = new Store({
    workbook: {
      active: 's1',
      nextSheet: 2,
      sheets: [{
        id: 's1',
        name: 'Dialog test',
        data: {
          calendar: { workdays: [1, 2, 3, 4, 5], holidays: [] },
          tasks: [
            { id: 1, name: 'Phase 1', level: 0, start: D('2026-11-02'), dur: 5, progress: 0, owner: '', ms: false },
            { id: 2, name: 'Design', level: 1, start: D('2026-11-02'), dur: 5, progress: 20, owner: 'Lena P', email: 'lena@example.com', ms: false },
            { id: 3, name: 'Build', level: 1, start: D('2026-11-09'), dur: 6, progress: 0, owner: 'Dan C', email: 'dan@example.com', ms: false },
            { id: 4, name: 'Launch', level: 1, start: D('2026-11-17'), dur: 0, progress: 0, owner: 'Ava K', ms: true },
          ],
          links: [
            { id: 'l1', from: 2, to: 3, type: 'FS', lag: 0 },
            { id: 'l2', from: 3, to: 4, type: 'FS', lag: 0 },
          ],
          collapsed: [],
          nextId: 5,
          nextLink: 3,
        },
      }],
    },
  });
  return store;
}

test('updateTask commits multiple fields atomically with single undo step and preserves actuals & notes', () => {
  const store = makeStore();
  const err = store.updateTask(2, {
    name: 'Design & prototype',
    owner: 'Ravi T',
    email: 'ravi@example.com',
    notes: 'Include mobile wireframes and accessibility check.',
    dur: 7,
    progress: 65,
    actualStart: D('2026-11-03'),
    actualEnd: D('2026-11-10'),
  });
  assert.equal(err, null);
  const t = store.byId.get(2);
  assert.equal(t.name, 'Design & prototype');
  assert.equal(t.owner, 'Ravi T');
  assert.equal(t.email, 'ravi@example.com');
  assert.equal(t.notes, 'Include mobile wireframes and accessibility check.');
  assert.equal(t.dur, 7);
  assert.equal(t.progress, 65);
  assert.equal(t.actualStart, D('2026-11-03'));
  assert.equal(t.actualEnd, D('2026-11-10'));
  assert.equal(store.undoStack.length, 1);

  // Single undo reverts all fields
  store.undo();
  const reverted = store.byId.get(2);
  assert.equal(reverted.name, 'Design');
  assert.equal(reverted.dur, 5);
  assert.equal(reverted.progress, 20);
  assert.equal(reverted.actualStart, undefined);
  assert.equal(reverted.actualEnd, undefined);
  assert.equal(reverted.notes, undefined);
});

test('updateTask validates actualFinish >= actualStart, email, empty name, and summary constraints without mutating', () => {
  const store = makeStore();
  assert.match(store.updateTask(2, { name: '   ' }), /empty/i);
  assert.match(store.updateTask(2, { email: 'not-an-email' }), /email/i);
  assert.match(store.updateTask(2, { actualStart: D('2026-11-10'), actualEnd: D('2026-11-05') }), /before actual start/i);
  assert.match(store.updateTask(1, { ms: true }), /milestone/i);
  assert.equal(store.undoStack.length, 0);
  assert.equal(store.byId.get(2).name, 'Design');
});

test('actuals and notes round-trip through .plan files and actuals are stripped from templates', () => {
  const store = makeStore();
  assert.equal(store.updateTask(2, {
    notes: 'Carry into file',
    actualStart: D('2026-11-02'),
    actualEnd: D('2026-11-06'),
  }), null);
  assert.equal(store.updateTask(4, { actualStart: D('2026-11-18') }), null);

  const encoded = encodeProjectFile(store);
  const parsed = parseProjectFile(encoded);
  const t2 = parsed.data.tasks.find((t) => t.id === 2);
  const t4 = parsed.data.tasks.find((t) => t.id === 4);
  assert.equal(t2.notes, 'Carry into file');
  assert.equal(t2.actualStart, D('2026-11-02'));
  assert.equal(t2.actualEnd, D('2026-11-06'));
  assert.equal(t4.actualStart, D('2026-11-18'));
  assert.equal(t4.actualEnd, undefined);

  // Template strips actual dates
  const saved = store.saveTemplate('My template');
  const tpl2 = saved.tpl.tasks.find((t) => t.id === 2);
  assert.equal(tpl2.actualStart, undefined);
  assert.equal(tpl2.actualEnd, undefined);
});

test('addLink supports optional lag in one transaction and validates non-integer lags', () => {
  const store = makeStore();
  assert.match(store.addLink(2, 's', 4, 's', 1.5), /whole number/i);
  assert.equal(store.addLink(2, 's', 4, 's', 3), null);
  const created = store.links.find((l) => l.from === 2 && l.to === 4);
  assert.ok(created);
  assert.equal(created.type, 'SS');
  assert.equal(created.lag, 3);
});

test('updateTask converts between task and milestone and shifts summary start', () => {
  const store = makeStore();
  assert.equal(store.updateTask(2, { actualStart: D('2026-11-02'), actualEnd: D('2026-11-06') }), null);
  // Converting task to milestone clears actualEnd and sets dur = 0
  assert.equal(store.updateTask(2, { ms: true }), null);
  assert.equal(store.byId.get(2).ms, true);
  assert.equal(store.byId.get(2).dur, 0);
  assert.equal(store.byId.get(2).actualEnd, undefined);
  assert.equal(store.byId.get(2).actualStart, D('2026-11-02'));

  // Shifting summary start moves children together
  const beforeStart = store.info.get(1).start;
  assert.equal(store.updateTask(1, { start: beforeStart + 7 }), null);
  assert.equal(store.info.get(1).start, beforeStart + 7);
});
