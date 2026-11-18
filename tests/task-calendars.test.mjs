import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, D, fmtISO } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import { encodeProjectFile, openProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';
import { spreadsheetCalendars, mapSheet } from '../src/project_management_tool/web/js/import.js';
import { compareViews, changeLog, changeCategory } from '../src/project_management_tool/web/js/versiondiff.js';
import { finishWaterfall } from '../src/project_management_tool/web/js/finishwaterfall.js';

const globalCalendar = { workdays: [1, 2, 3, 4, 5], holidays: [] };
const custom = { workdays: [0, 1, 2, 3, 4], holidays: [{ date: '2026-11-12', name: 'Crew closure' }] };
const task = (id, start = '2026-11-06', dur = 2, extra = {}) => ({ id, name: `Task ${id}`, level: 0, start: D(start), dur, progress: 0, owner: '', email: '', ms: false, ...extra });
beforeEach(() => {
  const memory = new Map(); globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
  appState.restore({});
});
function fixture(tasks, links = [], auto = false) {
  const s = new Store(); s.auto = auto; s.load({ calendar: globalCalendar, tasks, links, collapsed: [], nextId: 100, nextLink: 10 }); return s;
}
// Independent calendar oracle deliberately uses only date iteration.
function oracle(calendar) {
  const isWork = (day) => calendar.workdays.includes(new Date(day * 86400000).getUTCDay()) && !calendar.holidays.some((h) => D(h.date) === day);
  const next = (day) => { while (!isWork(day)) day++; return day; };
  const finish = (day, duration) => { while (duration) { if (isWork(day)) duration--; day++; } return day; };
  const shift = (day, lag) => { day = next(day); const dir = lag < 0 ? -1 : 1; while (lag) { day += dir; if (isWork(day)) lag -= dir; } return day; };
  const count = (a, b) => { if (b < a) return -count(b, a); let n = 0; for (let d = a; d < b; d++) if (isWork(d)) n++; return n; };
  return { isWork, next, finish, shift, count };
}
function meets(a, b, source, dest, link, oa, ob) {
  const endpoint = link.type[0] === 'F' ? oa.finish(a, source.dur) : a;
  const bound = link.type[1] === 'S' ? ob.shift(endpoint, link.lag) : ob.shift(endpoint - 1, link.lag) + 1;
  return (link.type[1] === 'S' ? b : ob.finish(b, dest.dur)) >= bound;
}

test('task override replaces global holidays, previews without mutation, resets and undoes atomically', () => {
  const s = fixture([task(1), task(2)]), before = s.snap();
  const preview = s.previewCalendar(custom, 1); assert.equal(s.snap(), before); assert.equal(s.undoStack.length, 0);
  assert.equal(fmtISO(preview.view.byId.get(1).start), '2026-11-08');
  assert.equal(s.setCalendar(custom, 1), null); const applied = s.snap();
  assert.equal(s.duration(1), 2); assert.equal(fmtISO(s.info.get(1).end - 1), '2026-11-09');
  assert.equal(fmtISO(s.info.get(2).end - 1), '2026-11-09');
  s.undo(); assert.equal(s.snap(), before); s.redo(); assert.equal(s.snap(), applied);
  const changedGlobal = { ...globalCalendar, holidays: [{ date: '2026-11-09', name: 'Global holiday' }] };
  assert.equal(s.setCalendar(changedGlobal), null); assert.deepEqual(s.byId.get(1).calendar, custom);
  assert.equal(fmtISO(s.info.get(1).end - 1), '2026-11-09'); assert.equal(fmtISO(s.info.get(2).end - 1), '2026-11-10');
  const resetBefore = s.snap(); assert.equal(s.setCalendar(null, 1), null);
  assert.equal(s.byId.get(1).calendar, undefined); assert.equal(fmtISO(s.byId.get(1).start), '2026-11-10');
  s.undo(); assert.equal(s.snap(), resetBefore);
});

test('the agreed Friday + two receiver working days example starts on Tuesday', () => {
  const s = fixture([task(1, '2026-11-06', 1), task(2, '2026-11-02', 2, { calendar: custom })], [{ id: 'l1', from: 1, to: 2, type: 'FS', lag: 2 }], true);
  assert.equal(fmtISO(s.byId.get(2).start), '2026-11-10'); assert.equal(s.links[0].violated, false);
});

test('mixed calendars satisfy earliest forward bounds, total and free slack against exhaustive schedules', () => {
  const configs = [globalCalendar, custom, { workdays: [0, 2, 4, 6], holidays: [{ date: '2026-11-10', name: '' }] }];
  for (const type of ['FS', 'SS', 'FF', 'SF']) for (const lag of [-2, 0, 2]) for (const msA of [false, true]) for (const msB of [false, true]) for (let pair = 0; pair < configs.length; pair++) {
    const ca = configs[pair], cb = configs[(pair + 1) % configs.length], oa = oracle(ca), ob = oracle(cb);
    const a = task(1, '2026-11-06', msA ? 0 : 3, { ms: msA, calendar: ca }), b = task(2, '2026-10-20', msB ? 0 : 2, { ms: msB, calendar: cb });
    const link = { id: 'l1', from: 1, to: 2, type, lag }, s = fixture([a, b], [link], true);
    const A = s.byId.get(1), B = s.byId.get(2);
    let earliest = ob.next(D('2026-10-01')); while (!meets(A.start, earliest, A, B, link, oa, ob)) earliest = ob.next(earliest + 1);
    assert.equal(B.start, earliest, `${type}${lag} ${pair} ${msA}/${msB}`);
    assert.equal(s.links[0].violated, false);
    const end = s.project.end, latest = [A.start, B.start];
    const choices = (t, o) => { const out = []; for (let d = t.start; d <= end; d++) if (o.isWork(d) && o.finish(d, t.dur) <= end) out.push(d); return out; };
    for (const x of choices(A, oa)) for (const y of choices(B, ob)) if (meets(x, y, A, B, link, oa, ob)) { latest[0] = Math.max(latest[0], x); latest[1] = Math.max(latest[1], y); }
    assert.equal(s.info.get(1).float, oa.count(A.start, latest[0])); assert.equal(s.info.get(2).float, ob.count(B.start, latest[1]));
    let free = A.start;
    // A nonterminal's free slack is constrained by the successor, even when it can finish after project completion.
    for (let x = A.start; x <= end + 35; x++) if (oa.isWork(x) && meets(x, B.start, A, B, link, oa, ob)) free = x;
    assert.equal(s.info.get(1).freeFloat, oa.count(A.start, free));
  }
});

test('date editing, drag resize and group moves resolve the calendar of each leaf', () => {
  const s = fixture([task(1, '2026-11-06', 1), task(2, '2026-11-08', 2, { level: 1, calendar: custom }), task(3, '2026-11-06', 2, { level: 1 })]);
  assert.equal(s.setCell(2, 'end', '2026-11-11'), null); assert.equal(s.byId.get(2).dur, 4);
  s.beginDrag(); s.dragApply(() => s.dragResize(2, 'r', 2)); s.endDrag(); assert.equal(s.byId.get(2).dur, 4, 'closure Thursday and off Friday add no duration');
  s.beginDrag(); s.dragApply(() => s.dragMove(1, 1)); s.endDrag();
  assert.equal(fmtISO(s.byId.get(2).start), '2026-11-09'); assert.equal(fmtISO(s.byId.get(3).start), '2026-11-09');
  assert.match(s.setCalendar(custom, 1), /Summary/); assert.match(s.setCalendar(custom, 500), /no longer/);
  const before = s.snap(); assert.equal(typeof s.setCalendar({ workdays: [], holidays: [] }, 2), 'string'); assert.equal(s.snap(), before);
});

test('calendars persist through storage, versions, templates, project copies and format 5 files', () => {
  const s = fixture([task(1), task(2, '2026-11-08', 0, { ms: true })]); s.setCalendar(custom, 1); s.setCalendar(custom, 2); s.save();
  const shape = s.snap(), restored = new Store(structuredClone(s.savedState())); assert.equal(restored.snap(), shape);
  const v = s.snapshotVersion({ name: 'Crew baseline' }).version;
  assert.deepEqual(s.versionView(v.id).byId.get(1).calendar, custom);
  s.setCalendar(null, 1); assert.equal(s.restoreVersion(v.id), null); assert.deepEqual(s.byId.get(1).calendar, custom);
  const copy = s.duplicateSheet(s.wb.active); assert.deepEqual(s.byId.get(1).calendar, custom);
  const template = s.saveTemplate('Crew template').tpl; s.instantiate(template, D('2026-12-01')); assert.deepEqual(s.byId.get(1).calendar, custom);
  const contents = encodeProjectFile(restored); assert.equal(JSON.parse(contents).version, 5);
  const opened = new Store(); openProjectFile(opened, contents); assert.equal(opened.snap(), restored.snap());
  s.switchSheet(copy); s.setCalendar(null, 1); s.setCalendar(null, 2);
  const withVersion = JSON.parse(encodeProjectFile(s)); assert.equal(withVersion.version, 3);
  const old = JSON.parse(contents); old.version = 4; assert.throws(() => openProjectFile(opened, JSON.stringify(old)), /version 5/);
  const bad = JSON.parse(contents); bad.project.data.tasks[0].calendar.workdays = []; assert.throws(() => openProjectFile(opened, JSON.stringify(bad)), /calendar/);
  const versionOnly = fixture([task(1)]); versionOnly.setCalendar(custom, 1); versionOnly.snapshotVersion({ name: 'Override' }); versionOnly.setCalendar(null, 1);
  const file = encodeProjectFile(versionOnly); assert.equal(JSON.parse(file).version, 5); const target = new Store(); openProjectFile(target, file); assert.deepEqual(target.versionView('v1').byId.get(1).calendar, custom);
  const olderVersionFile = JSON.parse(file); olderVersionFile.version = 4;
  assert.throws(() => openProjectFile(new Store(), JSON.stringify(olderVersionFile)), /version 1: task calendars require file version 5/);
  target.previewVersion('v1'); const frozen = target.snap(); assert.match(target.setCalendar(globalCalendar, 1), /saved version/i); assert.equal(target.snap(), frozen);
});

test('spreadsheet task calendar metadata guides duration inference and rejects orphan entries', () => {
  const rows = [['Plan calendars', 2], ['Task sheet', 'Workdays', 'Holiday date', 'Holiday name', 'Task #'], ['Tasks', '1,2,3,4,5', '', '', ''], ['Tasks', '0,1,2,3,4', '2026-11-12', 'Crew closure', 2]];
  const calendars = spreadsheetCalendars([{ rows }]);
  const sheet = { name: 'Tasks', outline: [], rows: [['#', 'Task', 'Start', 'End'], [2, 'Crew', '2026-11-08', '2026-11-10'], [3, 'Global', '2026-11-06', '2026-11-10']] };
  const mapped = mapSheet(sheet, calendars.get('Tasks')); assert(mapped.ok); assert.deepEqual(mapped.data.tasks[0].calendar, custom); assert.equal(mapped.data.tasks[0].dur, 3); assert.equal(mapped.data.tasks[1].dur, 3);
  sheet.rows[1][0] = 99; assert.equal(mapSheet(sheet, calendars.get('Tasks')).ok, false);
  rows[2][1] = ''; assert.throws(() => spreadsheetCalendars([{ rows }]), /Invalid calendar/);
});

test('spreadsheet task calendars reject ambiguous task numbers, including a duplicate summary', () => {
  const calendar = { ...globalCalendar, tasks: new Map([['2', custom]]) };
  const sheet = { name: 'Tasks', outline: [], rows: [['#', 'Task', 'Start', 'Days', 'Level'], [2, 'Crew', '2026-11-08', 2, 0], [2, 'Duplicate', '2026-11-08', 2, 0]] };
  let mapped = mapSheet(sheet, calendar);
  assert.equal(mapped.ok, false); assert(mapped.issues.some((issue) => issue.lv === 'error' && /unique task/.test(issue.msg)));
  sheet.rows.push([3, 'Child', '2026-11-08', 1, 1]);
  mapped = mapSheet(sheet, calendar); assert.equal(mapped.ok, false);
  sheet.rows[2][0] = 4; assert.equal(mapSheet(sheet, calendar).ok, true);
});

test('version comparison and finish replay attribute task calendar changes and global reset', () => {
  const s = fixture([task(1, '2026-11-06', 4), task(2, '2026-11-06', 2)], [{ id: 'l1', from: 1, to: 2, type: 'FS', lag: 0 }], true);
  s.save(); const A = s.view(s.wb.active); s.setCalendar({ workdays: [1, 3], holidays: [] }, 1); const B = s.view(s.wb.active);
  const diff = compareViews(A, B), entries = changeLog(diff).filter((r) => r.field === 'calendar');
  assert.equal(entries.length, 1); assert.equal(changeCategory(entries[0]), 'calendar'); assert.equal(diff.counts.calendar, 1);
  const replay = finishWaterfall(A, B); assert(replay.steps.some((step) => step.type === 'calendar' && step.title === 'Task working calendars'));
  assert.equal(replay.steps.filter((step) => step.type === 'residual').length, 0);
  s.setCalendar(null, 1); const C = s.view(s.wb.active), reset = finishWaterfall(B, C);
  assert.equal(reset.steps.filter((step) => step.type === 'residual').length, 0);
});
