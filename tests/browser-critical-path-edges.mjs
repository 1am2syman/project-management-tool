// Independent scheduling fixtures + real DOM/color/geometry checks in an isolated database/profile.
// Run with PLAN_TEST_ARTIFACTS to retain screenshots and the measured audit report.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-critical-edges-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'critical-path-edges') : join(temp, 'screenshots');
await mkdir(evidence, { recursive: true });
const D = iso => Date.parse(`${iso}T00:00:00Z`) / 86400000;
const week = { workdays: [1, 2, 3, 4, 5], holidays: [] }, daily = { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] };
const odd = { workdays: [0, 2, 4, 6], holidays: [{ date: '2026-11-10', name: 'Crew closure' }] };
const task = (id, name, dur, extra = {}) => ({ id, name, start: D('2026-11-02'), dur, ms: dur === 0, progress: 0, level: 0, ...extra });
const link = (id, from, to, type = 'FS', lag = 0) => ({ id, from, to, type, lag });
const baseTasks = () => [task(1, 'Site work', 5, { calendar: daily }), task(2, 'Office review', 2), task(3, 'Handover', 0)];
const baseLinks = () => [link('l1', 1, 2), link('l2', 2, 3)];
const fixtures = [];
function add(name, { tasks = baseTasks(), links = baseLinks(), target = 3, critical = [1, 2, 3], criticalLinks = ['l1', 'l2'], calendar = week, ...rest } = {}) {
  const id = `s${fixtures.length + 1}`;
  fixtures.push({ id, name, target, critical, criticalLinks, tasks, links, calendar, ...rest }); return id;
}
const mixed = add('Weekend buffer', { floats: { 1: '2' } });
const closedTasks = baseTasks(); closedTasks[1].calendar = { ...week, holidays: ['09', '10', '11', '12', '13'].map(d => ({ date: `2026-11-${d}`, name: 'Office closure' })) };
add('Week-long closure', { tasks: closedTasks, floats: { 1: '9' } });
add('Tied driving branches', { target: null, tasks: [...baseTasks(), task(4, 'Longer tied crew', 7, { calendar: daily }), task(5, 'Short nondriving branch', 1), task(6, 'Separate completion', 0, { start: D('2026-11-11') })], links: [...baseLinks(), link('l3', 4, 2), link('l4', 5, 2)], critical: [1, 2, 3, 4, 6], criticalLinks: ['l1', 'l2', 'l3'] });
const competing = add('Later independent finish', { target: null, tasks: [...baseTasks(), task(4, 'Later independent work', 8)], critical: [4], criticalLinks: [] });
for (const scheduling of ['manual', 'anchor']) {
  const tasks = baseTasks(); tasks[1] = { ...tasks[1], scheduling, start: D('2026-11-12') };
  add(`${scheduling} date gap`, { tasks, critical: [2, 3], criticalLinks: ['l2'] });
}
const manualTight = baseTasks(); manualTight[1] = { ...manualTight[1], scheduling: 'manual', start: D('2026-11-09') };
add('Manual date at bound', { tasks: manualTight, critical: [2, 3], criticalLinks: ['l2'] });
const violatedTasks = baseTasks(); violatedTasks[1] = { ...violatedTasks[1], scheduling: 'manual', start: D('2026-11-05') };
const violated = add('Violated dependency', { tasks: violatedTasks, critical: [2, 3], criticalLinks: ['l2'], violated: ['l1'] });
const completedTasks = baseTasks(); completedTasks[0].progress = 100;
add('Completed predecessor', { tasks: completedTasks, critical: [2, 3], criticalLinks: ['l2'] });
const summaryTasks = [task(10, 'Construction package', 1), ...baseTasks()]; summaryTasks[1].level = 1; summaryTasks[1].progress = 60;
const summary = add('Summary and progress', { tasks: summaryTasks, summaries: [10] });
add('Empty plan', { tasks: [], links: [], target: null, critical: [], criticalLinks: [] });
add('Single weekend milestone', { tasks: [task(3, 'Weekend milestone', 0, { start: D('2026-11-07'), calendar: daily })], links: [], critical: [3], criticalLinks: [] });
const escaped = add('Long labels and characters', { tasks: [task(1, 'Site <script> & "quoted" work — a deliberately long construction activity name', 5, { calendar: daily }), task(2, 'Review <img src=x onerror=alert(1)> & approval', 2), task(3, 'Handover — a deliberately long milestone name', 0)] });

// This oracle enumerates real days; it imports no application calendar/model/path code.
function calendarOracle(calendar) {
  const isWork = d => calendar.workdays.includes(new Date(d * 86400000).getUTCDay()) && !calendar.holidays.some(h => D(h.date) === d);
  const next = d => { while (!isWork(d)) d++; return d; };
  const finish = (d, n) => { while (n) { if (isWork(d)) n--; d++; } return d; };
  const shift = (d, n) => { d = next(d); const step = n < 0 ? -1 : 1; while (n) { d += step; if (isWork(d)) n -= step; } return d; };
  return { isWork, next, finish, shift };
}
for (const type of ['FS', 'SS', 'FF', 'SF']) for (const lag of [-2, 0, 2]) for (const [aDuration, bDuration, aCalendar, bCalendar] of [[5, 3, daily, week], [0, 2, week, daily], [3, 0, week, odd]]) {
  const a = calendarOracle(aCalendar), b = calendarOracle(bCalendar), aStart = a.next(D('2026-11-06'));
  const source = type[0] === 'F' ? a.finish(aStart, aDuration) : aStart;
  const bound = type[1] === 'S' ? b.shift(source, lag) : b.shift(source - 1, lag) + 1;
  let bStart = D('2026-09-01');
  while (!b.isWork(bStart) || (type[1] === 'S' ? bStart : b.finish(bStart, bDuration)) < bound) bStart++;
  const finish = b.finish(bStart, bDuration);
  add(`${type} ${lag >= 0 ? '+' : ''}${lag} · ${aDuration}/${bDuration}`, { tasks: [task(1, `${type} predecessor`, aDuration, { start: aStart, calendar: aCalendar }), task(2, `${type} successor`, bDuration, { start: D('2026-09-01'), calendar: bCalendar }), task(3, 'Target milestone', 0, { start: D('2026-09-01'), calendar: daily })], links: [link('l1', 1, 2, type, lag), link('l2', 2, 3)], dates: { 1: aStart, 2: bStart, 3: finish } });
}
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', temp, '--no-open', '--file-access', 'off'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stderr.on('data', chunk => { log += chunk; });
const report = { fixtures: [], layouts: [], screenshots: [] };
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(log)), 10000);
    server.once('exit', code => { clearTimeout(timer); no(new Error(`Server ${code}: ${log}`)); });
    server.stdout.on('data', chunk => { log += chunk; const match = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (match) { clearTimeout(timer); yes(match[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const errors = [];
  async function contextFor(options) {
    const context = await browser.newContext(options);
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    context.on('page', p => p.on('pageerror', e => errors.push(e.message))); return context;
  }
  const context = await contextFor({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
  const row = id => page.locator(`#gbody .r[data-id="${id}"]`);
  const saved = (p = page) => p.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const settle = (p = page) => p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const data = () => page.evaluate(async () => { const { state } = await (await fetch('/api/projects')).json(); return state.workbook.sheets.find(s => s.id === state.workbook.active).data; });
  const screenshot = async (name, p = page) => { await p.screenshot({ path: join(evidence, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  await page.goto(url); await row(21).waitFor(); await saved();
  await page.evaluate(async (cases) => {
    const response = await (await fetch('/api/projects')).json();
    response.state.workbook = { active: cases[0].id, nextSheet: cases.length + 1, sheets: cases.map(c => ({ id: c.id, name: c.name, criticalPath: { method: 'longest', threshold: 0 }, data: { calendar: c.calendar, tasks: c.tasks, links: c.links, collapsed: [], nextId: 100, nextLink: 100 } })) };
    response.state.preferences = { auto: true, critical: true, criticalTargets: Object.fromEntries(cases.filter(c => c.target).map(c => [c.id, c.target])) };
    response.state.history = {};
    const result = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) });
    if (!result.ok) throw new Error('Cannot prepare edge fixtures');
  }, fixtures);
  await page.reload(); await row(1).waitFor(); await saved();
  async function switchTo(id) { await page.locator(`#tabs .tab[data-id="${id}"]`).click(); await page.waitForFunction(id => document.querySelector('#tabs .tab.on')?.dataset.id === id, id); await settle(); }
  async function display(method = 'longest', target = '3', threshold = '0') {
    await page.locator('#critical-target').click(); const d = page.getByRole('dialog', { name: 'Critical-path target', exact: true });
    await d.getByLabel('Define critical activities as').selectOption(method);
    if (method === 'float') await d.getByLabel('Total Float threshold (working days)').fill(threshold);
    await d.getByLabel('Calculate critical path to').selectOption(target); await d.getByRole('button', { name: 'Show critical path', exact: true }).click(); await saved(); await settle();
  }
  async function highlighted(c) {
    const actual = await page.locator('.bar.critical:not(.summary)').evaluateAll(els => els.map(e => +e.dataset.id).sort((a, b) => a - b));
    assert.deepEqual(actual, [...c.critical].sort((a, b) => a - b), `${c.name}: tasks`);
    const links = await page.locator('.lk.crit').evaluateAll(els => els.map(e => e.dataset.id).sort());
    assert.deepEqual(links, [...c.criticalLinks].sort(), `${c.name}: links`);
    for (const id of c.criticalLinks) assert.equal(await page.locator(`.lk[data-id="${id}"] .vis`).evaluate(el => getComputedStyle(el).stroke), 'rgb(244, 63, 94)', `${c.name}: actual red connector ${id}`);
    for (const id of c.critical) {
      const bar = page.locator(`.bar[data-id="${id}"]`);
      assert.equal(await bar.evaluate(el => getComputedStyle(el, el.classList.contains('ms') ? '::before' : null).backgroundColor), 'rgb(244, 63, 94)', `${c.name}: actual red ${id}`);
    }
  }
  for (const c of fixtures) {
    await switchTo(c.id); await highlighted(c);
    for (const [id, value] of Object.entries(c.floats || {})) assert.equal(await row(id).locator('[data-col=float]').textContent(), value, `${c.name}: float ${id}`);
    if (c.dates) {
      await saved(); const actual = await data();
      for (const [id, expected] of Object.entries(c.dates)) assert.equal(actual.tasks.find(t => t.id === +id).start, expected, `${c.name}: independently calculated start ${id}`);
    }
    for (const id of c.violated || []) assert(await page.locator(`.lk[data-id="${id}"]`).evaluate(el => el.classList.contains('viol')));
    for (const id of c.summaries || []) assert(await page.locator(`.bar.summary.critical[data-id="${id}"]`).count());
    report.fixtures.push({ name: c.name, tasks: c.tasks.length, critical: c.critical, links: c.criticalLinks });
    if (['Week-long closure', 'Tied driving branches', 'Violated dependency', 'Completed predecessor', 'Summary and progress', 'Empty plan', 'Single weekend milestone'].includes(c.name) || /^S[FS] \+0/.test(c.name) || /^F[FS] -2/.test(c.name)) {
      await page.locator('[data-fit]').click(); await settle(); await screenshot(`case-${c.id}`);
    }
  }
  console.log(`PASS ${fixtures.length} independent fixtures: dependency types, signed lags, calendar closures, ties, manual/anchor gaps, violations, completed work, summaries and empty plans`);
  await switchTo(competing); await display('longest', '3'); await highlighted(fixtures[0]);
  await switchTo(mixed); const original = await data();
  // Toggle and threshold controls must change paint while preserving all task/link/calendar data.
  await display('float', '3', '0'); await highlighted({ name: 'Float 0', critical: [2, 3], criticalLinks: ['l2'] });
  for (const invalid of ['', '-1', '0.5', '100000000']) {
    await page.locator('#critical-target').click(); const d = page.getByRole('dialog', { name: 'Critical-path target', exact: true });
    await d.getByLabel('Total Float threshold (working days)').fill(invalid); await d.getByRole('button', { name: 'Show critical path', exact: true }).click(); assert(await d.getByRole('alert').isVisible(), `Reject threshold ${invalid}`); await page.keyboard.press('Escape');
  }
  await display('float', '3', '2'); await highlighted(fixtures[0]); await display();
  await page.locator('label.switch').filter({ has: page.locator('#optCrit') }).click(); await settle();
  assert.notEqual(await page.locator('.bar[data-id="1"]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(244, 63, 94)');
  await page.locator('label.switch').filter({ has: page.locator('#optCrit') }).click(); await settle(); await highlighted(fixtures[0]);
  assert.deepEqual(await data(), original);
  // Keyboard dialog cancellation, changing/deleting the chosen milestone, and undo/redo.
  await page.locator('#critical-target').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); assert(await page.locator('#critical-target').evaluate(el => el === document.activeElement));
  await row(3).locator('[data-col=name]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Convert to task (1 working day)', exact: true }).click(); await saved();
  assert.equal(await page.locator('#critical-target').textContent(), 'Longest path');
  await page.keyboard.press('Control+z'); await saved(); await display();
  await row(3).locator('[data-col=name]').click(); await page.locator('[data-act=del]').click(); await saved(); assert.equal(await row(3).count(), 0);
  assert.equal(await page.locator('#critical-target').textContent(), 'Longest path');
  await page.keyboard.press('Control+z'); await saved(); await display(); await highlighted(fixtures[0]);
  // A real duration edit changes the driving chain, and undo/redo restores it.
  await row(1).locator('[data-col=dur]').dblclick(); await page.locator('.editor').fill('8'); await page.keyboard.press('Enter'); await saved(); await highlighted(fixtures[0]);
  assert.equal((await data()).tasks.find(t => t.id === 1).dur, 8);
  await page.keyboard.press('Control+z'); await saved(); assert.equal((await data()).tasks.find(t => t.id === 1).dur, 5);
  await page.keyboard.press('Control+Shift+z'); await saved(); assert.equal((await data()).tasks.find(t => t.id === 1).dur, 8);
  await page.keyboard.press('Control+z'); await saved();
  await switchTo(summary); await row(10).locator('.tog:not(.sp)').click(); await settle(); assert.equal(await row(1).count(), 0); assert.equal(await page.locator('.bar.summary.critical[data-id="10"]').count(), 1); await screenshot('collapsed-summary');
  await row(10).locator('.tog:not(.sp)').click();
  await switchTo(escaped); assert.equal(await row(1).locator('script').count(), 0); assert.equal(await row(2).locator('img').count(), 0);
  await page.locator('[data-fit]').click(); await settle(); await screenshot('escaped-long-labels');
  await switchTo(violated); await row(1).locator('[data-col=float]').click(); await screenshot('negative-slack-dialog'); await page.keyboard.press('Escape');
  await switchTo(mixed); await display(); await page.reload(); await row(1).waitFor(); await saved(); await highlighted(fixtures[0]);
  console.log('PASS thresholds, actual paint toggle, cancellation/focus, target conversion/deletion, duration edits, undo/redo, collapse and reload');

  // Layout geometry checks accompany screenshots: row/bar centers, fit, real colors, and dialog bounds.
  async function layout(p, label, zoom = 1) {
    await p.evaluate(factor => { document.documentElement.style.zoom = String(factor); }, zoom); await settle(p);
    await p.getByRole('combobox', { name: 'Row density' }).selectOption('compact'); await p.locator('[data-fit]').click(); await settle(p);
    for (const density of ['compact', 'auto']) {
      await p.getByRole('combobox', { name: 'Row density' }).selectOption(density); await settle(p);
      const g = await p.evaluate(() => {
        const v = document.querySelector('#gb').getBoundingClientRect();
        return [...document.querySelectorAll('.bar')].map(b => {
          const br = b.getBoundingClientRect(), lr = b.querySelector('.label').getBoundingClientRect(), rr = document.querySelector(`#gbody .r[data-id="${b.dataset.id}"]`).getBoundingClientRect();
          return { id: b.dataset.id, delta: Math.abs((br.top + br.bottom - rr.top - rr.bottom) / 2), left: Math.min(br.left, lr.left) - v.left, right: Math.max(br.right, lr.right) - v.left, width: v.width };
        });
      });
      for (const b of g) { assert(b.delta < 2 * zoom, `${label}/${density}: row alignment ${JSON.stringify(b)}`); assert(b.left >= -zoom, `${label}/${density}: clipped left ${JSON.stringify(b)}`); assert(b.right <= b.width + zoom, `${label}/${density}: clipped right ${JSON.stringify(b)}`); }
      await screenshot(`${label}-${density}`, p); report.layouts.push({ label, density, zoom, bars: g });
    }
    await p.locator('#critical-target').click(); const dialog = p.getByRole('dialog', { name: 'Critical-path target', exact: true });
    const bounds = await dialog.boundingBox(), vp = p.viewportSize(); assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= vp.width + 1 && bounds.y + bounds.height <= vp.height + 1, `${label}: dialog bounds ${JSON.stringify(bounds)}`);
    await screenshot(`${label}-dialog`, p); await p.keyboard.press('Escape');
  }
  for (const width of [1440, 1000, 760]) { await page.setViewportSize({ width, height: 1000 }); await layout(page, `width-${width}`); }
  await page.setViewportSize({ width: 1440, height: 1100 }); await layout(page, 'css-zoom-125', 1.25); await layout(page, 'css-zoom-150', 1.5);
  await context.close();
  for (const scale of [1.5, 2]) {
    const scaled = await contextFor({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: scale }), p = await scaled.newPage();
    await p.goto(url); await p.locator('.bar.critical[data-id="1"]').waitFor(); await saved(p); await layout(p, `scale-${scale}`); await scaled.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'audit.json'), JSON.stringify(report, null, 2));
  console.log(`PASS ${report.layouts.length} density/width/scale layouts; ${report.screenshots.length} screenshots; no browser exceptions`);
  console.log(`Screenshots and measured report: ${evidence}`);
  console.log('Critical path edge browser checks passed');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  await writeFile(join(evidence, 'audit-partial.json'), JSON.stringify(report, null, 2)); throw error;
} finally {
  await browser?.close(); server.kill(); await new Promise(done => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done)); await rm(temp, { recursive: true, force: true });
}
