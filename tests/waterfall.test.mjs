import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, D } from '../src/project_management_tool/web/js/model.js';
import { WorkingCalendar } from '../src/project_management_tool/web/js/calendar.js';
import { finishWaterfall } from '../src/project_management_tool/web/js/finishwaterfall.js';

const day = D('2026-11-02');
const daily = { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] };
const weekdays = { workdays: [1, 2, 3, 4, 5], holidays: [] };
const task = (id, name, dur, extra = {}) => ({ id, name, dur, start: day, level: 0, progress: 0, ms: dur === 0, scheduling: 'auto', ...extra });
const link = (id, from, to, type = 'FS', lag = 0) => ({ id, from, to, type, lag });
function view(tasks, links = [], calendar = daily, auto = true, frozen = false) {
  const v = Object.create(Store.prototype);
  Object.assign(v, { tasks: structuredClone(tasks), links: structuredClone(links), calendar: structuredClone(calendar), work: new WorkingCalendar(calendar), collapsed: new Set(), listeners: [], auto, frozen, criticalTargetId: null });
  v.settle(); return v;
}
function revise(a, fn, { auto = a.auto, frozen = false, calendar = a.calendar } = {}) {
  const tasks = structuredClone(a.tasks), links = a.links.map(({ id, from, to, type, lag }) => ({ id, from, to, type, lag })); fn(tasks, links);
  return view(tasks, links, calendar, auto, frozen);
}
function check(a, b) {
  const before = [a.serialize(), b.serialize()];
  const w = finishWaterfall(a, b);
  assert.equal(w.available, true);
  assert.deepEqual([a.serialize(), b.serialize()], before, 'inputs and derived links are unchanged');
  assert.equal(w.steps.reduce((s, r) => s + r.work, 0), w.work);
  assert.equal(w.steps.reduce((s, r) => s + r.days, 0), w.days);
  let end = w.baseline; for (const row of w.steps) { assert.equal(row.from, end); end = row.to; } assert.equal(end, w.compared);
  return w;
}

test('duration revision counts downstream movement once and includes completed drivers', () => {
  const a = view([task(1, 'Frontend', 5, { progress: 100 }), task(2, 'QA', 3), task(3, 'Launch', 0)], [link('l1', 1, 2), link('l2', 2, 3)]);
  const b = revise(a, (tasks) => { tasks[0].dur += 6; });
  const w = check(a, b); assert.equal(w.work, 6); assert.equal(w.steps.length, 1);
  assert.equal(w.steps[0].title, 'Frontend'); assert.deepEqual(w.steps[0].driversBefore, ['Frontend']);
  assert(w.steps[0].paths.some((p) => p.join(' → ') === 'Frontend → QA → Launch'));
});

test('addition and its dependency replacement are one named contribution; reverse is removal', () => {
  const a = view([task(1, 'Frontend', 5), task(2, 'QA', 3)], [link('l1', 1, 2)]);
  const b = revise(a, (tasks, links) => { tasks.push(task(3, 'Security approval', 3)); links.splice(0, 1, link('l2', 1, 3), link('l3', 3, 2)); });
  const w = check(a, b); assert.equal(w.steps.length, 1); assert.equal(w.steps[0].type, 'added'); assert.equal(w.steps[0].work, 3); assert.equal(w.steps[0].title, 'Security approval');
  const back = check(b, a); assert.equal(back.steps[0].type, 'removed'); assert.equal(back.steps[0].work, -3); assert.equal(back.work, -3);
});

test('independent parallel revisions have a joint effect rather than duplicate attributed shares', () => {
  const a = view([task(1, 'Branch A', 5), task(2, 'Branch B', 5), task(3, 'Launch', 0)], [link('l1', 1, 3), link('l2', 2, 3)]);
  const b = revise(a, (tasks) => { tasks[0].dur += 3; tasks[1].dur += 3; });
  const w = check(a, b); assert.equal(w.work, 3); assert.equal(w.steps.length, 1); assert.equal(w.steps[0].type, 'parallel'); assert.equal(w.steps[0].items.length, 2);
});

test('a formerly noncritical branch that becomes the finish driver contributes', () => {
  const a = view([task(1, 'Main', 7), task(2, 'Docs', 3), task(3, 'Launch', 0)], [link('l1', 1, 3), link('l2', 2, 3)]);
  const b = revise(a, (tasks) => { tasks[1].dur = 10; });
  const w = check(a, b); assert.equal(w.work, 3); assert.equal(w.steps[0].work, 3); assert.deepEqual(w.steps[0].driversBefore, []); assert.deepEqual(w.steps[0].driversAfter, ['Docs']);
});

test('non-driving edits remain visible with zero contribution', () => {
  const a = view([task(1, 'Main', 10), task(2, 'Docs', 3)]);
  const b = revise(a, (tasks) => { tasks[1].dur = 4; });
  const w = check(a, b); assert.equal(w.work, 0); assert.equal(w.steps[0].work, 0); assert.equal(w.steps[0].title, 'Docs');
});

test('offsetting revisions preserve both contributions despite no net movement', () => {
  const a = view([task(1, 'Frontend', 5), task(2, 'QA', 5)], [link('l1', 1, 2)]);
  const b = revise(a, (tasks) => { tasks[0].dur += 2; tasks[1].dur -= 2; });
  const w = check(a, b); assert.equal(w.work, 0); assert.deepEqual(w.steps.map((s) => s.work), [2, -2]);
});

test('project completion attribution is independent of the selected milestone scope', () => {
  const a = view([task(1, 'Design', 3), task(2, 'Design gate', 0), task(3, 'Rollout', 10)], [link('l1', 1, 2)]);
  const b = revise(a, (tasks) => { tasks[2].dur += 4; });
  a.criticalTargetId = b.criticalTargetId = 2; a.recalc(); b.recalc();
  assert.equal(b.info.get(3).critical, false);
  assert.equal(check(a, b).steps[0].work, 4);
});

test('calendar edits are named and measured using the compared calendar; holiday names alone do not move finish', () => {
  const a = view([task(1, 'Build', 5)], [], weekdays);
  const calendar = { ...weekdays, holidays: [{ date: '2026-11-04', name: 'Offsite' }] };
  const b = revise(a, () => {}, { calendar }); const w = check(a, b);
  assert.equal(w.steps[0].type, 'calendar'); assert.equal(w.steps[0].days, 3); assert.equal(w.steps[0].work, 1);
  const renamed = revise(b, () => {}, { calendar: { ...calendar, holidays: [{ ...calendar.holidays[0], name: 'Holiday' }] } });
  assert.equal(check(b, renamed).steps[0].days, 0);
});

test('manual dates and paused Auto use saved dates with no implied dependency propagation', () => {
  const a = view([task(1, 'Manual', 3, { scheduling: 'manual' }), task(2, 'Launch', 0)], [link('l1', 1, 2)]);
  const b = revise(a, (tasks) => { tasks[0].start += 4; }); assert.equal(check(a, b).work, 4);
  const paused = revise(a, (tasks) => { tasks[0].start += 4; }, { auto: false }); const w = check(a, paused);
  assert.equal(w.paused, true); assert.equal(w.steps[0].work, 4); assert.equal(paused.byId.get(2).start, a.byId.get(2).start, 'Launch retains its saved date while Auto is paused'); assert.equal(w.steps.some((s) => s.type === 'residual'), false);
});

test('unreproducible frozen saved dates are a visible residual, never a fabricated task cause', () => {
  const a = view([task(1, 'Build', 3), task(2, 'QA', 2)], [link('l1', 1, 2)]);
  const b = revise(a, (tasks) => { tasks[1].start += 5; }, { frozen: true }); const w = check(a, b);
  assert.equal(w.steps.length, 1); assert.equal(w.steps[0].type, 'residual'); assert.equal(w.steps[0].work, 5); assert.equal(w.steps[0].items[0].name, 'QA');
});

test('dependency type and signed lag revisions use the scheduler endpoints', () => {
  for (const type of ['FS', 'SS', 'FF', 'SF']) for (const lag of [-2, 2]) {
    const a = view([task(1, 'Predecessor', 5), task(2, 'Successor', 3)], [link('l1', 1, 2, 'FS', 0)]);
    const b = revise(a, (_, links) => { links[0].type = type; links[0].lag = lag; });
    const w = check(a, b); assert.equal(w.steps.some((s) => s.type === 'residual'), false, `${type} ${lag}`); assert.equal(w.steps[0].type, 'links');
  }
});

test('structural conversion and mixed task scope are evaluated without summary double counting', () => {
  const a = view([task(1, 'Phase', 2), task(2, 'Launch', 0)], [link('l1', 1, 2)]);
  const b = revise(a, (tasks, links) => { tasks[0].level = 0; tasks.splice(1, 0, task(3, 'Child', 5, { level: 1 })); links.splice(0, 1, link('l2', 3, 2)); });
  const w = check(a, b); assert.equal(w.work, 3); assert.equal(w.steps[0].type, 'scope'); assert(w.steps[0].items.some((i) => i.name === 'Child'));
});

test('metadata edits do not create contributions; identical plans produce no steps', () => {
  const a = view([task(1, 'Build', 5)]), b = revise(a, (tasks) => { tasks[0].name = 'Renamed'; tasks[0].owner = 'Ada'; tasks[0].progress = 70; });
  assert.deepEqual(check(a, b).steps, []); assert.deepEqual(check(a, a).steps, []);
});

test('calendar-day motion remains visible when compared calendar counts zero working days', () => {
  const a = view([task(1, 'Manual milestone', 0, { start: day + 5, scheduling: 'manual' })], [], weekdays, false, true);
  const b = revise(a, (tasks) => { tasks[0].start += 1; }, { auto: false, frozen: true });
  const w = check(a, b); assert.equal(w.work, 0); assert.equal(w.days, 1); assert.equal(w.steps[0].days, 1);
});

test('empty and cyclic schedules explain why attribution is unavailable', () => {
  const a = view([]), b = view([task(1, 'Build', 5)]);
  assert.equal(finishWaterfall(a, b).available, false);
  const cycle = view([task(1, 'A', 2), task(2, 'B', 2)], [link('l1', 1, 2), link('l2', 2, 1)], daily, false, true);
  assert.equal(finishWaterfall(cycle, b).available, false);
});

test('resuming Auto is attributed separately from a calendar rename or task revision', () => {
  const calendar = { ...daily, holidays: [{ date: '2026-12-25', name: 'Holiday' }] };
  const a = view([task(1, 'Build', 5), task(2, 'QA', 2, { start: day + 1 })], [link('l1', 1, 2)], calendar, false, true);
  const b = revise(a, () => {}, { auto: true, calendar: { ...calendar, holidays: [{ date: '2026-12-25', name: 'Renamed' }] } });
  const w = check(a, b); assert.equal(w.steps[0].type, 'scheduling'); assert.equal(w.steps[0].work, 2); assert.equal(w.steps[1].type, 'calendar'); assert.equal(w.steps[1].work, 0);
});

test('inconsistent baseline dates are aligned explicitly before unrelated edits', () => {
  const a = view([task(1, 'Build', 5), task(2, 'QA', 2, { start: day + 1 })], [link('l1', 1, 2)], daily, true, true);
  const b = revise(a, (tasks) => { tasks[0].dur += 1; });
  const w = check(a, b); assert.equal(w.steps[0].type, 'residual'); assert.equal(w.steps[0].work, 2); assert.equal(w.steps[1].work, 1);
});

test('deterministic randomized mixed-endpoint schedules reconcile without unexplained residuals', () => {
  let seed = 2026; const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 60; trial++) {
    const tasks = Array.from({ length: 7 }, (_, i) => task(i + 1, `Task ${i + 1}`, 1 + rnd(8)));
    const links = []; let n = 1;
    for (let to = 2; to <= 7; to++) { const from = 1 + rnd(to - 1); links.push(link(`l${n++}`, from, to, ['FS', 'SS', 'FF', 'SF'][rnd(4)], rnd(5) - 2)); }
    const a = view(tasks, links, trial % 2 ? weekdays : daily);
    const b = revise(a, (ts, ls) => { ts[rnd(7)].dur += 1 + rnd(3); ts[rnd(7)].dur += 1 + rnd(3); ls[rnd(ls.length)].lag += rnd(3); });
    const w = check(a, b); assert.equal(w.steps.some((s) => s.type === 'residual'), false, `trial ${trial}`);
  }
});

test('anchored dates can move earlier explicitly or later to satisfy revised predecessors', () => {
  const a = view([task(1, 'Build', 4), task(2, 'Anchored QA', 3, { start: day + 8, scheduling: 'anchor' })], [link('l1', 1, 2)]);
  const b = revise(a, (tasks) => { tasks[1].start = day + 5; });
  assert.equal(check(a, b).work, -3);
  const c = revise(a, (tasks) => { tasks[0].dur = 11; });
  const w = check(a, c); assert.equal(w.work, 3); assert.equal(w.steps.length, 2, 'retained anchor dates are inputs and remain visible even when their later replay step has no effect');
  assert.equal(w.steps[0].title, 'Build'); assert.equal(w.steps[1].work, 0);
});
