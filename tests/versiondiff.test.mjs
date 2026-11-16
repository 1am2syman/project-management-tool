import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { Store, D } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import { WorkingCalendar } from '../src/project_management_tool/web/js/calendar.js';
import { compareViews, workDelta, trends, changeLog, changeCategory, summaryCards, CHANGE_FILTERS } from '../src/project_management_tool/web/js/versiondiff.js';
import { buildAnalysisPdf, buildAnalysisXlsx } from '../src/project_management_tool/web/js/analysisexport.js';
import { trendSeries, lineChart, ganttChart } from '../src/project_management_tool/web/js/analysis.js';
import { finishWaterfall } from '../src/project_management_tool/web/js/finishwaterfall.js';
import { waterfallChart, waterfallMarkup, waterfallDetails } from '../src/project_management_tool/web/js/waterfallui.js';

beforeEach(() => {
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)) };
  appState.restore({});
});

const day = D('2026-11-02'); // Monday
const weekdays = { workdays: [1, 2, 3, 4, 5], holidays: [] };
const task = (id, name, offset, dur, extra = {}) => ({ id, name, start: day + offset, dur, level: 1, ms: dur === 0, progress: 0, ...extra });
const link = (id, from, to, type = 'FS', lag = 0) => ({ id, from, to, type, lag });
function baseline() {
  return {
    calendar: weekdays,
    tasks: [task(1, 'Phase', 0, 1, { level: 0 }), task(2, 'Design', 0, 5, { owner: 'Ada' }), task(3, 'Build', 7, 5, { owner: 'Ben' }), task(4, 'Docs', 7, 3, { owner: 'Cy' }), task(5, 'Release', 14, 0, { level: 0 })],
    links: [link('l1', 2, 3), link('l2', 3, 5), link('l3', 4, 5)], nextId: 6, nextLink: 4,
  };
}
function revised() {
  const b = structuredClone(baseline());
  b.calendar = { workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-12-25', name: 'Christmas' }] };
  b.tasks[1].dur = 7; b.tasks[2].owner = 'Bea'; b.tasks[3].name = 'Documentation'; b.tasks[3].progress = 50;
  b.tasks.splice(3, 0, task(6, 'QA', 8, 2));
  b.links = [link('l1', 2, 3), link('l2', 3, 5, 'FS', 1), link('l4', 3, 6, 'SS', 1)]; b.nextId = 7; b.nextLink = 5;
  return b;
}
// Minimal reader for the writer's own zip layout: local headers followed by stored or deflated bodies.
function unzip(bytes) {
  const out = {}, dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; dv.getUint32(i, true) === 0x04034b50;) {
    const method = dv.getUint16(i + 8, true), size = dv.getUint32(i + 18, true), nameLength = dv.getUint16(i + 26, true), extra = dv.getUint16(i + 28, true);
    const name = Buffer.from(bytes.subarray(i + 30, i + 30 + nameLength)).toString(), start = i + 30 + nameLength + extra, body = bytes.subarray(start, start + size);
    out[name] = (method === 8 ? inflateRawSync(body) : Buffer.from(body)).toString();
    i = start + size;
  }
  return out;
}
const view = (data) => { const s = new Store(); s.auto = true; s.load(data); return s; };

test('working-day deltas skip weekends and holidays in both directions', () => {
  const work = new WorkingCalendar({ workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-04', name: 'Day off' }] });
  assert.equal(workDelta(work, day + 4, day + 7), 1); // Friday -> Monday
  assert.equal(workDelta(work, day + 7, day + 4), -1);
  assert.equal(workDelta(work, day, day + 3), 2); // Wednesday is a holiday
  assert.equal(workDelta(work, day, day), 0);
});

test('comparison reports finish movement, task, relationship and calendar changes by stable IDs', () => {
  const d = compareViews(view(baseline()), view(revised()));
  assert.deepEqual(d.finish, { days: 3, work: 3 });
  assert.deepEqual(d.start, { days: 0 });
  assert.deepEqual(d.counts, { added: 1, removed: 0, changed: 4, links: 3, calendar: 1 });
  assert.deepEqual(d.links.added.map((l) => l.id), ['l4']);
  assert.deepEqual(d.links.removed.map((l) => l.id), ['l3']);
  assert.deepEqual(d.links.changed.map(({ a, b }) => [a.lag, b.lag]), [[0, 1]]);
  assert.deepEqual(d.calendar.map((c) => [c.label, c.date]), [['Holiday added', '2026-12-25']]);
  const byId = new Map(d.tasks.map((r) => [r.id, r]));
  assert.equal(byId.get(1).status, 'same', 'rolled-up summary dates are not reported as edits');
  assert.equal(byId.get(6).status, 'added');
  assert.deepEqual(byId.get(4).changes.map((c) => c.field), ['name', 'progress']);
  assert.deepEqual(byId.get(3).changes.map((c) => c.field), ['start', 'finish', 'owner']);
  assert.deepEqual(d.rows.map((r) => r.id), [1, 2, 3, 6, 4, 5], 'rows follow the compared plan');
});

test('slips are ranked by working days with their likely causes', () => {
  const d = compareViews(view(baseline()), view(revised()));
  assert.deepEqual(d.slips.map((s) => [s.name, s.days, s.work]), [['Release', 3, 3], ['Design', 4, 2], ['Build', 4, 2]]);
  assert.deepEqual(d.slips[0].causes, ['Lag after “Build” +1d', 'Predecessor “Build” slipped 2d']);
  assert.deepEqual(d.slips[1].causes, ['Duration +2 working days']);
  assert.deepEqual(d.slips[2].causes, ['Predecessor “Design” slipped 2d']);
  assert.equal(d.earlier, 0);
  const back = compareViews(view(revised()), view(baseline()));
  assert.equal(back.slips.length, 0); assert.equal(back.earlier, 3);
  assert.deepEqual(back.counts, { added: 0, removed: 1, changed: 4, links: 3, calendar: 1 });
});

test('start-driven relationships do not blame a predecessor whose finish alone moved', () => {
  const a = { calendar: weekdays, tasks: [task(1, 'Frontend', 0, 2, { level: 0 }), task(2, 'Docs', 0, 2, { level: 0 })], links: [link('l1', 1, 2, 'SS')], nextId: 3, nextLink: 2 };
  const b = structuredClone(a); b.tasks[0].dur = 5; b.tasks[1].dur = 4;
  const d = compareViews(view(a), view(b));
  assert.deepEqual(d.slips.find((s) => s.name === 'Docs').causes, ['Duration +2 working days']);
});

test('milestones, critical path, slack and owners are compared', () => {
  const d = compareViews(view(baseline()), view(revised()));
  assert.deepEqual(d.milestones.map((m) => [m.name, m.delta, m.days, m.status]), [['Release', 3, 3, 'slipped']]);
  assert.deepEqual(d.critical.became, []); assert.deepEqual(d.critical.left, []);
  assert.deepEqual(d.critical.slack.map((s) => [s.name, s.a, s.b]), [['Documentation', 2, 5]]);
  const owners = Object.fromEntries(d.owners.map((o) => [o.owner, o]));
  assert.deepEqual([owners.Ada.slipped, owners.Ada.workDelta, owners.Ada.maxSlip], [1, 2, 2]);
  assert.deepEqual([owners.Bea.slipped, owners.Bea.tasks], [1, 1]);
  assert.deepEqual([owners.Unassigned.added, owners.Unassigned.workDelta], [1, 2]);
  assert.equal(owners.Ben, undefined, 'tasks count under their owner in the compared plan');
  const removedMilestone = baseline(); removedMilestone.tasks.splice(4, 1); removedMilestone.links = removedMilestone.links.slice(0, 1);
  assert.equal(compareViews(view(baseline()), view(removedMilestone)).milestones[0].status, 'removed');
  assert.equal(compareViews(view(removedMilestone), view(baseline())).milestones[0].status, 'new');
});

test('a task joining the critical path is reported', () => {
  const a = baseline(), b = baseline(); b.tasks[3].dur = 6; // Docs now drives Release
  const d = compareViews(view(a), view(b));
  assert.deepEqual(d.critical.became.map((r) => r.name), ['Docs']);
  assert(d.critical.left.some((r) => r.name === 'Build'));
});

test('change log rows each belong to exactly one filter', () => {
  const d = compareViews(view(baseline()), view(revised())), log = changeLog(d), keys = new Set(CHANGE_FILTERS.map(([k]) => k));
  assert.equal(log.length, 13);
  const counts = {}; for (const r of log) { const c = changeCategory(r); assert(keys.has(c), c); counts[c] = (counts[c] || 0) + 1; }
  assert.deepEqual(counts, { dates: 4, duration: 1, owner: 1, structure: 1, progress: 1, added: 1, links: 3, calendar: 1 } );
  assert(log.some((r) => r.change === 'Relationship removed' && r.item === 'Documentation → Release' && r.before === 'FS'));
  assert(log.some((r) => r.change === 'Lag changed' && r.after === 'FS +1d'));
});

test('headline cards mark worse news as bad and better news as good', () => {
  const cards = Object.fromEntries(summaryCards(compareViews(view(baseline()), view(revised()))).map((c) => [c.key, c]));
  assert.equal(cards.finish.delta, '+3 working days'); assert.equal(cards.finish.tone, 'bad');
  assert.equal(cards.progress.tone, 'good'); assert.equal(cards.start.tone, 'same');
  assert.equal(cards.changes.value, '13');
  const same = summaryCards(compareViews(view(baseline()), view(baseline())));
  assert(same.every((c) => c.tone === 'same')); assert.equal(same.find((c) => c.key === 'changes').value, '0');
});

test('trends follow each milestone across plans, including plans without it', () => {
  const a = baseline(), noRelease = baseline(); noRelease.tasks.splice(4, 1); noRelease.links = noRelease.links.slice(0, 1);
  const t = trends([{ label: 'v1', at: 1, view: view(a) }, { label: 'v2', at: 2, view: view(noRelease) }, { label: 'Now', at: 3, view: view(revised()) }]);
  assert.deepEqual(t.labels, ['v1', 'v2', 'Now']);
  assert.deepEqual(t.milestones.map((m) => [m.name, m.dates.map((x) => (x == null ? null : x - day))]), [['Release', [14, null, 17]]]);
  assert.equal(t.finish.length, 3);
  assert.equal(trendSeries(t, 1).length, 1);
  const svg = lineChart({ width: 500, labels: t.labels, series: [{ name: 'Release', color: '#000', values: t.milestones[0].dates }], highlight: [0, 2] });
  assert.equal((svg.match(/<circle/g) || []).length, 2, 'a missing milestone leaves a gap');
});

test('baseline Gantt draws a ghost for the baseline and a bar for the compared plan', () => {
  const d = compareViews(view(baseline()), view(revised())), { svg, height } = ganttChart(d, 900, d.rows);
  assert.equal((svg.match(/class="g-ghost"/g) || []).length, 5);
  assert.equal((svg.match(/class="g-bar /g) || []).length, 6);
  assert.match(svg, /g-bar add/); assert.match(svg, /g-bar late/);
  assert(height > d.rows.length * 20);
});

test('PDF and Excel exports contain every analysis section', async () => {
  const A = view(baseline()), B = view(revised()), d = compareViews(A, B);
  d.waterfall = finishWaterfall(A, B);
  const trend = trends([{ label: 'v1', at: Date.UTC(2026, 10, 1), view: A }, { label: 'Now', at: Date.UTC(2026, 10, 2), view: B }]);
  const meta = { project: 'Release plan', a: { id: 'v1', label: 'v1 · Base', short: 'v1', at: trend.at[0] }, b: { id: '', label: 'Current plan', short: 'Now', at: trend.at[1] }, trend, milestones: trendSeries(trend), log: changeLog(d) };
  const pdf = Buffer.from(await buildAnalysisPdf(d, meta).arrayBuffer()).toString('latin1');
  assert(pdf.startsWith('%PDF-1.4'));
  for (const s of ['Version analysis - Release plan', 'Forecast finish across versions', 'Milestone trend', 'Milestones', 'Biggest slips', 'Gantt comparison', 'Why the project finish changed', 'Finish contributions', 'Change log', 'Critical path', 'By owner']) assert(pdf.includes(`(${s})`) || pdf.includes(s), s);
  const files = unzip(new Uint8Array(await (await buildAnalysisXlsx(d, meta)).arrayBuffer()));
  for (const s of ['Summary', 'Trends', 'Milestones', 'Gantt comparison', 'Change log', 'Biggest slips', 'Critical path', 'By owner', 'Finish waterfall', 'Finish waterfall chart']) assert(files['xl/workbook.xml'].includes(`name="${s}"`), s);
  assert.equal(Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).length, 10);
  assert(files['xl/worksheets/sheet10.xml'].includes('Why the project finish changed'));
  assert(files['xl/worksheets/sheet10.xml'].includes('Design'));
  const waterfall = files['xl/worksheets/sheet9.xml'];
  for (const s of ['Design', 'Project working calendar', 'Working days', 'Calendar days', 'Explanation', 'Contributions depend', 'A3:K3']) assert(waterfall.includes(s), s);
  for (const s of d.waterfall.steps) {
    assert(waterfall.includes(s.title.replace(/&/g, '&amp;').replace(/>/g, '&gt;')), s.title);
    assert(waterfall.includes(`<v>${s.work}</v>`));
  }
  assert(files['xl/worksheets/sheet5.xml'].includes('Relationship removed'));
  assert(files['xl/worksheets/sheet6.xml'].includes('Lag after “Build” +1d'));
});

test('waterfall chart, table and detail expose named contributions safely with selectable steps', () => {
  const A = view(baseline()), B = view(revised());
  const w = finishWaterfall(A, B), result = waterfallChart(w, 1100);
  assert.equal((result.svg.match(/class="wf-step"/g) || []).length, w.steps.length);
  assert.match(result.svg, /aria-pressed="true"/); assert.equal(result.height, 330);
  const markup = waterfallMarkup(w); assert.match(markup, /Why the finish moved/); assert.match(markup, /Resulting finish/);
  assert.match(waterfallDetails(w, 0), /Contribution to project finish/);
  const dangerous = structuredClone(w); dangerous.steps[0].title = '<script>bad()</script>'; dangerous.steps[0].items[0].name = '<img src=x onerror=bad()>';
  for (const output of [waterfallChart(dangerous, 900).svg, waterfallMarkup(dangerous), waterfallDetails(dangerous, 0)]) {
    assert(!output.includes('<script>'), 'escapes task names'); assert(!output.includes('<img src=x'), 'escapes item detail'); assert(output.includes('&lt;'));
  }
  const same = finishWaterfall(A, A); assert.match(waterfallMarkup(same), /No scheduling changes/); assert(!waterfallChart(same, 700).svg.includes('NaN'));
});

test('long waterfall comparisons paginate PDF and Excel charts with carried-forward dates', async () => {
  const data = { calendar: weekdays, tasks: Array.from({ length: 8 }, (_, i) => task(i + 1, i === 0 ? 'a'.repeat(120) : `Stage ${i + 1}`, 0, 2, { level: 0 })), links: Array.from({ length: 7 }, (_, i) => link(`l${i + 1}`, i + 1, i + 2)) };
  const edited = structuredClone(data); edited.tasks.forEach((t) => { t.dur = 3; });
  const A = view(data), B = view(edited), d = compareViews(A, B); d.waterfall = finishWaterfall(A, B);
  assert.equal(d.waterfall.steps.length, 8);
  const trend = trends([{ label: 'v1', at: 1, view: A }, { label: 'Now', at: 2, view: B }]);
  const meta = { project: 'Long comparison', a: { id: 'v1', label: 'Baseline', short: 'v1', at: 1 }, b: { id: '', label: 'Current plan', short: 'Now', at: 2 }, trend, milestones: [], log: changeLog(d) };
  const pdf = Buffer.from(await buildAnalysisPdf(d, meta).arrayBuffer()).toString('latin1');
  assert(pdf.includes('Project finish waterfall \\(continued\\)')); assert(pdf.includes('Carried forward'));
  assert(pdf.includes('a'.repeat(32)), 'export details retain long unbroken names instead of truncating every occurrence');
  const files = unzip(new Uint8Array(await (await buildAnalysisXlsx(d, meta)).arrayBuffer()));
  const chart = files['xl/worksheets/sheet10.xml']; assert(chart.includes('Carried forward'));
  for (const title of ['Stage 2', 'Stage 8', 'a'.repeat(120)]) assert(chart.includes(title));
  assert(files['xl/worksheets/sheet9.xml'].includes('a'.repeat(120)));
});
