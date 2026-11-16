import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, D, fmtISO } from '../src/project_management_tool/web/js/model.js';
import { WorkingCalendar, cleanCalendar, calendarError, dateDay } from '../src/project_management_tool/web/js/calendar.js';
import { encodeProjectFile, openProjectFile, parseProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';
import { mapSheet, spreadsheetCalendars } from '../src/project_management_tool/web/js/import.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';

beforeEach(() => {
  const memory = new Map(); globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
  appState.restore({});
});
const config = { workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-09', name: 'Office closure' }] };
const task = (id, start, dur = 3, extra = {}) => ({ id, name: `Task ${id}`, level: 0, start: D(start), dur, progress: 0, owner: '', email: '', ms: false, ...extra });
function fixture(tasks = [task(1, '2026-11-06'), task(2, '2026-11-06', 2)], links = [], auto = false) {
  const s = new Store(); s.auto = auto; s.load({ tasks, links, calendar: config, collapsed: [] }); return s;
}
const day = (s, id) => fmtISO(s.byId.get(id).start);
const finish = (s, id) => fmtISO(s.info.get(id).end - 1);

// Independent slow oracle: no rank, binary search or production calendar methods.
function naive(config) {
  const off = new Set(config.holidays.map((h) => D(h.date)));
  const isWork = (d) => config.workdays.includes(new Date(d * 86400000).getUTCDay()) && !off.has(d);
  const count = (a, b) => { if (b < a) return -count(b, a); let n = 0; for (let d = a; d < b; d++) if (isWork(d)) n++; return n; };
  const end = (start, n) => { if (!n) return start; let d = start; while (n) { if (isWork(d)) n--; d++; } return d; };
  const start = (end, n) => { let d = end; while (n) { d--; if (isWork(d)) n--; } return d; };
  return { isWork, count, end, start };
}

test('workday arithmetic agrees with an independent daily oracle over weeks, holidays and leap days', () => {
  for (const cfg of [config, { workdays: [0, 1, 2, 3, 4], holidays: [{ date: '2028-02-29', name: 'Leap day' }] }, { workdays: [3], holidays: [{ date: '2026-11-04', name: '' }, { date: '2026-11-11', name: '' }] }, cleanCalendar()]) {
    const cal = new WorkingCalendar(cfg), oracle = naive(cfg);
    for (const origin of [D('2026-11-01'), D('2028-02-25'), -10]) {
      for (let offset = 0; offset < 24; offset++) {
        const a = origin + offset;
        assert.equal(cal.isWork(a), oracle.isWork(a));
        assert.equal(cal.count(a, a + 25), oracle.count(a, a + 25));
        assert.equal(cal.count(a + 25, a), oracle.count(a + 25, a));
        for (const n of [0, 1, 2, 5, 18]) { assert.equal(cal.finish(a, n), oracle.end(a, n)); assert.equal(cal.start(a, n), oracle.start(a, n)); }
      }
    }
  }
});

test('calendar arithmetic handles very long durations without stepping through every date', () => {
  const work = new WorkingCalendar({ workdays: [1], holidays: [] }), n = 1000000;
  const start = D('2026-11-02'), end = work.finish(start, n);
  assert.equal(end, start + (n - 1) * 7 + 1); assert.equal(work.start(end, n), start); assert.equal(work.count(start, end), n);
});

test('invalid calendars and duplicate or impossible holiday dates are rejected', () => {
  for (const value of [{ workdays: [], holidays: [] }, { workdays: [7], holidays: [] }, { workdays: [1, 1], holidays: [] }, { workdays: [1], holidays: [{ date: '2026-02-30', name: '' }] }, { ...config, holidays: [config.holidays[0], config.holidays[0]] }]) assert.equal(typeof calendarError(value), 'string');
  assert.equal(dateDay('2028-02-29'), D('2028-02-29')); assert.equal(dateDay('2026-02-29'), null);
  assert.deepEqual(cleanCalendar(), { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] });
});

test('a three-workday task on Friday skips the weekend and Monday holiday', () => {
  const s = fixture(); assert.equal(finish(s, 1), '2026-11-11'); assert.equal(s.duration(1), 3);
  assert.equal(s.setCell(1, 'end', '2026-11-12'), null); assert.equal(s.byId.get(1).dur, 4);
  s.beginDrag(); s.dragApply(() => s.dragResize(1, 'r', 1)); s.endDrag();
  assert.equal(s.byId.get(1).dur, 5); assert.equal(finish(s, 1), '2026-11-13');
  s.beginDrag(); s.dragApply(() => s.dragMove(1, 1)); s.endDrag();
  assert.equal(day(s, 1), '2026-11-10'); assert.equal(s.byId.get(1).dur, 5);
});

test('all four dependency types with positive, zero and negative working-day lag satisfy independent bounds', () => {
  const oracle = naive(config), next = (day) => { while (!oracle.isWork(day)) day++; return day; };
  const shift = (day, n) => { let d = next(day); const dir = n < 0 ? -1 : 1; while (n) { d += dir; if (oracle.isWork(d)) n -= dir; } return d; };
  for (const type of ['FS', 'SS', 'FF', 'SF']) for (const lag of [-2, 0, 2]) for (const milestone of [false, true]) {
    const s = fixture([task(1, '2026-11-06', 3), task(2, '2026-11-01', milestone ? 0 : 2, { ms: milestone })], [{ id: 'l1', from: 1, to: 2, type, lag }], true);
    const p = s.byId.get(1), t = s.byId.get(2), source = type[0] === 'F' ? oracle.end(p.start, p.dur) : p.start;
    const bound = type[1] === 'S' ? shift(source, lag) : shift(source - 1, lag) + 1;
    const actual = type[1] === 'S' ? t.start : oracle.end(t.start, t.dur);
    assert(actual >= bound, `${type}${lag} milestone=${milestone}: ${actual} >= ${bound}`);
    assert.equal(s.links[0].violated, false); assert(oracle.isWork(t.start));
    // Earliest possible start that satisfies the independent endpoint constraint.
    let expected = next(D('2026-11-01'));
    while ((type[1] === 'S' ? expected : oracle.end(expected, t.dur)) < bound) expected = next(expected + 1);
    assert.equal(t.start, expected, `${type}${lag} milestone=${milestone}`);
  }
});

test('FS chains have zero float; unrelated earlier task has spare working days', () => {
  const s = fixture([task(1, '2026-11-06', 3), task(2, '2026-11-06', 2), task(3, '2026-11-06', 1)], [{ id: 'l1', from: 1, to: 2, type: 'FS', lag: 0 }], true);
  assert.equal(day(s, 2), '2026-11-12'); assert.equal(finish(s, 2), '2026-11-13');
  assert.equal(s.info.get(1).float, 0); assert.equal(s.info.get(2).float, 0); assert.equal(s.info.get(3).float, 4);
});

test('calendar preview is side-effect free; applying, undoing and redoing restores calendar and dates atomically', () => {
  const s = fixture([task(1, '2026-11-07', 3)], [], false);
  s.calendar = cleanCalendar(); s.work = new WorkingCalendar(); s.recalc();
  const before = s.snap(), history = s.undoStack.length;
  const preview = s.previewCalendar(config); assert.equal(s.snap(), before); assert.equal(s.undoStack.length, history);
  assert.equal(preview.changes.length, 1); assert.equal(fmtISO(preview.view.byId.get(1).start), '2026-11-10');
  assert.equal(s.setCalendar(config), null); const after = s.snap(); assert.equal(day(s, 1), '2026-11-10'); assert.equal(finish(s, 1), '2026-11-12');
  s.undo(); assert.equal(s.snap(), before); s.redo(); assert.equal(s.snap(), after);
});

test('summary dates, milestone conversion and inserted tasks use the configured calendar', () => {
  const s = fixture([task(1, '2026-11-06', 1), task(2, '2026-11-06', 3, { level: 1 }), task(3, '2026-11-10', 2, { level: 1 })]);
  assert.equal(finish(s, 1), '2026-11-11'); assert.equal(s.duration(1), 3);
  assert.equal(s.setTaskKind(2, true), null); assert.equal(s.info.get(2).end, s.byId.get(2).start);
  assert.equal(s.setTaskKind(2, false), null); assert.equal(finish(s, 2), '2026-11-06');
  const id = s.insertTask(2).id; assert.equal(s.byId.get(id).dur, 5); assert.equal(finish(s, id), '2026-11-13');
});

test('calendars survive SQLite state shape, project switches, templates, read-only views and native files', () => {
  const s = fixture(); s.save(); const shape = s.snap();
  const restored = new Store(JSON.parse(JSON.stringify(s.savedState()))); assert.equal(restored.snap(), shape);
  const first = s.wb.active; s.newBlank(); assert.equal(s.calendar.workdays.length, 7); s.switchSheet(first); assert.deepEqual(s.calendar, config);
  assert.deepEqual(s.view(first).calendar, config);
  const template = s.saveTemplate('Working calendar').tpl; s.instantiate(template, D('2026-11-06')); assert.deepEqual(s.calendar, config);
  const contents = encodeProjectFile(s); assert.equal(JSON.parse(contents).version, 2);
  const next = new Store(); openProjectFile(next, contents); assert.deepEqual(next.calendar, config); assert.equal(next.snap(), s.snap());
});

test('legacy files keep everyday scheduling; malformed calendar files fail without mutating the workbook', () => {
  const s = new Store(); const legacy = JSON.parse(encodeProjectFile(s)); delete legacy.project.data.calendar;
  assert.equal(legacy.version, 1); openProjectFile(s, JSON.stringify(legacy)); assert.equal(s.calendar.workdays.length, 7);
  const good = JSON.parse(encodeProjectFile(fixture())), before = s.snap();
  for (const mutate of [(d) => { d.project.data.calendar.workdays = []; }, (d) => { delete d.project.data.calendar; }, (d) => { d.version = 1; }, (d) => { d.project.data.calendar.holidays[0].date = '2026-02-30'; }]) {
    const doc = structuredClone(good); mutate(doc); assert.throws(() => openProjectFile(s, JSON.stringify(doc)), /Invalid Plan project/); assert.equal(s.snap(), before);
  }
  assert.equal(parseProjectFile(JSON.stringify(good)).data.calendar.holidays[0].name, 'Office closure');
});

test('spreadsheet calendar metadata is applied to workday duration and date inference', () => {
  const meta = { rows: [['Plan calendars', 1], ['Task sheet', 'Workdays', 'Holiday date', 'Holiday name'], ['Tasks', '1,2,3,4,5', '2026-11-09', 'Office closure']] };
  const calendars = spreadsheetCalendars([meta]); assert.deepEqual(calendars.get('Tasks'), config);
  const sh = { name: 'Tasks', outline: [], rows: [['Task', 'Start', 'End'], ['Example', '2026-11-06', '2026-11-11']] };
  const imported = mapSheet(sh, calendars.get(sh.name)); assert(imported.ok); assert.equal(imported.data.tasks[0].dur, 3); assert.deepEqual(imported.data.calendar, config);
  sh.rows = [['Task', 'End', 'Days'], ['Example', '2026-11-11', 3]];
  assert.equal(fmtISO(mapSheet(sh, config).data.tasks[0].start), '2026-11-06');
  meta.rows.push(['Tasks', '1,2,3,4,5', '2026-11-09', 'Duplicate']); assert.throws(() => spreadsheetCalendars([meta]), /twice/);
});

test('critical-path float agrees with exhaustive feasible schedules across mixed link types and milestones', () => {
  const oracle = naive(config), next = (d) => { while (!oracle.isWork(d)) d++; return d; };
  const shift = (d, n) => { d = next(d); const dir = n < 0 ? -1 : 1; while (n) { d += dir; if (oracle.isWork(d)) n -= dir; } return d; };
  for (const a of ['FS', 'SS', 'FF', 'SF']) for (const b of ['FS', 'SS', 'FF', 'SF']) for (const milestone of [false, true]) {
    const rels = [{ id: 'l1', from: 1, to: 2, type: a, lag: 1 }, { id: 'l2', from: 2, to: 3, type: b, lag: -1 }];
    const s = fixture([task(1, '2026-11-02', 2), task(2, '2026-11-04', milestone ? 0 : 2, { ms: milestone }), task(3, '2026-11-12', 2)], rels, true);
    const options = s.tasks.map((t) => { const days = []; for (let d = t.start; d <= s.project.end; d++) if (oracle.isWork(d) && oracle.end(d, t.dur) <= s.project.end) days.push(d); return days; });
    const latest = [...s.tasks.map((t) => t.start)];
    for (const x of options[0]) for (const y of options[1]) for (const z of options[2]) {
      const starts = [x, y, z];
      if (!rels.every((l) => {
        const p = l.from - 1, t = l.to - 1;
        const source = l.type[0] === 'F' ? oracle.end(starts[p], s.tasks[p].dur) : starts[p];
        const bound = l.type[1] === 'S' ? shift(source, l.lag) : shift(source - 1, l.lag) + 1;
        return (l.type[1] === 'S' ? starts[t] : oracle.end(starts[t], s.tasks[t].dur)) >= bound;
      })) continue;
      starts.forEach((day, i) => { latest[i] = Math.max(latest[i], day); });
    }
    s.tasks.forEach((t, i) => assert.equal(s.info.get(t.id).float, oracle.count(t.start, latest[i]), `${a}/${b}, milestone=${milestone}, task=${t.id}`));
  }
});

test('extreme durations fail promptly without partial changes or unbounded calendar searches', () => {
  const s = fixture(), before = s.snap();
  for (const value of ['Infinity', '1e308', '9999999999999']) { assert.equal(typeof s.setCell(1, 'dur', value), 'string'); assert.equal(s.snap(), before); }
  assert(Number.isNaN(s.work.finish(s.tasks[0].start, Infinity)));
  assert(Number.isNaN(s.work.start(s.tasks[0].start, 1e308)));
  assert(Number.isNaN(s.work.next(1e308)));
  s.load({ tasks: [task(1, '2026-11-02', Infinity)], links: [] }); assert.equal(s.tasks[0].dur, 1);
  s.tasks[0].dur = 99999999; s.recalc(); const shape = s.snap();
  assert.match(s.setCalendar({ workdays: [1], holidays: [] }), /date range/); assert.equal(s.snap(), shape);
});
