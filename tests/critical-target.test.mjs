import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, D } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import { encodeProjectFile, openProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';

beforeEach(() => {
  const memory = new Map(); globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
  appState.restore({});
});
const start = D('2026-11-02');
const task = (id, offset, dur, extra = {}) => ({ id, name: `Task ${id}`, start: start + offset, dur, ms: dur === 0, level: 0, progress: 0, ...extra });
const link = (id, from, to, type = 'FS', lag = 0) => ({ id, from, to, type, lag });
function fixture() {
  const s = new Store(); s.auto = false;
  s.load({ tasks: [task(1, 0, 2), task(2, 2, 3), task(3, 5, 0), task(4, 2, 10), task(5, 0, 1)], links: [link('l1', 1, 2), link('l2', 2, 3), link('l3', 1, 4)] }); s.save(); return s;
}
test('milestone targets exclude independent parallel work, retain shared predecessors and leave dates/history unchanged', () => {
  const s = fixture(), before = s.snap(), history = s.undoStack.length;
  assert.equal(s.criticalTarget(), null); assert.equal(s.info.get(4).critical, true); assert.equal(s.info.get(2).float, 7);
  assert.equal(s.setCriticalTarget(3), null);
  assert.equal(s.criticalTarget().id, 3);
  for (const id of [1, 2, 3]) { assert.equal(s.info.get(id).float, 0); assert.equal(s.info.get(id).critical, true); }
  for (const id of [4, 5]) { assert.equal(s.info.get(id).float, null); assert.equal(s.info.get(id).critical, false); }
  assert.equal(s.links.find((l) => l.id === 'l3').critical, false);
  assert.equal(s.snap(), before); assert.equal(s.undoStack.length, history);
  s.setCriticalTarget(); assert.equal(s.criticalTarget(), null); assert.equal(s.info.get(4).critical, true); assert.equal(s.info.get(2).float, 7);
  assert.equal(s.snap(), before);
});
test('target choices restore per sheet from browser preferences and saved app state; export views use each sheet target', () => {
  const s = fixture(); s.setCriticalTarget(3); const first = s.wb.active;
  const second = s.addSheet(JSON.parse(s.serialize()), 'Second');
  assert.equal(s.criticalTarget(), null); s.setCriticalTarget(3);
  s.switchSheet(first); s.setCriticalTarget(null); s.switchSheet(second); assert.equal(s.criticalTarget().id, 3);
  assert.equal(s.view(first).info.get(4).critical, true); assert.equal(s.view(second).info.get(4).critical, false);
  const reopened = new Store(s.savedState()); assert.equal(reopened.criticalTarget().id, 3);
  const browser = new Store(); assert.equal(browser.criticalTarget().id, 3); browser.switchSheet(first); assert.equal(browser.criticalTarget(), null);
  reopened.deleteSheet(second); assert.equal(reopened.criticalTargets[second], undefined);
  openProjectFile(s, encodeProjectFile(s)); assert.equal(s.criticalTarget(), null, 'portable project starts with project completion');
});
test('invalid/deleted/converted/summary targets fall back safely, with undo restoring a removed milestone choice', () => {
  const s = fixture(); const before = s.snap();
  for (const id of [1, 999, '3', undefined]) { if (id === undefined) continue; assert.match(s.setCriticalTarget(id), /milestone/); }
  assert.equal(s.snap(), before); s.setCriticalTarget(3); s.setTaskKind(3, false);
  assert.equal(s.criticalTarget(), null); assert.equal(s.info.get(4).critical, true);
  s.undo(); assert.equal(s.criticalTarget().id, 3);
  s.tx(() => { s.tasks = s.tasks.filter((t) => t.id !== 3); }); assert.equal(s.criticalTarget(), null);
  s.undo(); assert.equal(s.criticalTarget().id, 3);
  s.stale = true; assert.match(s.setCriticalTarget(null), /another tab/); assert.equal(s.criticalTarget().id, 3);
  s.stale = false; s.tx(() => { s.tasks[3].level = 1; }); assert.equal(s.criticalTarget(), null);
  assert.match(s.setCriticalTarget(3), /milestone/);
});
test('target selection on read-only sheets is a local view choice and does not schedule tasks', () => {
  const s = fixture(); s.sheet().readOnly = true; s.auto = true;
  const before = s.snap(); assert.equal(s.setCriticalTarget(3), null); assert.equal(s.snap(), before);
  s.byId.get(2).progress = 100; s.recalc(); assert.equal(s.info.get(2).critical, false);
});

// Slow independent day-by-day oracle: enumerate feasible schedules with the target held fixed.
test('target floats match exhaustive feasible schedules for mixed FS/SS/FF/SF, signed lags, milestones and holidays', () => {
  const calendar = { workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-09', name: 'Closure' }] };
  const isWork = (day) => calendar.workdays.includes(new Date(day * 86400000).getUTCDay()) && day !== D('2026-11-09');
  const end = (day, dur) => { if (!dur) return day; while (dur) { if (isWork(day)) dur--; day++; } return day; };
  const next = (day) => { while (!isWork(day)) day++; return day; };
  const shift = (day, lag) => { day = next(day); const dir = lag < 0 ? -1 : 1; while (lag) { day += dir; if (isWork(day)) lag -= dir; } return day; };
  const count = (a, b) => { if (b < a) return -count(b, a); let n = 0; for (let d = a; d < b; d++) if (isWork(d)) n++; return n; };
  for (const a of ['FS', 'SS', 'FF', 'SF']) for (const b of ['FS', 'SS', 'FF', 'SF']) for (const lag of [-2, 2]) for (const ms of [false, true]) {
    const s = new Store(); s.auto = false;
    const tasks = [task(1, 0, 10), task(2, 2, ms ? 0 : 3), task(3, 11, 0)];
    const links = [link('l1', 1, 2, a, lag), link('l2', 2, 3, b, -lag)];
    s.load({ calendar, tasks, links }); s.setCriticalTarget(3);
    const candidates = []; for (let d = start - 35; d <= start + 40; d++) if (isWork(d)) candidates.push(d);
    const latest = [-Infinity, -Infinity];
    for (const x of candidates) for (const y of candidates) {
      const starts = [x, y, tasks[2].start];
      if (!links.every((l) => {
        const p = l.from - 1, q = l.to - 1, source = l.type[0] === 'F' ? end(starts[p], tasks[p].dur) : starts[p];
        const bound = l.type[1] === 'S' ? shift(source, l.lag) : shift(source - 1, l.lag) + 1;
        return bound <= (l.type[1] === 'S' ? starts[q] : end(starts[q], tasks[q].dur));
      })) continue;
      latest[0] = Math.max(latest[0], x); latest[1] = Math.max(latest[1], y);
    }
    for (let i = 0; i < 2; i++) assert.equal(s.info.get(i + 1).float, count(tasks[i].start, latest[i]), `${a}/${b} lag=${lag} ms=${ms} task=${i + 1}`);
    assert.equal(s.info.get(3).float, 0);
  }
});
