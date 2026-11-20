import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, D } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import { encodeProjectFile, parseProjectFile, openProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';
import { compareViews } from '../src/project_management_tool/web/js/versiondiff.js';
import { finishWaterfall } from '../src/project_management_tool/web/js/finishwaterfall.js';
import { buildPdf } from '../src/project_management_tool/web/js/pdf.js';
import { buildXlsx } from '../src/project_management_tool/web/js/xlsx.js';
import { inflateRawSync } from 'node:zlib';

const week = { workdays: [1, 2, 3, 4, 5], holidays: [] };
const daily = { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] };
const longest = { method: 'longest', threshold: 0 };
const task = (id, start, dur, extra = {}) => ({ id, name: `Task ${id}`, start: D(start), dur, ms: dur === 0, level: 0, progress: 0, ...extra });
const link = (id, from, to, type = 'FS', lag = 0) => ({ id, from, to, type, lag });
beforeEach(() => {
  const memory = new Map(); globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
  appState.onChange(() => {}); appState.restore({});
});
function fixture(extra = [], links = []) {
  const s = new Store(); s.auto = true;
  s.load({ calendar: week, tasks: [task(1, '2026-11-02', 5, { calendar: daily }), task(2, '2026-11-02', 2), task(3, '2026-11-02', 0), ...extra], links: [link('l1', 1, 2), link('l2', 2, 3), ...links] });
  s.save(); return s;
}
const critical = s => s.tasks.filter(t => !s.info.get(t.id).summary && s.info.get(t.id).critical).map(t => t.id);
const floats = s => s.tasks.map(t => { const f = s.info.get(t.id); return [f.float, f.freeFloat, f.latestStart, f.latestEnd, f.freeStart, f.freeEnd]; });

test('Longest Path connects a mixed-calendar driving chain without erasing real slack or editing the plan', () => {
  const s = fixture(), before = s.snap(), slack = floats(s), history = s.undoStack.length;
  assert.deepEqual(critical(s), [2, 3]); assert.equal(s.info.get(1).float, 2); assert.equal(s.links[0].slack, 0); assert.equal(s.links[0].critical, false);
  assert.equal(s.setCriticalTarget(null, longest), null);
  assert.deepEqual(critical(s), [1, 2, 3]); assert(s.links.every(l => l.critical));
  assert.deepEqual(floats(s), slack); assert.equal(s.snap(), before); assert.equal(s.undoStack.length, history);
  s.setCriticalTarget(null, { method: 'float', threshold: 1 }); assert.deepEqual(critical(s), [2, 3]);
  s.setCriticalTarget(null, { method: 'float', threshold: 2 }); assert.deepEqual(critical(s), [1, 2, 3]);
  s.setCriticalTarget(null, { method: 'float', threshold: 0 }); assert.deepEqual(critical(s), [2, 3]);
});

test('all tied driving branches and finish-defining leaves are traced; connected nondriving work is excluded', () => {
  const s = fixture([task(4, '2026-11-02', 7, { calendar: daily }), task(5, '2026-11-02', 1), task(6, '2026-11-11', 0)], [link('l3', 4, 2), link('l4', 5, 2)]);
  s.setCriticalTarget(null, longest); assert.deepEqual(critical(s), [1, 2, 3, 4, 6]);
  assert.equal(s.links.find(l => l.id === 'l3').critical, true); assert.equal(s.links.find(l => l.id === 'l4').critical, false);
  assert.equal(s.setCriticalTarget(3), null); assert.deepEqual(critical(s), [1, 2, 3, 4]); assert.equal(s.info.get(6).float, null);
});

test('calendar closures can create more than a weekend of genuine float on the longest path', () => {
  const s = fixture();
  const closed = { ...week, holidays: ['09', '10', '11', '12', '13'].map(d => ({ date: `2026-11-${d}`, name: 'Office closure' })) };
  s.setCalendar(closed, 2); s.setCriticalTarget(3, longest);
  assert.equal(s.info.get(1).float, 9); assert.deepEqual(critical(s), [1, 2, 3]); assert(s.links[0].critical);
});

test('manual dates, retained anchor gaps and violated dependencies stop upstream driving traces', () => {
  for (const mode of ['manual', 'anchor']) {
    const s = fixture(); s.auto = false; s.byId.get(2).scheduling = mode; s.byId.get(2).start = D('2026-11-12'); s.byId.get(3).start = D('2026-11-16');
    s.recalc(); s.setCriticalTarget(3, longest);
    assert.deepEqual(critical(s), [2, 3]); assert.equal(s.links[0].driving, false);
  }
  const s = fixture(); s.auto = false; s.byId.get(2).start = D('2026-11-02'); s.recalc(); s.setCriticalTarget(3, longest);
  assert(s.links[0].violated); assert(!s.links[0].critical); assert(!s.info.get(1).critical);
});

test('completed tasks retain path membership for analysis but are not highlighted; summaries inherit only highlights', () => {
  const s = fixture(); s.byId.get(1).progress = 100;
  s.tasks.unshift(task(10, '2026-11-02', 1)); s.byId.get(1).level = 1; s.recalc(); s.setCriticalTarget(3, longest);
  assert.equal(s.info.get(1).longestPath, true); assert.equal(s.info.get(1).critical, false); assert.equal(s.info.get(10).critical, false); assert.equal(s.info.get(10).float, null);
  s.byId.get(1).progress = 50; s.recalc(); assert.equal(s.info.get(10).critical, true);
});

// Independent daily enumeration finds the earliest successor start allowed by ONE relationship.
// This tests working-calendar normalization, every endpoint type, signed lag and milestone endpoints.
test('driving relationship flags match an independent daily oracle for mixed calendars and all endpoint types', () => {
  function oracle(calendar) {
    const isWork = d => calendar.workdays.includes(new Date(d * 86400000).getUTCDay()) && !calendar.holidays.some(h => D(h.date) === d);
    const next = d => { while (!isWork(d)) d++; return d; };
    const finish = (d, n) => { while (n) { if (isWork(d)) n--; d++; } return d; };
    const shift = (d, n) => { d = next(d); const step = n < 0 ? -1 : 1; while (n) { d += step; if (isWork(d)) n -= step; } return d; };
    return { isWork, finish, shift };
  }
  const calendars = [week, daily, { workdays: [0, 2, 4, 6], holidays: [{ date: '2026-11-10', name: 'Closure' }] }];
  for (const type of ['FS', 'SS', 'FF', 'SF']) for (const lag of [-2, 0, 2]) for (const aDuration of [0, 5]) for (const bDuration of [0, 3]) for (let i = 0; i < calendars.length; i++) {
    const aCalendar = calendars[i], bCalendar = calendars[(i + 1) % calendars.length], a = oracle(aCalendar), b = oracle(bCalendar);
    const s = new Store(); s.auto = true;
    s.load({ calendar: week, tasks: [task(1, '2026-11-06', aDuration, { calendar: aCalendar }), task(2, '2026-10-01', bDuration, { calendar: bCalendar })], links: [link('l1', 1, 2, type, lag)] });
    const A = s.byId.get(1), B = s.byId.get(2), source = type[0] === 'F' ? a.finish(A.start, A.dur) : A.start;
    const bound = type[1] === 'S' ? b.shift(source, lag) : b.shift(source - 1, lag) + 1;
    let earliest = D('2026-09-01');
    while (!b.isWork(earliest) || (type[1] === 'S' ? earliest : b.finish(earliest, B.dur)) < bound) earliest++;
    assert.equal(s.links[0].driving, earliest === B.start && !s.links[0].violated, `${type} ${lag} ${aDuration}/${bDuration} ${i}`);
  }
});

test('method and threshold persist per project, across browser/database reloads, copies and export views', () => {
  const s = fixture(), first = s.wb.active; s.setCriticalTarget(null, longest);
  const second = s.addSheet(JSON.parse(s.serialize()), 'Second'); assert.equal(s.criticalOptions().method, 'float');
  s.setCriticalTarget(null, { method: 'float', threshold: 3 }); s.switchSheet(first); assert.deepEqual(s.criticalOptions(), longest);
  assert.equal(s.view(second).criticalOptions().threshold, 3); assert.equal(s.view(first).info.get(1).critical, true);
  const restored = new Store(s.savedState()), browser = new Store();
  assert.deepEqual(restored.criticalOptions(), longest); assert.deepEqual(browser.criticalOptions(), longest);
  const copy = s.duplicateSheet(first); assert.deepEqual(s.criticalOptions(), longest); assert.notEqual(copy, first);
  for (const options of [{ method: 'invalid', threshold: 0 }, { method: 'float', threshold: -1 }, { method: 'float', threshold: 0.5 }]) {
    const before = JSON.stringify(s.savedState()); assert.match(s.setCriticalTarget(null, options), /whole-number/); assert.equal(JSON.stringify(s.savedState()), before);
  }
  s.stale = true; assert.match(s.setCriticalTarget(null, longest), /another tab/); s.stale = false;
  s.sheet().readOnly = true; assert.equal(s.setCriticalTarget(3, longest), null);
});

test('versions retain their method; preview, restore, copy and native files use it without changing live settings', () => {
  const s = fixture(); s.setCriticalTarget(3, longest); const v = s.snapshotVersion({ name: 'Longest' }).version;
  s.setCriticalTarget(null, { method: 'float', threshold: 1 }); const before = s.snap();
  const version = s.versionView(v.id); assert.deepEqual(version.criticalOptions(), longest); assert.deepEqual(critical(version), [1, 2, 3]);
  assert.equal(compareViews(version, s.view(s.wb.active)).a.criticalMethod, 'Longest Path');
  s.previewVersion(v.id); assert.deepEqual(s.criticalOptions(), longest); assert.equal(s.setCriticalTarget(null, longest).includes('saved version'), true);
  const contents = encodeProjectFile(s); assert.equal(parseProjectFile(contents).preferences.criticalPath.threshold, 1);
  s.exitPreview(); assert.equal(s.criticalOptions().threshold, 1); assert.equal(s.snap(), before);
  const opened = new Store(); openProjectFile(opened, contents); assert.equal(opened.criticalOptions().threshold, 1);
  assert.deepEqual(opened.versionView('v1').criticalOptions(), longest);
  s.restoreVersion(v.id); assert.deepEqual(s.criticalOptions(), longest);
  const copied = s.copyVersionAsProject(v.id); assert(copied.id); assert.deepEqual(s.criticalOptions(), longest);
  const doc = JSON.parse(encodeProjectFile(s)); doc.preferences.criticalPath.threshold = -1; assert.throws(() => parseProjectFile(JSON.stringify(doc)), /critical-path method/);
  const legacy = JSON.parse(encodeProjectFile(s)); delete legacy.preferences.criticalPath; openProjectFile(opened, JSON.stringify(legacy)); assert.deepEqual(opened.criticalOptions(), { method: 'float', threshold: 0 });
});

test('PDF and Excel report the chosen method and retain positive float on highlighted tasks', async () => {
  const s = fixture(); s.setCriticalTarget(3, longest); const projects = [{ name: 'Mixed calendars', store: s.view(s.wb.active) }];
  const pdf = await (await buildPdf(projects, { slack: true })).text(); assert(pdf.includes('Critical-path method: Longest Path'));
  const bytes = new Uint8Array(await (await buildXlsx(projects)).arrayBuffer()), files = {}, dv = new DataView(bytes.buffer);
  for (let i = 0; dv.getUint32(i, true) === 0x04034b50;) {
    const method = dv.getUint16(i + 8, true), size = dv.getUint32(i + 18, true), length = dv.getUint16(i + 26, true), extra = dv.getUint16(i + 28, true);
    const name = Buffer.from(bytes.subarray(i + 30, i + 30 + length)).toString(), start = i + 30 + length + extra, body = bytes.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(body) : Buffer.from(body)).toString(); i = start + size;
  }
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="H2"[^>]*><v>2<\/v><\/c>/);
  assert.match(sheet, /<c r="J2"[^>]*>.*?<t[^>]*>Yes<\/t>/);
  assert(sheet.includes('Longest Path'));
});

test('waterfall driving explanations include calendar-buffered tasks regardless of display choice', () => {
  const s = fixture(), before = s.view(s.wb.active); s.byId.get(1).dur += 3; s.settle(); s.save();
  const waterfall = finishWaterfall(before, s.view(s.wb.active));
  const revision = waterfall.steps.find(step => step.items.some(item => item.name === 'Task 1'));
  assert(revision); assert(revision.driversBefore.includes('Task 1')); assert(revision.paths.some(path => path.join(' → ') === 'Task 1 → Task 2 → Task 3'));
});

test('empty plans have no driving path and switching target after an edit recomputes membership', () => {
  const s = new Store(); s.load({ tasks: [], links: [] }); s.setCriticalTarget(null, longest); assert.equal(s.critCount, 0);
  const f = fixture(); f.setCriticalTarget(3, longest); f.byId.get(1).dur = 4; f.settle(); assert.equal(f.info.get(1).critical, true);
  f.auto = false; f.byId.get(2).start += 1; f.recalc(); assert.equal(f.info.get(1).longestPath, false);
});
