import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, D } from '../src/project_management_tool/web/js/model.js';
import { encodeProjectFile, openProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';
const day = D('2026-11-06');
beforeEach(() => { globalThis.localStorage = { getItem: () => null, setItem: () => {} }; });
function fixture(type = 'FS', lag = 0, ms = false) {
  const s = new Store(); s.auto = false;
  s.load({ tasks: [
    { id: 1, name: 'Predecessor', level: 0, start: day, dur: 3 },
    { id: 2, name: 'Successor', level: 0, start: day + 30, dur: ms ? 0 : 2, ms },
  ], links: [{ id: 'l1', from: 1, to: 2, type, lag }], collapsed: [], nextId: 3, nextLink: 2 });
  s.save(); return s;
}
test('automatic mode calculates earliest linked dates for all endpoint types, positive/negative lag and milestones', () => {
  for (const ms of [false, true]) for (const [type, lag, expected] of [['FS', 2, day + 5], ['SS', -1, day - 1], ['FF', 1, day + 4 - (ms ? 0 : 2)], ['SF', 2, day + 2 - (ms ? 0 : 2)]]) {
    const s = fixture(type, lag, ms); assert.equal(s.setScheduling(2, 'auto'), null);
    assert.equal(s.byId.get(2).start, expected, `${type} milestone=${ms}`);
    assert.equal(s.scheduling(2).label, 'Auto paused');
    s.auto = true;
    s.setCell(1, 'start', '2026-11-20'); const later = s.byId.get(2).start;
    s.setCell(1, 'start', '2026-11-01'); assert(s.byId.get(2).start < later, 'follows earlier predecessor');
    assert.equal(s.links[0].violated, false);
  }
});
test('manual dates stay fixed and reveal violated links while legacy date anchors preserve old behavior', () => {
  const s = fixture(); s.auto = true;
  s.setScheduling(2, 'manual'); const original = s.byId.get(2).start;
  s.setCell(1, 'start', '2027-01-01'); assert.equal(s.byId.get(2).start, original); assert(s.links[0].violated);
  s.setScheduling(2, 'anchor'); assert(s.byId.get(2).start > original); assert.equal(s.scheduling(2).mode, 'anchor');
  s.setCell(1, 'start', '2026-11-01'); assert(s.byId.get(2).start > original, 'legacy anchors do not pull earlier');
});
test('auto mode uses the working calendar and all incoming constraints, including downstream automatic chains', () => {
  const s = fixture(); s.setCalendar({ workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-09', name: 'Holiday' }] });
  s.setScheduling(2, 'auto'); assert.equal(s.byId.get(2).start, D('2026-11-12'));
  const third = s.addTask(2); s.addLink(2, 'f', third, 's'); s.setScheduling(third, 'auto');
  s.auto = true; s.setCell(1, 'start', '2026-11-02');
  assert.equal(s.byId.get(2).start, D('2026-11-05')); assert.equal(s.byId.get(third).start, D('2026-11-10'));
  s.addLink(1, 's', third, 's'); s.updateLink(s.links.at(-1).id, { lag: 10 });
  assert.equal(s.byId.get(third).start, D('2026-11-17'));
});
test('mode/date changes support undo, redo, native files and SQLite reloads; date edits override auto', () => {
  const s = fixture(); const initial = s.snap(); s.setScheduling(2, 'auto'); const automatic = s.snap();
  s.undo(); assert.equal(s.snap(), initial); s.redo(); assert.equal(s.snap(), automatic);
  const saved = s.savedState(), reopened = new Store(saved); assert.equal(reopened.byId.get(2).scheduling, 'auto');
  const contents = encodeProjectFile(s); assert.equal(JSON.parse(contents).version, 3);
  openProjectFile(reopened, contents); assert.equal(reopened.byId.get(2).scheduling, 'auto');
  s.auto = true; s.setCell(2, 'start', '2026-12-01'); assert.equal(s.byId.get(2).scheduling, 'manual'); assert.equal(s.byId.get(2).start, D('2026-12-01'));
});
test('pointer moves/resizes override automatic scheduling, cancellation restores it, progress keeps it', () => {
  const s = fixture(); s.auto = true; s.setScheduling(2, 'auto'); const before = s.snap();
  s.beginDrag(); s.dragApply(() => s.dragMove(2, 8)); assert.equal(s.byId.get(2).scheduling, 'manual'); s.endDrag(false); assert.equal(s.snap(), before);
  s.beginDrag(); s.dragApply(() => s.dragResize(2, 'r', 5)); assert.equal(s.byId.get(2).scheduling, 'manual'); s.endDrag();
  s.undo(); assert.equal(s.snap(), before); s.beginDrag(); s.dragApply(() => s.dragProgress(2, 80)); s.endDrag(); assert.equal(s.byId.get(2).scheduling, 'auto');
});
test('summaries, missing predecessors, read-only, stale and unknown modes reject without edits', () => {
  const s = fixture(); const snapshot = s.snap();
  assert.match(s.setScheduling(1, 'auto'), /predecessor/); assert.match(s.setScheduling(99, 'manual'), /no longer/); assert.match(s.setScheduling(2, 'unknown'), /Unknown/);
  s.stale = true; assert.match(s.setScheduling(2, 'manual'), /another tab/); s.stale = false;
  s.sheet().readOnly = true; assert.match(s.setScheduling(2, 'auto'), /read-only/); s.sheet().readOnly = false;
  assert.equal(s.snap(), snapshot);
  s.links = []; s.tasks[1].level = 1; s.recalc(); assert.match(s.setScheduling(1, 'auto'), /Summary/);
});

test('a calculated finish outside the supported date range is rejected without changing mode or dates', () => {
  const s = fixture(); s.auto = false; s.byId.get(1).start = 99999998; s.recalc(); const before = s.snap();
  assert.match(s.setScheduling(2, 'auto'), /outside the supported range/); assert.equal(s.snap(), before);
});
