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
  assert.ok(weather); assert.equal(weather.retired, false, 'unknown causes join the list as active');
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

// ---- scope changes are not delay ----
function baselined() { const s = demo(); dl.setAgreed(s, 5, dl.fin(s, 5)); dl.agreeBaseline(s); return s; }
function insertJoineryFollower(s, dur = 4) {
  const { id } = s.insertTask(13); s.setCell(id, 'dur', String(dur));
  assert.equal(s.addLink(13, 'f', id, 's'), null); assert.equal(s.addLink(id, 'f', 14, 's'), null);
  return id;
}
const parts = (s, id) => { const r = dl.row(s, id); return [r.own, r.inherited, r.pend, r.rev, r.total]; };

test('a pending inclusion pushes later tasks without being charged as their delay', () => {
  const s = baselined(), id = insertJoineryFollower(s);
  assert.equal(s.byId.get(id).inc, true);
  assert.deepEqual(parts(s, 14), [0, 0, 4, 0, 4]);
  assert.deepEqual(parts(s, 16), [0, 0, 4, 0, 4]);
  assert.equal(dl.ganttModel(s, 16).shade, null, 'a pushed task is not shaded');
  assert.equal(dl.row(s, 14).pendSource, id);
  assert.deepEqual(dl.reconcile(s), []);
  const end = dl.milestoneTable(s, loadCauses()).find((r) => r.id === 'end');
  assert.deepEqual([end.delay, end.pend, end.status, end.total], [0, 4, 'Pending inclusion', 4]);
  const g = dl.impactGrid(s, loadCauses());
  assert.deepEqual(g.rows.map((r) => [r.label, r.effects.end]), [['Pending inclusion: New task', 4]]);
  assert.deepEqual(g.unexplained, { 5: 0, 8: 0, 14: 0, end: 0 });
  assert.deepEqual(dl.ownerTable(s), [], 'nobody owns the pending push');
});

test('agreeing an inclusion moves the agreed dates it pushes; variance stays zero and the original completion stays', () => {
  const s = baselined(), id = insertJoineryFollower(s), originalEnd = D('2027-01-05');
  assert.equal(dl.agreeInclusion(s, id, { reason: 'Level 3 outlets' }), 'An agreed inclusion needs a reason and who approved it');
  assert.equal(dl.agreeInclusion(s, id, { reason: 'Level 3 outlets', approvedBy: 'SG' }), null);
  assert.deepEqual(parts(s, 14), [0, 0, 0, 4, 4]);
  const c = dl.completion(s);
  assert.deepEqual([c.o, fd(c.f), c.delay, c.rev], [originalEnd, '2027-01-09', 0, 4]);
  const g = dl.impactGrid(s, loadCauses());
  assert.deepEqual(g.rows.map((r) => [r.label, r.effects[14], r.effects.end]), [['Inclusion · New task: Level 3 outlets', 4, 4]]);
  assert.deepEqual(g.unexplained, { 5: 0, 8: 0, 14: 0, end: 0 });
  const w = dl.explainSteps(s, loadCauses(), 'end');
  assert.deepEqual(w.steps.map((x) => [x.type, x.days, x.reason, x.approvedBy]), [['inclusion', 4, 'Level 3 outlets', 'SG']]);
  assert.equal(w.agreed, w.exp);
  s.undo(); assert.equal(s.byId.get(id).inc, true); assert.equal(s.log.length, 0); assert.deepEqual(parts(s, 14), [0, 0, 4, 0, 4]);
  s.redo(); assert.equal(s.byId.get(id).agr.f, dl.fin(s, id)); assert.equal(s.log.length, 1);
});

test('an inclusion that ends the project later does not move the original agreed completion', () => {
  const s = baselined(), { id } = s.insertTask(16); s.setCell(id, 'dur', '6');
  assert.equal(s.addLink(16, 'f', id, 's'), null);
  assert.equal(dl.agreeInclusion(s, id, { reason: 'Extra snagging', approvedBy: 'SG' }), null);
  const c = dl.completion(s);
  assert.equal(c.o, D('2027-01-05')); assert.equal(c.rev, 6); assert.equal(c.delay, 0);
  assert.equal(s.agreedOrig.end, D('2027-01-05'));
  assert.equal(dl.agreedOf(s, 15).o, dl.agreedOf(s, 15).o); assert.equal(dl.agreedOf(s, 1).o, s.agreedOrig.sums[1]);
  assert.equal(JSON.parse(encodeProjectFile(s)).project.data.agreedOrig.end, D('2027-01-05'));
});

test('an agreed omission pulls the agreed dates earlier with the chain kept; it is not a recovery', () => {
  const s = baselined();
  assert.equal(dl.omit(s, 13, { reason: 'Client dropped joinery' }), 'An agreed omission needs a reason and who approved it');
  assert.deepEqual(dl.omitChain(s, 13), { preds: [5, 12], succs: [14] });
  assert.equal(dl.omit(s, 13, { reason: 'Client dropped joinery', approvedBy: 'SG' }), null);
  assert.equal(s.links.some((l) => l.from === 12 && l.to === 14), true, 'the chain is kept');
  assert.deepEqual(parts(s, 14), [0, 0, 0, -5, -5]);
  assert.deepEqual(parts(s, 16), [0, 0, 0, -5, -5]);
  const c = dl.completion(s);
  assert.deepEqual([c.o, fd(c.f), c.delay, c.rev], [D('2027-01-05'), '2026-12-31', 0, -5]);
  const g = dl.impactGrid(s, loadCauses());
  assert.deepEqual(g.rows.map((r) => [r.label, r.effects.end]), [['Omission · Joinery & finishes: Client dropped joinery', -5]]);
  assert.deepEqual(g.unexplained, { 5: 0, 8: 0, 14: 0, end: 0 });
  assert.equal(dl.explainSteps(s, loadCauses(), 14).steps[0].type, 'omission');
  s.undo(); assert.equal(s.byId.has(13), true); assert.equal(s.log.length, 0); assert.equal(s.byId.get(14).agr.f, D('2026-12-20'));
  assert.equal(dl.omit(s, 13, { reason: 'x', approvedBy: 'y', relink: false }), null);
  assert.equal(s.links.some((l) => l.from === 12 && l.to === 14), false);
});

test('a task pushed by a predecessor without an agreed date never shows own delay', () => {
  const s = demo();
  assert.equal(dl.setAgreed(s, 14, dl.fin(s, 14)), null);
  s.setCell(12, 'dur', '24');
  const r = dl.row(s, 14);
  assert.deepEqual([r.own, r.inherited, r.v], [0, 4, 4]);
  assert.equal(r.source, 13, 'the latest-finishing predecessor is named');
});

test('agreeing a baseline can agree the waiting inclusions with it', () => {
  const s = baselined(), id = insertJoineryFollower(s);
  assert.deepEqual(dl.pendingInclusions(s), [{ id, name: 'New task' }]);
  assert.equal(dl.agreeBaseline(s, { includePending: true }), 'Agreeing inclusions needs a reason and who approved it');
  assert.equal(dl.agreeBaseline(s, { includePending: true, reason: 'Scope signed off', approvedBy: 'SG' }), null);
  assert.equal(s.byId.get(id).inc, undefined);
  assert.equal(s.log.filter((e) => e.type === 'inclusion').length, 1);
  assert.deepEqual(parts(s, 14), [0, 0, 0, 4, 4]);
  assert.equal(s.agreedOrig.end, D('2027-01-05'), 'the first baseline froze the original');
});

test('the waterfall lists every agreed change with its reason', () => {
  const s = baselined();
  assert.equal(dl.setAgreed(s, 14, D('2026-12-24'), { reason: 'Client asked', approvedBy: 'SG' }), null);
  const w = dl.explainSteps(s, loadCauses(), 14);
  assert.deepEqual(w.steps.slice(0, 1).map((x) => [x.type, x.days, x.reason, x.approvedBy, x.source]), [['revision', 4, 'Client asked', 'SG', 'deadline']]);
  assert.equal(w.agreed, D('2026-12-24'));
  assert.deepEqual(w.steps.slice(1).map((x) => [x.type, x.days]), [['residual', -4]], 'the plan still finishes on the old date, four days early');
});

test('analysis data for a large plan with a long log builds quickly', () => {
  const s = demo();
  const tasks = [], links = [];
  for (let i = 0; i < 300; i++) { tasks.push({ id: 100 + i, name: `T${i}`, level: 0, start: D('2026-11-02'), dur: 3 + (i % 5), progress: 0, owner: `O${i % 9}`, email: '', noRem: false, ms: i % 30 === 29, scheduling: 'auto' }); if (i) links.push({ id: `x${i}`, from: 99 + i, to: 100 + i, type: 'FS', lag: 0 }); }
  const big = new Store({ workbook: { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Big', data: { calendar: s.calendar, tasks, links, collapsed: [], nextId: 500, nextLink: 400 }, rem: {} }] }, templates: [], preferences: {}, history: {} });
  dl.agreeBaseline(big);
  for (let i = 0; i < 40; i++) {
    const id = 110 + i * 7, pre = dl.snapshotBefore(big);
    big.setCell(id, 'dur', String(big.byId.get(id).dur + 1));
    if (big.byId.get(id).ms) continue;
    dl.record(big, id, pre, { type: 'delay', cause: C('Unknown') });
  }
  const t0 = performance.now(); // test files run in parallel, so allow generous headroom: this guards against quadratic work, not speed
  const g = dl.impactGrid(big, loadCauses()); dl.explainSteps(big, loadCauses(), 'end'); dl.milestoneTable(big, loadCauses()); dl.ownerTable(big);
  for (const t of big.tasks) dl.row(big, t.id);
  assert.ok(performance.now() - t0 < 3000, `took ${Math.round(performance.now() - t0)}ms`);
  assert.ok(g.rows.length >= 30);
  for (const c of g.cols) assert.equal(c.total, g.rows.reduce((n, r) => n + (r.effects[c.id] || 0), 0) + g.unexplained[c.id]);
});

test('templates carry no agreed data, including templates saved earlier', () => {
  const s = baselined(); insertJoineryFollower(s);
  const { tpl } = s.saveTemplate('Fit-out');
  assert.ok(tpl.tasks.every((t) => !t.agr && !t.inc) && !tpl.log && !tpl.baselined);
  const old = { ...tpl, tasks: tpl.tasks.map((t) => ({ ...t, agr: { s: 1, f: 2, o: 2 }, inc: true })) };
  const sheet = s.instantiate(old, D('2027-03-01'), 'From template');
  assert.ok(s.tasks.every((t) => !t.agr && !t.inc)); assert.equal(s.baselined, false); void sheet;
});

test('an Agreed baseline is one operation: nothing is agreed when the version cannot be saved, and undo cannot split it', () => {
  const s = demo();
  s.stale = true; // another tab changed the project: versions cannot be saved
  const failed = s.snapshotAgreed(() => dl.agreeBaseline(s), { name: 'Baseline', type: 'baseline' });
  assert.ok(failed.error);
  assert.equal(dl.hasAgreed(s), false);
  assert.equal(s.versions().length, 0);
  assert.equal(s.undoStack.length, 0);
  s.stale = false;
  const bad = s.snapshotAgreed(() => 'Agreeing needs a reason', { name: 'Baseline', type: 'baseline' });
  assert.equal(bad.error, 'Agreeing needs a reason');
  assert.equal(s.versions().length, 0);
  const ok = s.snapshotAgreed(() => dl.agreeBaseline(s), { name: 'Baseline', type: 'baseline' });
  assert.ok(ok.version);
  assert.equal(ok.version.type, 'baseline');
  assert.equal(dl.hasAgreed(s), true);
  assert.equal(s.undoStack.length, 0, 'the undo history starts at the baseline');
  s.undo();
  assert.equal(dl.hasAgreed(s), true, 'undo does not remove the dates the saved baseline holds');
});

test('typing a predecessor with a lag is a link edit the delay hook sees', () => {
  const s = demo();
  dl.agreeBaseline(s);
  const seen = [];
  s.hook = { before: () => dl.snapshotBefore(s), after: (e) => seen.push(e.kind) };
  assert.equal(s.setCell(13, 'pred', '13+3'), null);
  assert.deepEqual(seen, ['link']);
});

test('owners are charged revisions only at the tasks where they were recorded, not where a revision merely pushed later tasks', () => {
  const s = story(), rows = dl.ownerTable(s), by = (o) => rows.find((r) => r.owner === o);
  assert.equal(by('Sana').revisions, 3, 'the revision was recorded at Joinery & finishes');
  assert.equal(by('Omar')?.revisions ?? 0, 0, 'Snag list was only pushed by it');
  assert.ok(rows.every((r) => !(r.owner === 'Unassigned' && r.revisions)), 'Handover has no revision of its own');
  assert.equal(rows.reduce((n, r) => n + r.revisions, 0), 3, 'a revision is counted once');
});

test('milestone causes explain only the Delay column, and the rest is Other / unexplained', () => {
  const s = story(), t = dl.milestoneTable(s, loadCauses()), h = t.find((r) => r.name === 'Handover');
  assert.ok(h.rev > 0 && h.delay > 0);
  assert.equal(h.causes.reduce((n, c) => n + c.days, 0), h.delay, 'causes add up to the Delay');
  assert.ok(h.causes.every((c) => c.name !== 'Revision'));
  const u = demo(); dl.agreeBaseline(u); u.tx(() => { u.byId.get(12).dur += 3; });
  const e = dl.milestoneTable(u, loadCauses()).find((r) => r.id === 'end');
  assert.deepEqual(e.causes, [{ name: 'Other / unexplained', days: 3 }]);
});

test('grid rows and steps name the task of a revision, inclusion and omission', () => {
  const s = story(), g = dl.impactGrid(s, loadCauses());
  assert.ok(g.rows.some((r) => r.label === 'Revision · Joinery & finishes: Client added level 3'));
});

test('the Explain waterfall has a Current agreed subtotal after the agreed changes and before the delays', async () => {
  const { toWaterfall } = await import('../src/project_management_tool/web/js/delayanalysis.js');
  const s = story(), id = dl.milestoneTable(s, loadCauses()).find((r) => r.name === 'Handover').id;
  const w = toWaterfall(dl.explainSteps(s, loadCauses(), id));
  assert.deepEqual(w.steps.map((x) => x.type), ['revision', 'subtotal', 'delay']);
  const sub = w.steps[1];
  assert.equal(sub.title, 'Current agreed'); assert.equal(sub.reason, 'The agreed date after approved changes');
  assert.equal(fd(sub.to), '2026-12-23'); assert.equal(sub.from, w.steps[0].to); assert.equal(w.steps[2].from, sub.to);
  const none = toWaterfall(dl.explainSteps(demo(), loadCauses(), 'end') || { name: 'x', orig: 1, exp: 1, total: 0, agreed: 1, steps: [] });
  assert.equal(none.steps.some((x) => x.type === 'subtotal'), false, 'no agreed changes: no subtotal');
});

test('key milestones are saved with the project, survive the file round trip and do not leak between projects', () => {
  const s = story();
  assert.equal(s.setKeyMilestone(14, true), true); assert.equal(s.setKeyMilestone(5, true), true);
  assert.deepEqual([...s.keyMilestones()].sort((a, b) => a - b), [5, 14]);
  s.undo(); assert.deepEqual([...s.keyMilestones()].sort((a, b) => a - b), [5, 14], 'a view choice, not an edit');
  const doc = JSON.parse(encodeProjectFile(s));
  assert.deepEqual(doc.project.data.stars.sort((a, b) => a - b), [5, 14]);
  assert.ok((doc.project.versions || []).every((v) => !('stars' in v.plan)));
  const t = demo(); openProjectFile(t, JSON.stringify(doc));
  assert.deepEqual([...t.keyMilestones()].sort((a, b) => a - b), [5, 14]);
  assert.equal(demo().keyMilestones().size, 0, 'another project starts with none');
  const bad = JSON.parse(JSON.stringify(doc)); bad.project.data.stars = [999];
  assert.throws(() => parseProjectFile(JSON.stringify(bad)), /key milestones/);
  bad.project.data.stars = [5]; bad.version = 5;
  assert.throws(() => parseProjectFile(JSON.stringify(bad)), /version 6/);
  s.setKeyMilestone(14, false); assert.deepEqual([...s.keyMilestones()], [5]);
});

test('any recorded delay can be classified later, including an earlier one at a task with two; each is one undo step', () => {
  const s = demo(); dl.agreeBaseline(s);
  const rec = (days, cause) => { const pre = dl.snapshotBefore(s); s.setCell(12, 'dur', String(s.byId.get(12).dur + days)); assert.equal(dl.record(s, 12, pre, { type: 'delay', cause }), null); };
  rec(2, null); rec(1, null);
  const both = dl.delaysOf(s, 12);
  assert.equal(both.length, 2);
  assert.deepEqual(dl.unclassifiedDelays(s).map((e) => e.days), [2, 1]);
  const owner = () => dl.ownerTable(s).find((r) => r.owner === 'Sana');
  assert.equal(owner().unclassified, 3);
  const depth = s.undoStack.length;
  assert.equal(dl.reclassify(s, both[0].id, { cause: C('Supplier / subcontractor'), party: 'Acme' }), null);
  assert.equal(s.undoStack.length, depth + 1, 'one undo step');
  assert.deepEqual(dl.unclassifiedDelays(s).map((e) => e.days), [1], 'the earlier entry is classified, the later is untouched');
  assert.equal(dl.lastDelay(s, 12).cause, null);
  assert.equal(owner().unclassified, 1, 'the owner table Unclassified drops');
  const cause = dl.milestoneTable(s, loadCauses()).find((r) => r.id === 'end').causes.map((c) => c.name);
  assert.ok(cause.includes('Supplier / subcontractor') && cause.includes('Unclassified'));
  s.undo();
  assert.equal(dl.unclassifiedDelays(s).length, 2); assert.equal(owner().unclassified, 3);
  s.redo();
  assert.equal(dl.unclassifiedDelays(s).length, 1); assert.equal(dl.delaysOf(s, 12)[0].party, 'Acme');
  assert.equal(dl.reclassify(s, 99999, { cause: null }), 'That entry no longer exists');
});

test('recoveries are not unclassified delays, and a baseline saves while delays are still unclassified', () => {
  const s = demo(); dl.agreeBaseline(s);
  const pre = dl.snapshotBefore(s); s.setCell(12, 'dur', String(s.byId.get(12).dur + 2));
  assert.equal(dl.record(s, 12, pre, { type: 'delay', cause: null }), null);
  assert.equal(dl.unclassifiedDelays(s).length, 1);
  const r = s.snapshotAgreed(() => dl.agreeBaseline(s), { name: 'Baseline 2', type: 'baseline' });
  assert.ok(r.version && !r.error, 'unclassified delays never block an Agreed baseline');
  assert.equal(dl.unclassifiedDelays(s).length, 1);
});

// A delay recorded after a lag edit: Joinery & finishes (13) -> Handover (14) gets +3 lag.
function lagStory(cause) {
  const s = demo(); dl.agreeBaseline(s);
  const pre = dl.snapshotBefore(s), before = dl.fin(s, 14);
  assert.equal(s.setCell(14, 'pred', '14+3'), null);
  assert.equal(dl.fin(s, 14) - before, 3, 'the lag moves Handover');
  assert.equal(dl.record(s, 14, pre, { type: 'delay', op: 'start', cause }, { link: true }), null);
  return s;
}

test('a delay recorded from a lag edit is Own at that task, keeps its cause and reaches the milestone table, grid and Explain (F2)', () => {
  const s = lagStory(C('Client / approver')), r = dl.row(s, 14);
  assert.equal(r.v, 3); assert.equal(r.own, 3, 'the task where the lag was typed owns the delay'); assert.equal(r.inherited, 0);
  const causes = loadCauses(), m = dl.milestoneTable(s, causes), h = m.find((x) => x.id === 14), end = m.find((x) => x.id === 'end');
  for (const t of [h, end]) {
    assert.deepEqual(t.causes, [{ name: 'Client / approver', days: 3 }], `${t.name}: the cause explains all of it, nothing unexplained`);
    assert.equal(t.status, 'Late');
  }
  const grid = dl.impactGrid(s, causes), g = grid.rows.find((x) => x.entry.type === 'delay');
  assert.equal(g.effects[14], 3); assert.equal(g.effects.end, 3);
  assert.ok(grid.rows.every((x) => !/unexplained/i.test(x.label) || Object.values(x.effects).every((n) => !n)), 'no unexplained row left');
  const x = dl.explainSteps(s, causes, 'end'), steps = JSON.stringify(x);
  assert.ok(/Client \/ approver/.test(steps) && !/Other \/ unexplained/.test(steps), 'Explain names the cause');
  assert.equal(dl.originOf(s, 14), 14);
});

test('a lag-edit delay survives undo, redo, reclassify and a file round trip', () => {
  const s = lagStory(null), n = s.log.length;
  assert.equal(s.log.at(-1).via, 'link'); assert.ok(s.log.at(-1).eff[14] === 3);
  assert.equal(dl.reclassify(s, s.log.at(-1).id, { cause: C('Supplier / subcontractor') }), null);
  assert.equal(dl.milestoneTable(s, loadCauses()).find((x) => x.id === 'end').causes[0].name, 'Supplier / subcontractor');
  const back = new Store(JSON.parse(JSON.stringify({ workbook: { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'x', data: JSON.parse(s.serialize()) }] }, templates: [], preferences: {}, history: {} })));
  assert.equal(back.log.at(-1).via, 'link'); assert.deepEqual(back.log.at(-1).eff, s.log.at(-1).eff);
  assert.equal(dl.row(back, 14).own, 3);
  const file = parseProjectFile(encodeProjectFile(s)); assert.ok(file);
  assert.equal(s.log.length, n, 'reclassifying adds no entry');
});

// F1: recording a start delay on a task that was already manual keeps it manual.
function manualStory() {
  const s = demo();
  s.tx(() => { const t = s.byId.get(13); t.scheduling = 'manual'; t.start = D('2026-12-14'); });
  dl.agreeBaseline(s);
  return s;
}
test('recording a delay on an already manual task keeps it manual and does not reschedule it (F1)', () => {
  const s = manualStory(), id = 13, start = s.info.get(id).start, fin0 = dl.fin(s, id);
  const pre = dl.snapshotBefore(s);
  assert.equal(s.setCell(id, 'start', fd(start + 7)), null);
  assert.equal(s.byId.get(id).scheduling, 'manual');
  const moved = dl.fin(s, id);
  assert.ok(dl.row(s, id).inherited === 0, 'a manual task ignores its connections, so its own move is never inherited');
  assert.equal(dl.record(s, id, pre, { type: 'delay', op: 'start', cause: null }, { anchor: true }), null);
  assert.equal(s.byId.get(id).scheduling, 'manual', 'still manual after Record');
  assert.equal(dl.fin(s, id), moved, 'the dates are exactly what was typed');
  assert.equal(s.info.get(id).start, start + 7); assert.equal(dl.fin(s, id) - fin0, 7);
  assert.equal(dl.row(s, id).own, 7);
});
test('a typed start on an automatic task still becomes a date anchor', () => {
  const s = demo(); dl.agreeBaseline(s);
  const id = 12, pre = dl.snapshotBefore(s), start = s.info.get(id).start;
  assert.equal(s.setCell(id, 'start', fd(start + 4)), null);
  assert.equal(s.byId.get(id).scheduling, 'manual', 'the edit makes it manual first');
  assert.equal(dl.record(s, id, pre, { type: 'delay', op: 'start', cause: null }, { anchor: true }), null);
  assert.equal(s.byId.get(id).scheduling, 'anchor');
});

// ---- property-style: whatever recorded edits are made, nothing is "unexplained" ----
function chainPlan() {
  const T = (id, name, o = {}) => ({ id, name, level: 0, start: D('2026-11-02'), dur: 4, progress: 0, owner: '', email: '', noRem: false, ms: false, scheduling: 'auto', ...o });
  const tasks = [T(1, 'A1'), T(2, 'A2'), T(3, 'A3', { dur: 3 }), T(4, 'Done', { ms: true, dur: 0 }), T(5, 'B1', { dur: 6 }), T(6, 'B2', { dur: 2 }), T(7, 'Gate', { ms: true, dur: 0 })];
  const L = (id, from, to, lag = 0) => ({ id, from, to, type: 'FS', lag });
  const links = [L('l1', 1, 2), L('l2', 2, 3), L('l3', 3, 4), L('l4', 5, 6), L('l5', 6, 7), L('l6', 2, 7)];
  const data = { calendar: { workdays: [1, 2, 3, 4, 5], holidays: [] }, tasks, links, collapsed: [], nextId: 8, nextLink: 7 };
  return new Store({ workbook: { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'chain', data }] }, templates: [], preferences: {}, history: {} });
}
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
// What the record popover does after an edit: later than agreed -> record (delay or revision); earlier -> recovery.
function afterEdit(s, id, kind, pre, roll) {
  let target = id;
  if (kind === 'link') { target = null; for (const t of dl.leaves(s)) if (t.agr && pre.fins.has(t.id) && dl.fin(s, t.id) > pre.fins.get(t.id) && dl.fin(s, t.id) > t.agr.f) { target = t.id; break; } if (target == null) { dl.recover(s, id, pre); return 'none'; } }
  const t = s.byId.get(target), a = t?.agr; if (!a) return 'none';
  const old = pre.fins.get(target), now = dl.fin(s, target);
  if (!(now > a.f) || !(now > old)) { return dl.recover(s, target, pre) ? 'recovery' : 'none'; }
  const op = kind === 'start' || kind === 'link' || t.ms ? 'start' : 'finish';
  const entry = roll() < 0.25 ? { type: 'revision', reason: 'r', approvedBy: 'p', op } : { type: 'delay', cause: roll() < 0.8 ? C('Unknown') : null, op };
  assert.equal(dl.record(s, target, pre, entry, { anchor: op === 'start' && kind !== 'link', link: kind === 'link' }), null);
  return entry.type;
}
const unexplained = (s) => dl.milestoneTable(s, loadCauses()).filter((m) => m.causes.some((c) => c.name === 'Other / unexplained')).map((m) => `${m.name}: ${JSON.stringify(m.causes)}`);

// One random edit; returns a description, or null when the edit was refused or did not apply.
function randomEdit(s, roll, step) {
  const pre = dl.snapshotBefore(s), r = roll(), ids = [1, 2, 3, 5, 6], id = ids[Math.floor(roll() * ids.length)];
  const num = (n) => Math.floor(roll() * n);
  if (r < 0.40) { const d = num(7) - 2; if (s.setCell(id, 'dur', String(Math.max(1, s.byId.get(id).dur + d)))) return null; return { what: `dur ${id} ${d}`, id, kind: 'dur', pre }; }
  if (r < 0.55) { const d = num(6) - 2; if (s.setCell(id, 'start', fd(s.info.get(id).start + d))) return null; return { what: `start ${id} ${d}`, id, kind: 'start', pre }; }
  if (r < 0.70) {
    const to = [2, 3, 6][num(3)], from = { 2: 1, 3: 2, 6: 5 }[to], lag = num(5) - 1;
    if (s.setCell(to, 'pred', `${from + 1}${lag ? `+${lag}` : ''}`)) return null;
    return { what: `lag ${from}->${to} ${lag}`, id: to, kind: 'link', pre };
  }
  if (r < 0.80) { const d = num(5) - 1; if (s.setCell(4, 'start', fd(s.info.get(4).start + d))) return null; return { what: `gate ${d}`, id: 4, kind: 'start', pre }; }
  if (r < 0.92) { const sc = s.snapshotAgreed(() => dl.agreeBaseline(s, { replace: true, reason: 'x', approvedBy: 'y' }), { name: `b${step}`, type: 'baseline' }); assert.ok(!sc.error, sc.error); return { what: 'baseline' }; }
  return null; // an agreed deadline later than the plan only makes the task early against it, which is not a delay: not part of this property
}
test('no recorded edit sequence leaves anything unexplained at any milestone (random sequences, seeded)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const roll = rng(seed), s = chainPlan(), trace = []; dl.agreeBaseline(s);
    for (let step = 0; step < 12; step++) {
      const e = randomEdit(s, roll, step); if (!e) continue;
      trace.push(e.pre ? `${e.what} → ${afterEdit(s, e.id, e.kind, e.pre, roll)}` : e.what);
      assert.deepEqual(unexplained(s), [], `seed ${seed}, after ${trace.join(' | ')}\n${dl.changeEffects(s).list.map((x) => `${x.entry.id} ${x.entry.type} t${x.entry.taskId} d${x.entry.days} ${x.entry.source || ''} ${JSON.stringify(x.entry.eff || '')} fx=${JSON.stringify(x.effects)}`).join('\n')}\nmt=${JSON.stringify(dl.milestoneTable(s, loadCauses()).map((m) => [m.id, m.orig, m.cur, m.exp, m.delay, m.rev]))}`);
    }
  }
});

test('a shortened task, an early finish and an earlier predecessor are attributed as recoveries, not unexplained (F5)', () => {
  const s = chainPlan(); dl.agreeBaseline(s);
  const edit = (id, col, v, kind = 'dur') => { const pre = dl.snapshotBefore(s); assert.equal(s.setCell(id, col, v), null); return afterEdit(s, id, kind, pre, () => 0.5); };
  assert.equal(edit(2, 'dur', String(s.byId.get(2).dur + 1)), 'delay');
  assert.equal(edit(2, 'dur', String(s.byId.get(2).dur + 3)), 'delay');
  const before = dl.milestoneTable(s, loadCauses()).find((m) => m.id === 4);
  assert.equal(before.delay, 4); assert.deepEqual(unexplained(s), []);
  assert.equal(edit(2, 'dur', String(s.byId.get(2).dur - 2)), 'recovery');
  const m = dl.milestoneTable(s, loadCauses()).find((x) => x.id === 4);
  assert.equal(m.delay, 2); assert.deepEqual(unexplained(s), []);
  assert.deepEqual(m.causes.map((c) => c.name).sort(), ['Recovered', 'Unknown'].sort(), `Main causes include the recovery: ${JSON.stringify(m.causes)}`);
  const rec = dl.explainSteps(s, loadCauses(), 4).steps.find((x) => /Recovered/.test(x.title));
  assert.ok(rec && rec.days === -2 && rec.type === 'delay', 'Explain has a Recovered step of −2');
  assert.ok(dl.impactGrid(s, loadCauses()).rows.some((r) => /Recovery · A2/.test(r.label) && r.effects[4] === -2), 'the Impact grid has a Recovery row');
  assert.equal(dl.row(s, 2).own, 2); assert.deepEqual(dl.unclassifiedDelays(s), [], 'a recovery is never an unclassified delay');
  assert.equal(dl.lastDelay(s, 2).days, 3, 'the Cause cell still shows the last real delay');
  assert.equal(dl.delayLog(s, loadCauses()).at(-1).typeLabel, 'Recovery');
  // finishing earlier than agreed, and an earlier predecessor
  assert.equal(edit(2, 'dur', String(s.byId.get(2).dur - 3)), 'recovery');
  assert.deepEqual(unexplained(s), []); assert.ok(dl.milestoneTable(s, loadCauses()).find((x) => x.id === 4).delay < 0);
  assert.equal(edit(1, 'dur', String(s.byId.get(1).dur - 1)), 'recovery');
  assert.deepEqual(unexplained(s), []);
  s.undo(); assert.deepEqual(unexplained(s), []);
});

// ---- F6: calendar and scheduling-mode changes tell the hook, and the move can be recorded as that task's own delay ----
test('a holiday or a Manual → Auto change that pushes an agreed task reaches the hook and is recorded as own, explained delay (F6)', () => {
  const s = chainPlan(), calls = []; dl.agreeBaseline(s);
  s.hook = { before: () => dl.snapshotBefore(s), after: (e) => calls.push(e) };
  let pre = dl.snapshotBefore(s);
  assert.equal(s.setCalendar({ workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-10', name: 'Holiday' }] }), null);
  assert.deepEqual(calls.map((c) => c.kind), ['calendar'], 'the calendar change tells the hook');
  assert.ok(dl.fin(s, 2) > pre.fins.get(2), 'the holiday pushed A2');
  assert.equal(dl.record(s, 2, calls[0].pre, { type: 'delay', cause: C('Unknown'), op: 'start' }, { link: true }), null);
  assert.equal(dl.row(s, 2).own, 1); assert.equal(dl.row(s, 2).inherited, 0);
  assert.deepEqual(unexplained(s), []);
  // A task that was manual (starting before its predecessor ends) and is switched to Auto is pushed by its own mode change.
  const m = chainPlan(); m.byId.get(3).scheduling = 'manual'; m.byId.get(3).start = m.byId.get(2).start; m.settle(); dl.agreeBaseline(m);
  const mc = []; m.hook = { before: () => dl.snapshotBefore(m), after: (e) => mc.push(e) };
  assert.equal(m.setScheduling(3, 'auto'), null);
  assert.deepEqual(mc.map((c) => [c.kind, c.id]), [['mode', 3]]);
  assert.ok(dl.fin(m, 3) > m.byId.get(3).agr.f, 'the mode change pushed A3 past its agreed date');
  assert.equal(dl.record(m, 3, mc[0].pre, { type: 'delay', cause: C('Unknown'), op: 'start' }, { link: true }), null);
  assert.ok(dl.row(m, 3).own > 0 && dl.row(m, 3).inherited === 0, `own, not inherited: ${JSON.stringify(dl.row(m, 3))}`);
  assert.deepEqual(unexplained(m), []);
});
