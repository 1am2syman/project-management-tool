import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, D } from '../src/project_management_tool/web/js/model.js';
import { encodeProjectFile, openProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';

beforeEach(() => {
  const memory = new Map(); globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
  appState.restore({});
});
const base = D('2026-11-02');
const task = (id, offset, dur, extra = {}) => ({ id, name: `Task ${id}`, start: base + offset, dur, ms: dur === 0, level: 0, progress: 0, ...extra });
const link = (id, from, to, type = 'FS', lag = 0) => ({ id, from, to, type, lag });
function fixture() {
  const s = new Store(); s.auto = false;
  s.load({ tasks: [task(1, 0, 2), task(2, 4, 2), task(3, 9, 0), task(4, 0, 12)], links: [link('l1', 1, 2), link('l2', 2, 3)] });
  s.save(); s.setCriticalTarget(3); return s;
}

test('total slack permits downstream movement while free slack holds current successors fixed', () => {
  const s = fixture(), f = s.info.get(1), before = s.snap();
  assert.equal(f.float, 5); assert.equal(f.freeFloat, 2);
  assert.equal(f.latestStart, base + 5); assert.equal(f.latestEnd, base + 7);
  assert.equal(f.freeStart, base + 2); assert.equal(f.freeEnd, base + 4);
  assert.deepEqual(f.totalLimiters, ['l1']); assert.deepEqual(f.freeLimiters, ['l1']);
  assert.equal(s.info.get(3).float, 0); assert.equal(s.info.get(3).freeFloat, 0);
  assert.equal(s.info.get(4).float, null); assert.equal(s.info.get(4).freeFloat, 0);
  s.setCriticalTarget(null); assert.equal(s.info.get(1).float, 8); assert.equal(s.info.get(1).freeFloat, 2);
  assert.equal(s.snap(), before, 'analysis does not change dates, durations or authored links');
});

test('free slack matches an independent daily oracle for all endpoint types, signed lags, milestones, ties and holidays', () => {
  const calendar = { workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-09', name: 'Closure' }] };
  const isWork = (day) => calendar.workdays.includes(new Date(day * 86400000).getUTCDay()) && day !== D('2026-11-09');
  const count = (a, b) => { if (b < a) return -count(b, a); let n = 0; for (let d = a; d < b; d++) if (isWork(d)) n++; return n; };
  const end = (day, dur) => { while (dur) { if (isWork(day)) dur--; day++; } return day; };
  const shift = (day, lag) => { while (!isWork(day)) day++; const dir = Math.sign(lag); while (lag) { day += dir; if (isWork(day)) lag -= dir; } return day; };
  for (const type of ['FS', 'SS', 'FF', 'SF']) for (const other of ['FS', 'SS', 'FF', 'SF']) for (const lag of [-3, 0, 3]) for (const milestone of [false, true]) for (const successorMilestone of [false, true]) {
    const tasks = [task(1, 4, milestone ? 0 : 4), task(2, 10, successorMilestone ? 0 : 3), task(3, 15, 2)];
    const links = [link('l1', 1, 2, type, lag), link('l2', 1, 3, other, -lag)];
    const s = new Store(); s.auto = false; s.load({ calendar, tasks, links });
    const fits = (day, l) => {
      const successor = tasks[l.to - 1], source = l.type[0] === 'F' ? end(day, tasks[0].dur) : day;
      const required = l.type[1] === 'S' ? shift(source, l.lag) : shift(source - 1, l.lag) + 1;
      return required <= (l.type[1] === 'S' ? successor.start : end(successor.start, successor.dur));
    };
    let latest = -Infinity;
    for (let d = base - 60; d < base + 70; d++) if (isWork(d) && links.every((l) => fits(d, l))) latest = d;
    const f = s.info.get(1), label = `${type}/${other}/${lag}/${milestone}/${successorMilestone}`;
    assert.equal(f.freeStart, latest, label); assert.equal(f.freeFloat, count(tasks[0].start, latest), label);
    let next = latest + 1; while (!isWork(next)) next++;
    assert.deepEqual(f.freeLimiters, links.filter((l) => !fits(next, l)).map((l) => l.id), label);
  }
});

test('terminal slack, summary exclusion, negative free slack and target-local analysis are distinct', () => {
  const s = new Store(); s.auto = false;
  s.load({ tasks: [task(1, 0, 1, { level: 0 }), task(2, 5, 3, { level: 1, scheduling: 'manual' }), task(3, 4, 0), task(4, 0, 1)], links: [link('a', 2, 3)] });
  assert.equal(s.info.get(1).freeFloat, null); assert.equal(s.info.get(1).latestStart, null);
  assert.equal(s.info.get(2).freeFloat, -4); assert.equal(s.links[0].violated, true);
  assert.equal(s.info.get(4).freeFloat, 7);
  s.setCriticalTarget(3); assert.equal(s.info.get(4).float, null); assert.equal(s.info.get(4).freeFloat, 7);
  assert.equal(s.info.get(3).freeFloat, 0); assert.equal(s.info.get(2).float, -4);
});

test('slack is recomputed after edits, undo, calendar and target changes; project files contain no derived slack', () => {
  const s = fixture(), before = s.info.get(1).freeFloat;
  s.setCell(2, 'start', '2026-11-07'); assert.equal(s.info.get(1).freeFloat, 3);
  s.undo(); assert.equal(s.info.get(1).freeFloat, before); s.redo(); assert.equal(s.info.get(1).freeFloat, 3);
  s.setCalendar({ workdays: [1, 2, 3, 4, 5], holidays: [] });
  const state = s.savedState(), reopened = new Store(state);
  assert.equal(reopened.info.get(1).freeFloat, s.info.get(1).freeFloat);
  assert.equal(reopened.info.get(1).float, s.info.get(1).float);
  const encoded = encodeProjectFile(s);
  assert(!encoded.includes('freeFloat')); assert(!encoded.includes('latestStart'));
  const portable = new Store(); openProjectFile(portable, encoded);
  assert.equal(portable.info.get(1).freeFloat, s.info.get(1).freeFloat);
  assert.equal(portable.criticalTarget(), null);
  portable.sheet().readOnly = true; portable.recalc(); assert.equal(portable.info.get(1).freeFloat, s.info.get(1).freeFloat);
});

test('local free slack may exceed total slack when a different completion boundary is tighter', () => {
  const s = new Store(); s.auto = false;
  s.load({ tasks: [task(1, 0, 10), task(2, 8, 1)], links: [link('a', 1, 2, 'SS')] });
  assert.equal(s.info.get(1).float, 0); assert.equal(s.info.get(1).freeFloat, 8);
});
