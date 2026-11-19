import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, D, cleanVersions } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import * as dl from '../src/project_management_tool/web/js/delays.js';
import { loadCauses, saveCauses } from '../src/project_management_tool/web/js/causes.js';
import { encodeProjectFile, openProjectFile, parseProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';

beforeEach(() => {
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), key: (i) => [...memory.keys()][i], get length() { return memory.size; } };
  appState.restore({});
});

// The mockup's "Office fit-out": a seven-day calendar, so agreed dates read as calendar dates.
function demo(calendar = { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] }) {
  const T = (id, name, level, o = {}) => ({ id, name, level, start: D('2026-11-02'), dur: 5, progress: 0, owner: '', email: '', noRem: false, ms: false, scheduling: 'auto', ...o });
  const tasks = [T(1, 'Office fit-out', 0), T(2, 'Design', 1), T(3, 'Space planning', 2, { progress: 100, owner: 'Mia' }), T(4, 'Design review', 2, { dur: 28, owner: 'Priya' }),
    T(5, 'Permit', 2, { ms: true, dur: 0 }), T(6, 'Procurement', 1), T(7, 'Supplier delivery', 2, { dur: 10, progress: 60, owner: 'Tom' }), T(8, 'Furniture on site', 2, { ms: true, dur: 0 }),
    T(9, 'Artwork & plants', 2, { dur: 3, start: D('2026-12-08') }), T(10, 'Site works', 1), T(11, 'Strip-out & prep', 2, { dur: 18, progress: 35 }), T(12, 'Fit-out', 2, { dur: 20, owner: 'Sana' }),
    T(13, 'Joinery & finishes', 2, { dur: 5, owner: 'Sana' }), T(14, 'Handover', 2, { ms: true, dur: 0 }), T(15, 'Close-out', 1), T(16, 'Snag list', 2, { dur: 17, owner: 'Omar' })];
  const L = (from, to, type = 'FS', lag = 0) => ({ from, to, type, lag });
  const links = [L(3, 4), L(3, 7), L(3, 11), L(4, 5), L(5, 13), L(7, 8, 'FS', 3), L(8, 12), L(11, 12), L(12, 13), L(13, 14), L(14, 16)].map((l, i) => ({ id: `l${i + 1}`, ...l }));
  const data = { calendar, tasks, links, collapsed: [], nextId: 17, nextLink: links.length + 1 };
  return new Store({ workbook: { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Office fit-out', data, rem: {} }] }, templates: [], preferences: {}, history: {} });
}
const fd = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
const C = (name) => loadCauses().list.find((c) => c.name === name).id;

// The mockup's story: agree a baseline, then record a supplier overrun, a revision and a late start.
function story() {
  const s = demo();
  assert.equal(dl.setAgreed(s, 5, dl.fin(s, 5)), null);
  assert.equal(dl.agreeBaseline(s), null);
  let pre = dl.snapshotBefore(s);
  s.beginDrag(); s.dragApply(() => s.dragResize(12, 'r', 4)); s.endDrag(true);
  assert.equal(dl.record(s, 12, pre, { type: 'delay', cause: C('Supplier / subcontractor'), party: 'Acme Interiors' }), null);
  pre = dl.snapshotBefore(s);
  assert.equal(s.setCell(13, 'end', '2026-12-26'), null);
  assert.equal(dl.record(s, 13, pre, { type: 'revision', reason: 'Client added level 3', approvedBy: 'Steering group' }), null);
  pre = dl.snapshotBefore(s);
  assert.equal(s.setCell(4, 'start', '2026-11-17'), null);
  assert.equal(dl.record(s, 4, pre, { type: 'delay', op: 'start', cause: C('Client / approver'), party: 'Client PM' }, { anchor: true }), null);
  return s;
}

test('nothing is agreed until someone agrees it; a single deadline gives the project no agreed date', () => {
  const s = demo();
  assert.equal(dl.hasAgreed(s), false);
  assert.equal(dl.setAgreed(s, 5, D('2026-12-05')), null);
  assert.equal(dl.row(s, 5).agreed, D('2026-12-05'));
  assert.equal(dl.row(s, 12), null);
  assert.equal(dl.agreedOf(s, 1), null, 'summaries roll up only after a baseline');
  assert.equal(dl.completion(s), null);
  dl.agreeBaseline(s);
  assert.equal(fd(dl.completion(s).f), '2027-01-05');
  assert.equal(fd(dl.agreedOf(s, 1).f), '2027-01-05');
  assert.equal(dl.row(s, 5).agreed, D('2026-12-05'), 'a deadline already set stays');
});

test('the Office fit-out story reproduces the mockup numbers', () => {
  const s = story();
  assert.deepEqual(['Permit', 'Handover', 'Project completion'].map((n) => dl.milestoneTable(s, loadCauses()).find((r) => r.name === n)).map((r) => [fd(r.orig), fd(r.cur), fd(r.exp), r.delay]), [
    ['2026-12-05', '2026-12-05', '2026-12-15', 10], ['2026-12-20', '2026-12-23', '2026-12-27', 4], ['2027-01-05', '2027-01-08', '2027-01-12', 4]]);
  const rows = dl.milestoneTable(s, loadCauses());
  assert.equal(rows.find((r) => r.name === 'Permit').status, 'Late · end not affected');
  assert.equal(rows.find((r) => r.name === 'Handover').status, 'Late');
  assert.equal(rows.find((r) => r.name === 'Furniture on site').status, 'On time');
  assert.equal(s.byId.get(4).scheduling, 'anchor', 'only a late start uses the Date anchor');
  assert.equal(s.byId.get(12).scheduling, 'auto', 'a finish edit keeps Auto');
  assert.equal(s.byId.get(13).scheduling, 'auto');
});

test('own + inherited + revision = total for every task and milestone', () => {
  const s = story();
  assert.deepEqual(dl.reconcile(s), []);
  const r = (id) => { const x = dl.row(s, id); return [x.own, x.inherited, x.rev, x.total]; };
  assert.deepEqual(r(12), [4, 0, 0, 4]);
  assert.deepEqual(r(13), [0, 4, 3, 7]);
  assert.deepEqual(r(14), [0, 4, 3, 7]);
  assert.deepEqual(r(4), [10, 0, 0, 10]);
  assert.deepEqual(r(5), [0, 10, 0, 10]);
  assert.equal(dl.row(s, 5).source, 4);
  assert.equal(dl.originOf(s, 16), 12);
});

test('every impact grid column sums exactly to its milestone total, including absorbed delay', () => {
  const s = story(), g = dl.impactGrid(s, loadCauses());
  for (const c of g.cols) assert.equal(g.rows.reduce((n, r) => n + (r.effects[c.id] || 0), 0) + g.unexplained[c.id], c.total, c.name);
  assert.equal(g.unexplained.end, 0);
  const col = (name) => g.cols.find((c) => c.name === name).id;
  const cell = (label, name) => g.rows.find((r) => r.label.startsWith(label)).effects[col(name)];
  assert.equal(cell('Design review', 'Permit'), 10);
  assert.equal(cell('Design review', 'Handover'), 0, 'absorbed by spare time');
  assert.equal(cell('Fit-out', 'Handover'), 4);
  assert.equal(cell('Revision', 'Handover'), 3);
  const w = dl.explainSteps(s, loadCauses(), col('Handover'));
  assert.deepEqual(w.steps.map((x) => [x.type, x.days]), [['revision', 3], ['delay', 4]]);
  assert.equal(fd(w.steps.at(-1).to), '2026-12-27');
  assert.equal(fd(w.agreed), '2026-12-23');
});

test('unrecorded movement lands in Other / unexplained so columns still add up', () => {
  const s = demo(); dl.agreeBaseline(s);
  s.tx(() => { s.byId.get(12).dur += 3; }); // moved without recording why
  const g = dl.impactGrid(s, loadCauses()), end = g.cols.find((c) => c.id === 'end');
  assert.equal(end.total, 3); assert.equal(g.unexplained.end, 3); assert.equal(g.rows.length, 0);
  assert.deepEqual(dl.reconcile(s), []);
  assert.equal(dl.row(s, 12).own, 3, 'with no late predecessor the whole delay is its own');
});

test('only the task where a delay started is shaded', () => {
  const s = story();
  const own = dl.ganttModel(s, 12), pushed = dl.ganttModel(s, 13), ms = dl.ganttModel(s, 14);
  assert.equal(own.shade.days, 4);
  assert.equal(own.shade.to, s.info.get(12).end);
  assert.equal(own.shade.to - own.shade.from, 4);
  assert.equal(pushed.shade, null); assert.equal(pushed.inheritedFrom, 12);
  assert.equal(ms.shade, null); assert.equal(ms.marker, 'diamond');
  assert.equal(own.marker, 'triangle');
  const late = dl.ganttModel(s, 4);
  assert.deepEqual(late.leadIn, { from: s.byId.get(4).agr.s, to: s.info.get(4).start });
});

test('a task with inherited and own delay shades only its own part', () => {
  const s = demo(); dl.agreeBaseline(s);
  let pre = dl.snapshotBefore(s);
  s.tx(() => { s.byId.get(12).dur += 4; });
  dl.record(s, 12, pre, { type: 'delay', cause: C('Estimate / rework') });
  pre = dl.snapshotBefore(s);
  s.tx(() => { s.byId.get(13).dur += 2; });
  dl.record(s, 13, pre, { type: 'delay', cause: C('Resource availability') });
  const r = dl.row(s, 13); assert.deepEqual([r.own, r.inherited, r.v], [2, 4, 6]);
  const g = dl.ganttModel(s, 13), end = s.info.get(13).end;
  assert.equal(g.shade.to, end); assert.equal(end - g.shade.from, 2);
  assert.equal(dl.explain(s, 13, loadCauses()).parts[1], 'Inherited +4 from Fit-out (Estimate / rework)');
});

test('agreed dates change only through the listed actions', () => {
  const s = demo(); dl.agreeBaseline(s);
  const agreed = () => JSON.stringify([...s.tasks].sort((a, b) => a.id - b.id).map((t) => t.agr));
  const before = agreed();
  s.setCell(12, 'dur', '30'); s.setCell(3, 'start', '2026-11-05'); s.beginDrag(); s.dragApply(() => s.dragMove(7, 3)); s.endDrag(true);
  s.setCell(4, 'end', '2026-12-30'); s.moveTask(9, 3, 'after'); s.setCell(11, 'progress', '50');
  assert.equal(agreed(), before, 'edits, drags and moves never touch agreed dates');
  assert.equal(dl.setAgreed(s, 12, D('2026-12-20')), 'Changing an agreed date needs a reason and who approved it');
  assert.equal(dl.setAgreed(s, 12, D('2026-12-20'), { reason: 'Client', approvedBy: 'PM' }), null);
  assert.equal(s.byId.get(12).agr.f, D('2026-12-20')); assert.equal(s.byId.get(12).agr.o, D('2026-12-14'), 'original agreed stays the first one');
  assert.equal(s.log.at(-1).type, 'revision');
  assert.equal(dl.agreeBaseline(s, { replace: true }), 'Changing agreed dates needs a reason and who approved it');
  assert.equal(dl.agreeBaseline(s, { replace: true, reason: 'Re-baseline', approvedBy: 'SG' }), null);
  assert.equal(s.byId.get(12).agr.f, dl.fin(s, 12)); assert.equal(s.byId.get(12).agr.o, D('2026-12-14'));
  assert.ok(s.log.filter((e) => e.source === 'baseline').length >= 1);
});

test('overdue follows each task calendar and holidays and ignores finished work', () => {
  const s = demo({ workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-11', name: 'Holiday' }] });
  dl.agreeBaseline(s);
  const t = s.byId.get(7), end = dl.fin(s, 7);
  assert.equal(dl.overdue(s, 7, end), 0, 'not overdue on the agreed day');
  const day = (iso) => D(iso);
  const monAfter = s.work.next(end + 1);
  assert.equal(dl.overdue(s, 7, monAfter), 1);
  assert.equal(dl.overdue(s, 7, monAfter + 7), 6, 'weekends do not count');
  t.progress = 100; assert.equal(dl.overdue(s, 7, monAfter + 7), 0);
  assert.equal(dl.overdue(s, 1, day('2030-01-01')), 0, 'summaries are never overdue');
  t.progress = 60;
  const before = dl.fin(s, 7);
  dl.overdue(s, 7, monAfter); assert.equal(dl.fin(s, 7), before, 'the app moves nothing by itself');
  // a milestone
  assert.ok(dl.overdue(s, 5, D('2027-03-01')) > 0);
});

test('a task added after agreement is a pending inclusion until agreed', () => {
  const s = demo(); dl.agreeBaseline(s);
  const { id } = s.insertTask(12);
  assert.equal(s.byId.get(id).inc, true); assert.equal(s.byId.get(id).agr, undefined);
  assert.equal(dl.row(s, id), null);
  const endBefore = dl.completion(s).f;
  assert.equal(dl.completion(s).f, endBefore, 'a pending task changes no agreed date');
  assert.equal(dl.agreeInclusion(s, id, { reason: '', approvedBy: '' }), 'An agreed inclusion needs a reason and who approved it');
  assert.equal(dl.agreeInclusion(s, id, { reason: 'Level 3 outlets', approvedBy: 'SG', finishDay: dl.fin(s, id) + 2 }), null);
  const t = s.byId.get(id);
  assert.equal(t.inc, undefined); assert.equal(t.agr.f, dl.fin(s, id) + 2); assert.equal(t.agr.o, t.agr.f);
  assert.equal(s.log.at(-1).type, 'inclusion');
  s.undo(); assert.equal(s.byId.get(id).inc, true); s.redo(); assert.ok(s.byId.get(id).agr);
  const fresh = demo(); fresh.insertTask(12);
  assert.equal(fresh.tasks.some((x) => x.inc), false, 'nothing is pending before an agreement exists');
});

test('omission keeps a record, delete keeps none', () => {
  const s = demo(); dl.agreeBaseline(s);
  assert.equal(dl.omit(s, 9, { reason: '', approvedBy: '' }), 'An agreed omission needs a reason and who approved it');
  assert.equal(dl.omit(s, 9, { reason: 'Art budget dropped', approvedBy: 'SG' }), null);
  assert.equal(s.byId.has(9), false);
  const e = s.log.at(-1); assert.deepEqual([e.type, e.taskName, e.reason, e.approvedBy, e.days], ['omission', 'Artwork & plants', 'Art budget dropped', 'SG', 3]);
  assert.equal(dl.delayLog(s, loadCauses()).at(-1).taskName, 'Artwork & plants', 'the record outlives the task');
  const n = s.log.length;
  s.deleteTask(3); assert.equal(s.log.length, n, 'Delete keeps nothing');
  s.undo(); assert.equal(s.byId.has(3), true);
  s.undo(); assert.equal(s.byId.has(9), true); assert.equal(s.log.length, n - 1);
  assert.equal(dl.hasAgreedRows(s, 9), true);
});

test('undo and redo cover agreed dates, the log and every record', () => {
  const s = demo(), snap = () => s.snap();
  const steps = [];
  const step = (fn) => { const before = snap(); fn(); assert.notEqual(snap(), before); steps.push(before); };
  step(() => dl.setAgreed(s, 5, D('2026-12-05')));
  step(() => dl.agreeBaseline(s));
  step(() => { const pre = dl.snapshotBefore(s); s.setCell(12, 'dur', '24'); dl.record(s, 12, pre, { type: 'delay', cause: C('Estimate / rework') }); });
  step(() => { const pre = dl.snapshotBefore(s); s.setCell(13, 'end', '2026-12-26'); dl.record(s, 13, pre, { type: 'revision', reason: 'r', approvedBy: 'a' }); });
  step(() => dl.reclassify(s, s.log[0].id, { cause: C('Unknown'), party: 'X' }));
  const final = snap();
  for (let i = steps.length - 1; i >= 0; i--) { s.undo(); assert.equal(snap(), steps[i], `undo step ${i}`); }
  assert.equal(dl.hasAgreed(s), false);
  for (let i = 0; i < steps.length; i++) s.redo();
  assert.equal(snap(), final);
  assert.equal(s.log.length, 2);
});

test('an edit and its record are one undo step; cancelling is undo', () => {
  const s = demo(); dl.agreeBaseline(s);
  const base = s.snap(), pre = dl.snapshotBefore(s);
  s.setCell(12, 'dur', '25'); dl.record(s, 12, pre, { type: 'delay' });
  assert.equal(s.log.length, 1);
  s.undo(); assert.equal(s.snap(), base);
  s.setCell(12, 'dur', '25'); s.undo(); assert.equal(s.snap(), base, 'cancel reverts the edit');
});

test('the edit hook sees typed and dragged edits and reports the prior state', () => {
  const s = demo(); dl.agreeBaseline(s); const seen = [];
  s.hook = { before: () => dl.snapshotBefore(s), after: (e) => seen.push([e.id, e.kind, e.pre.fins.get(e.id)]) };
  const old = dl.fin(s, 12);
  s.setCell(12, 'dur', '22'); s.setCell(12, 'name', 'Fit-out x'); s.setCell(12, 'owner', 'Zed');
  s.beginDrag(); s.dragApply(() => s.dragResize(12, 'r', 1)); s.endDrag(true, { id: 12, kind: 'rr' });
  s.beginDrag(); s.dragApply(() => s.dragResize(12, 'r', 1)); s.endDrag(false, { id: 12, kind: 'rr' });
  assert.deepEqual(seen.map((x) => x.slice(0, 2)), [[12, 'dur'], [12, 'rr']]);
  assert.equal(seen[0][2], old);
});

test('read-only version previews cannot agree or record', () => {
  const s = demo(); dl.agreeBaseline(s);
  s.snapshotVersion({ name: 'B', type: 'baseline' });
  s.previewVersion('v1');
  for (const r of [dl.setAgreed(s, 5, 1), dl.agreeBaseline(s), dl.omit(s, 9, { reason: 'r', approvedBy: 'a' }), dl.agreeInclusion(s, 9, { reason: 'r', approvedBy: 'a' })]) assert.ok(r);
  assert.ok(dl.row(s, 12), 'the preview still shows the agreed columns');
});

test('version types: kept, editable, legacy versions untyped, default baseline is the latest Agreed baseline', () => {
  const s = demo(); dl.agreeBaseline(s);
  s.snapshotVersion({ name: 'one', type: 'baseline' });
  s.snapshotVersion({ name: 'two', type: 'status' });
  s.snapshotVersion({ name: 'three' });
  assert.deepEqual(s.versions().map((v) => v.type ?? null), ['baseline', 'status', null]);
  assert.equal(dl.latestBaseline(s.versions()).name, 'one');
  assert.equal(s.updateVersion('v3', { type: 'baseline' }), null);
  assert.equal(dl.latestBaseline(s.versions()).name, 'three');
  assert.equal(s.updateVersion('v3', { type: 'bogus' }), 'Unknown version type');
  assert.equal(s.updateVersion('v3', { type: '' }), null); assert.equal('type' in s.version('v3'), false);
  const legacy = cleanVersions([{ n: 1, name: 'old', data: JSON.stringify({ tasks: [], links: [] }), at: 1 }]);
  assert.equal('type' in legacy[0], false); assert.equal(dl.latestBaseline(legacy), null);
  assert.equal(dl.versionTypeLabel({ type: 'baseline' }), 'Agreed baseline');
  assert.ok(s.versionView('v1').tasks.find((t) => t.id === 12).agr, 'versions keep the agreed dates they were taken with');
});

test('causes: rename updates delays, in-use causes retire, unused ones are removed, order is kept', () => {
  const causes = dl.cleanCauses(null), s = story();
  const sup = C('Supplier / subcontractor'), id = loadCauses().list.find((c) => c.id === sup).id;
  assert.equal(dl.renameCause(causes, id, 'Vendor'), null);
  assert.equal(dl.causeName(causes, id), 'Vendor'); assert.equal(s.log.find((e) => e.cause === id).cause, id, 'delays keep the id');
  assert.equal(dl.renameCause(causes, id, 'Unknown'), 'That cause already exists');
  assert.equal(dl.removeCause(causes, id, dl.causeInUse(s.log, id)), 'retired');
  assert.equal(dl.causeName(causes, id), 'Vendor'); assert.equal(dl.activeCauses(causes).some((c) => c.id === id), false);
  assert.equal(dl.addCause(causes, 'Weather'), null); assert.equal(dl.addCause(causes, 'weather'), 'That cause already exists');
  const w = causes.list.at(-1).id; assert.equal(dl.removeCause(causes, w, false), 'removed');
  assert.equal(dl.addCause(causes, 'Vendor'), null); assert.equal(causes.list.find((c) => c.id === id).retired, false, 'adding a retired name brings it back');
  dl.moveCause(causes, 'c6', 0); assert.equal(causes.list[0].id, 'c6');
  assert.equal(dl.causeName(causes, null), 'Unclassified');
  assert.deepEqual(dl.cleanCauses({ list: [{ id: 'c9', name: ' A ' }, { id: 'c9', name: 'B' }, { id: 'x', name: '' }], next: 1 }), { list: [{ id: 'c9', name: 'A', retired: false }], next: 10 });
});

test('the cause list persists in app settings', () => {
  const c = loadCauses(); dl.addCause(c, 'Weather'); saveCauses(c);
  const again = loadCauses(); assert.equal(again.list.at(-1).name, 'Weather');
  assert.ok(JSON.parse(appState.snapshot()['pm-delay-causes']).list.length);
  appState.restore(appState.snapshot()); assert.equal(loadCauses().list.at(-1).name, 'Weather');
});

test('format 6 round-trips agreed dates, the log, version types and the causes used', () => {
  const s = story(); s.snapshotVersion({ name: 'Baseline', type: 'baseline' });
  const text = encodeProjectFile(s), doc = JSON.parse(text);
  assert.equal(doc.version, 6);
  assert.deepEqual(doc.project.causes.map((c) => c.name).sort(), ['Client / approver', 'Supplier / subcontractor']);
  assert.equal(doc.project.versions[0].type, 'baseline');
  const parsed = parseProjectFile(text); assert.equal(parsed.data.log.length, 3);
  const id = openProjectFile(s, text);
  assert.notEqual(id, 's1');
  assert.equal(s.log.length, 3); assert.equal(s.baselined, true);
  assert.equal(fd(s.byId.get(13).agr.f), '2026-12-22'); assert.equal(s.byId.get(13).agr.o, D('2026-12-19'));
  assert.equal(s.versions()[0].type, 'baseline');
  assert.deepEqual(dl.reconcile(s), []);
  assert.equal(JSON.parse(encodeProjectFile(s)).project.data.log.length, 3);
});

test('opening a file with unknown causes adds them to the list and maps known ones by name', () => {
  const s = story(), text = encodeProjectFile(s);
  const doc = JSON.parse(text);
  doc.project.causes = [{ id: 'z1', name: 'Weather' }, { id: 'z2', name: 'client / approver' }];
  doc.project.data.log.forEach((e, i) => { if (e.type === 'delay') e.cause = i % 2 ? 'z1' : 'z2'; });
  for (const v of doc.project.versions || []) void v;
  openProjectFile(s, JSON.stringify(doc));
  const list = loadCauses().list, weather = list.find((c) => c.name === 'Weather');
  assert.ok(weather); assert.equal(weather.retired, true, 'unknown causes stay out of the picker');
  const causeIds = s.log.filter((e) => e.type === 'delay').map((e) => e.cause);
  assert.ok(causeIds.every((c) => list.some((x) => x.id === c)));
  assert.ok(causeIds.includes(C('Client / approver')));
});

test('format 5 and older files open with no agreed data; invalid format 6 data is rejected', () => {
  const s = demo(), text = encodeProjectFile(s), doc = JSON.parse(text);
  assert.ok(doc.version <= 3 && !doc.project.causes && !('log' in doc.project.data));
  for (const v of [3, 4, 5]) { const d = JSON.parse(text); d.version = v; openProjectFile(s, JSON.stringify(d)); assert.equal(dl.hasAgreed(s), false); assert.equal(s.baselined, false); }
  const agreed = (mut, version = 6) => { const t = story(); const d = JSON.parse(encodeProjectFile(t)); d.version = version; mut(d); return JSON.stringify(d); };
  assert.throws(() => parseProjectFile(agreed(() => {}, 5)), /require file version 6/);
  assert.throws(() => parseProjectFile(agreed((d) => { d.project.data.tasks[2].agr.f = 1.5; })), /invalid agreed dates/);
  assert.throws(() => parseProjectFile(agreed((d) => { d.project.data.tasks[0].agr = { s: 1, f: 1, o: 1 }; })), /summary/);
  assert.throws(() => parseProjectFile(agreed((d) => { d.project.data.log[0].type = 'x'; })), /change log entry is invalid/);
  assert.throws(() => parseProjectFile(agreed((d) => { d.project.data.log.find((e) => e.type === 'delay').cause = 'nope'; })), /cause the file does not define/);
  assert.throws(() => parseProjectFile(agreed((d) => { d.project.data.nextLog = 1; })), /next change log number/);
  assert.throws(() => parseProjectFile(agreed((d) => { d.project.causes = [{ id: 'a', name: '' }]; })), /cause is invalid/);
  assert.throws(() => parseProjectFile(agreed((d) => { const s2 = demo(); s2.snapshotVersion({ name: 'v' }); void s2; d.project.versions = [{ n: 1, name: 'v', note: '', at: new Date(0).toISOString(), by: '', auto: true, target: null, type: 'zzz', plan: JSON.parse(JSON.stringify(d.project.data)) }]; d.project.nextVersion = 2; d.version = 6; })), /version type is invalid/);
});

test('owners are charged only with the delay that started at their tasks', () => {
  const s = story(), rows = dl.ownerTable(s), by = (o) => rows.find((r) => r.owner === o);
  assert.equal(by('Priya').own, 10); assert.equal(by('Sana').own, 4); assert.equal(by('Sana').inherited, 4);
  assert.equal(by('Omar').own, 0); assert.equal(by('Omar').inherited, 4);
  assert.equal(by('Priya').unclassified, 0);
  const t = dl.record(s, 12, dl.snapshotBefore(s), { type: 'delay', cause: null });
  assert.equal(t, null);
  assert.equal(dl.ownerTable(s).find((r) => r.owner === 'Sana').unclassified, 1);
});

test('Skip reason records an unclassified delay and the log lists every kind of change', () => {
  const s = demo(); dl.agreeBaseline(s);
  const pre = dl.snapshotBefore(s); s.setCell(7, 'dur', '12');
  assert.equal(dl.record(s, 7, pre, { type: 'delay', cause: null }), null);
  const log = dl.delayLog(s, loadCauses());
  assert.deepEqual([log[0].typeLabel, log[0].causeLabel, log[0].kind, log[0].days], ['Delay', 'Unclassified', 'Overrun', 2]);
  assert.equal(dl.reclassify(s, log[0].id, { cause: C('Resource availability'), party: 'Tom' }), null);
  assert.equal(dl.delayLog(s, loadCauses())[0].causeLabel, 'Resource availability');
  assert.equal(dl.reclassify(s, 99, {}), 'That entry no longer exists');
});
