// Optional integration check: run node tests/browser-task-calendars.mjs with Playwright installed.
// Creates its own browser and temporary SQLite database; never opens the user's projects.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-task-calendars-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'task-calendars') : join(temp, 'screenshots');
await mkdir(evidence, { recursive: true });
const server = spawn(process.env.PYTHON || 'python3', ['-B', join(repo, 'start.py'), '--port', '0', '--data-dir', temp, '--no-open', '--file-access', 'off'], { cwd: repo, env: { ...process.env, PYTHONPATH: join(repo, 'src') }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, serverLog = '';
server.stderr.on('data', (chunk) => { serverLog += chunk; });
try {
  const url = await new Promise((yes, no) => {
    const timeout = setTimeout(() => no(new Error('Server startup timeout: ' + serverLog)), 10000);
    server.once('exit', (code) => { clearTimeout(timeout); no(new Error(`Server exited ${code}: ${serverLog}`)); });
    server.stdout.on('data', (chunk) => { serverLog += chunk; const match = serverLog.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (match) { clearTimeout(timeout); yes(match[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const start = Date.parse('2026-11-06T00:00:00Z') / 86400000;
  const task = (id, name, extra = {}) => ({ id, name, level: 0, start, dur: 1, progress: 0, owner: '', email: '', ms: false, ...extra });
  const initial = { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Mixed calendars', data: { calendar: { workdays: [1,2,3,4,5], holidays: [] }, tasks: [task(1, 'Delivery group'), task(2, 'A: Friday finish', { level: 1 }), task(3, 'B: Custom crew', { level: 1, dur: 2 }), task(4, 'Global only'), task(5, 'Crew milestone', { ms: true, dur: 0 })], links: [{ id: 'l1', from: 2, to: 3, type: 'FS', lag: 2 }], collapsed: [], nextId: 6, nextLink: 2 } }] };
  await page.addInitScript((wb) => { if (!localStorage.getItem('pm-workbook-v1')) { localStorage.setItem('pm-workbook-v1', JSON.stringify(wb)); localStorage.setItem('pm-proto-v2:prefs', JSON.stringify({ auto: true, critical: true })); } }, initial);
  await page.goto(url); await page.locator('#gbody .r[data-id="5"]').waitFor();
  async function state(p = page) {
    await p.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
    return p.evaluate(async () => (await (await fetch('/api/projects')).json()).state);
  }
  const data = async (p = page) => { const s = await state(p); return s.workbook.sheets.find((sheet) => sheet.id === s.workbook.active).data; };
  const row = (id, p = page) => p.locator(`#gbody .r[data-id="${id}"]`);
  const dialog = page.getByRole('dialog');
  async function openTask(id) { await row(id).locator('[data-col=name]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Task calendar…', exact: true }).click(); }
  async function tasksTab() { await dialog.getByRole('tab', { name: 'Task calendars', exact: true }).click(); }
  async function apply() { await dialog.locator('[data-calendar-apply]').click(); await dialog.waitFor({ state: 'detached' }); await state(); }
  await page.locator('#calendarbtn').click(); await tasksTab();
  assert.match(await dialog.textContent(), /No task calendars/); await page.keyboard.press('Escape');
  await row(1).locator('[data-col=name]').click({ button: 'right' }); assert(await page.getByRole('menuitem', { name: 'Task calendar…' }).isDisabled()); await page.keyboard.press('Escape');
  const before = await data();
  await openTask(3); assert.match(await dialog.getAttribute('aria-label'), /Task calendar.*B: Custom crew/);
  await dialog.getByRole('button', { name: 'Sun–Thu', exact: true }).click();
  assert.match(await dialog.locator('[data-calendar-preview]').textContent(), /will change dates/);
  assert.deepEqual(await data(), before); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.deepEqual(await data(), before);
  await openTask(3); await dialog.getByRole('button', { name: 'Sun–Thu', exact: true }).click();
  await dialog.locator('[data-holiday-date]').fill('2026-11-11'); await dialog.locator('[data-holiday-name]').fill('Crew closure'); await dialog.getByRole('button', { name: 'Add holiday', exact: true }).click();
  for (const input of await dialog.locator('.calendar-week input').all()) await input.uncheck();
  assert(await dialog.locator('[data-calendar-apply]').isDisabled()); await dialog.getByRole('button', { name: 'Sun–Thu', exact: true }).click();
  await page.screenshot({ path: join(evidence, 'task-editor.png') }); await apply();
  let d = await data(); assert.deepEqual(d.tasks.find((t) => t.id === 3).calendar, { workdays: [0,1,2,3,4], holidays: [{ date: '2026-11-11', name: 'Crew closure' }] });
  assert.equal(await row(3).locator('[data-col=start]').textContent(), 'Nov 10'); assert.equal(await row(3).locator('[data-col=end]').textContent(), 'Nov 12');
  assert.equal(await row(3).getByRole('img', { name: 'Custom task calendar active' }).count(), 1); assert.equal(await row(4).locator('.task-calendar-marker').count(), 0);
  await page.screenshot({ path: join(evidence, 'task-marker.png') });
  await page.keyboard.press('Control+z'); assert.equal((await data()).tasks.find((t) => t.id === 3).calendar, undefined);
  await page.keyboard.press('Control+Shift+z'); assert.deepEqual((await data()).tasks.find((t) => t.id === 3).calendar, d.tasks.find((t) => t.id === 3).calendar);
  await page.locator('#calendarbtn').click(); await tasksTab();
  assert.equal(await dialog.locator('tbody tr').count(), 1); assert.match(await dialog.locator('tbody').textContent(), /B: Custom crew/); assert.doesNotMatch(await dialog.locator('tbody').textContent(), /Global only/);
  await dialog.locator('details summary').click(); assert.match(await dialog.locator('details').textContent(), /Crew closure/);
  await page.screenshot({ path: join(evidence, 'task-calendar-table.png') });
  await dialog.getByRole('tab', { name: 'Global', exact: true }).click(); await dialog.getByRole('button', { name: 'Every day', exact: true }).click(); await apply();
  assert.deepEqual((await data()).tasks.find((t) => t.id === 3).calendar, d.tasks.find((t) => t.id === 3).calendar);
  assert.equal(await row(3).locator('[data-col=start]').textContent(), 'Nov 10');
  await page.locator('#gb .bar[data-id="5"]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Task calendar…' }).click();
  await dialog.getByRole('button', { name: 'Sun–Thu', exact: true }).click(); await apply();
  assert.equal(await row(5).locator('.task-calendar-marker').count(), 1);
  const roundtrip = await page.evaluate(async () => {
    const { Store } = await import('./js/model.js'); const { buildXlsx } = await import('./js/xlsx.js'); const { readSpreadsheet } = await import('./js/xlsxread.js');
    const { spreadsheetCalendars, mapSheet } = await import('./js/import.js'); const { encodeProjectFile, parseProjectFile } = await import('./js/projectfiles.js');
    const disk = (await (await fetch('/api/projects')).json()).state, s = new Store(disk);
    const blob = await buildXlsx([{ name: 'Plan calendars', store: s }]); const sheets = await readSpreadsheet(new File([blob], 'calendars.xlsx'));
    const calendars = spreadsheetCalendars(sheets), target = sheets.find((sh) => sh.rows[0]?.includes('Task')), mapped = mapSheet(target, calendars.get(target.name));
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.issues));
    const computed = new Store(disk); computed.load(mapped.data);
    const facts = (v) => v.tasks.map((t) => ({ name: t.name, calendar: t.calendar || null, start: v.info.get(t.id).start, end: v.info.get(t.id).end, duration: v.duration(t.id) }));
    return { actual: facts(computed), expected: facts(s), version: JSON.parse(encodeProjectFile(s)).version, native: parseProjectFile(encodeProjectFile(s)).data.tasks.map((t) => t.calendar || null) };
  });
  assert.deepEqual(roundtrip.actual, roundtrip.expected); assert.equal(roundtrip.version, 5); assert.equal(roundtrip.native.filter(Boolean).length, 2);
  await page.locator('#calendarbtn').click(); await tasksTab();
  await dialog.locator('tbody tr').filter({ hasText: 'B: Custom crew' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByRole('button', { name: 'Every day', exact: true }).click(); await tasksTab(); await dialog.locator('tbody tr').filter({ hasText: 'B: Custom crew' }).getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await dialog.locator('.calendar-week input:checked').count(), 7, 'draft retained across tabs'); await page.keyboard.press('Escape');
  await page.locator('#calendarbtn').click(); await tasksTab();
  await dialog.locator('tbody tr').filter({ hasText: 'B: Custom crew' }).getByRole('button', { name: 'Use global', exact: true }).click();
  assert.match(await dialog.textContent(), /follow future global changes/); assert((await data()).tasks.find((t) => t.id === 3).calendar); await page.keyboard.press('Escape');
  assert((await data()).tasks.find((t) => t.id === 3).calendar);
  await page.locator('#calendarbtn').click(); await tasksTab(); await dialog.locator('tbody tr').filter({ hasText: 'B: Custom crew' }).getByRole('button', { name: 'Use global', exact: true }).click(); await apply();
  assert.equal((await data()).tasks.find((t) => t.id === 3).calendar, undefined); assert.equal(await row(3).locator('.task-calendar-marker').count(), 0);
  await page.keyboard.press('Control+z'); await state(); assert.equal(await row(3).locator('.task-calendar-marker').count(), 1);
  await page.reload(); await row(5).waitFor(); assert.equal(await row(3).locator('.task-calendar-marker').count(), 1);
  await row(3).locator('[data-col=name]').click(); await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: 'Task calendar…' }).click();
  const tab = dialog.getByRole('tab', { name: 'Task calendars', exact: true }); await tab.focus(); await page.keyboard.press('ArrowLeft'); assert.equal(await dialog.getByRole('tab', { name: 'Global', exact: true }).getAttribute('aria-selected'), 'true'); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fresh.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const restored = await fresh.newPage(); restored.on('pageerror', (error) => errors.push(error.message)); await restored.goto(url); await row(5, restored).waitFor(); assert.equal(await row(3, restored).locator('.task-calendar-marker').count(), 1);
  await restored.evaluate(async () => {
    const response = await (await fetch('/api/projects')).json(), sheet = response.state.workbook.sheets.find((s) => s.id === response.state.workbook.active);
    sheet.readOnly = true; sheet.source = { driveId: 'fixture', itemId: 'fixture', by: 'Test', byEmail: '', fetchedAt: 0 };
    const result = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) }); if (!result.ok) throw new Error('Read-only fixture failed');
  });
  await restored.reload(); await row(5, restored).waitFor(); const locked = await data(restored);
  await row(3, restored).locator('[data-col=name]').click({ button: 'right' }); await restored.getByRole('menuitem', { name: 'Task calendar…', exact: true }).click();
  assert(await restored.locator('[data-calendar-apply]').isDisabled());
  for (const input of await restored.locator('.calendar-week input').all()) assert(await input.isDisabled());
  assert.match(await restored.locator('.calendar-state').textContent(), /Custom calendar/); await restored.keyboard.press('Escape');
  await restored.locator('#calendarbtn').click(); await restored.getByRole('tab', { name: 'Task calendars', exact: true }).click();
  assert.equal(await restored.getByRole('button', { name: 'Use global', exact: true }).count(), 2); for (const b of await restored.getByRole('button', { name: 'Use global', exact: true }).all()) assert(await b.isDisabled());
  await restored.getByRole('button', { name: 'Inspect', exact: true }).first().click(); assert(await restored.locator('[data-calendar-apply]').isDisabled()); await restored.keyboard.press('Escape');
  assert.deepEqual(await data(restored), locked);

  // Regression for the laptop dialog: long previews must never push actions off-screen.
  await page.evaluate(async (start) => {
    const response = await (await fetch('/api/projects')).json(), sheet = response.state.workbook.sheets.find((s) => s.id === response.state.workbook.active);
    sheet.readOnly = false; delete sheet.source;
    sheet.data = { calendar: { workdays: [1,2,3,4,5], holidays: [...Array.from({ length: 8 }, (_, i) => ({ date: `2026-12-${16 + i}`, name: `Global closure ${i + 1}` })), { date: '2026-12-25', name: 'Christmas' }] }, tasks: Array.from({ length: 18 }, (_, i) => ({ id: i + 1, name: i === 0 ? 'Custom crew — extended delivery calendar for regional production and installation teams' : `Successor ${i}`, level: 0, start, dur: 2, progress: 0, owner: '', email: '', noRem: false, scheduling: 'auto', ms: false, ...(i === 0 ? { calendar: { workdays: [0,1,2,3,4], holidays: [{ date: '2026-11-11', name: 'Crew closure' }, ...Array.from({ length: 8 }, (_, j) => ({ date: `2026-12-0${j + 1}`, name: `Crew holiday ${j + 1} with a long description of the planned regional office closure` }))] } } : {}) })), links: Array.from({ length: 17 }, (_, i) => ({ id: `l${i + 1}`, from: i + 1, to: i + 2, type: 'FS', lag: 0 })), collapsed: [], nextId: 19, nextLink: 18 };
    const result = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) }); if (!result.ok) throw new Error('Laptop fixture failed');
  }, start);
  await page.reload(); await row(18).waitFor();
  async function captureLaptop(label) {
    await dialog.locator('.calendar-panel').evaluate((panel) => { panel.scrollTop = 0; });
    const layout = await dialog.evaluate((modal) => {
      const box = modal.getBoundingClientRect();
      const heading = modal.querySelector('.calendar-preview-heading b'), panel = modal.querySelector('.calendar-panel').getBoundingClientRect();
      let feedback = true;
      if (heading) { const r = heading.getBoundingClientRect(); feedback = r.top >= panel.top && r.bottom <= panel.bottom && heading.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }
      return { feedback, fits: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
        actions: [...modal.querySelectorAll('.calendar-footer button')].map((button) => { const r = button.getBoundingClientRect(); return { text: button.textContent, visible: r.top >= box.top && r.bottom <= box.bottom && r.bottom <= innerHeight && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; }) };
    });
    assert(layout.fits, `${label}: dialog fits laptop viewport`);
    assert(layout.feedback, `${label}: preview feedback visible without scrolling`);
    for (const action of layout.actions) assert(action.visible, `${label}: ${action.text} visible without scrolling`);
    await page.screenshot({ path: join(evidence, `${label}.png`) });
  }
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport); const prefix = `laptop-${viewport.width}x${viewport.height}`;
    await page.locator('#calendarbtn').click(); await captureLaptop(`${prefix}-global`); await tasksTab(); await captureLaptop(`${prefix}-table`); await page.keyboard.press('Escape');
    const saved = await data();
    await openTask(1); assert.equal(await dialog.locator('[data-calendar-apply]').textContent(), 'Save task calendar');
    const holidaySize = await dialog.locator('[data-holiday-list]').evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight }));
    assert(holidaySize.height <= 96 && holidaySize.full > holidaySize.height, 'many holidays scroll within their own region');
    assert.equal(await dialog.locator('[data-holiday-list] .calendar-holiday').count(), 9); await captureLaptop(`${prefix}-existing`);
    for (const input of await dialog.locator('.calendar-week input').all()) await input.uncheck();
    await dialog.locator('.calendar-week input[value="6"]').check();
    const changeCount = Number((await dialog.locator('[data-calendar-preview] b').first().textContent()).match(/^\d+/)[0]);
    assert(changeCount > 8); assert.equal(await dialog.locator('.calendar-changes tbody tr').count(), changeCount, 'all affected rows are listed');
    assert.doesNotMatch(await dialog.locator('[data-calendar-preview]').textContent(), /first 8/);
    const previewSize = await dialog.locator('.calendar-changes').evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight }));
    assert(previewSize.height <= 160 && previewSize.full > previewSize.height, 'long preview scrolls inside its cap');
    await captureLaptop(`${prefix}-long-preview`);
    const lastChanged = dialog.locator('.calendar-changes tbody tr').last(); assert.match(await lastChanged.textContent(), /Successor 17/);
    await lastChanged.scrollIntoViewIfNeeded();
    const lastBox = await lastChanged.boundingBox(), previewBox = await dialog.locator('.calendar-changes').boundingBox();
    assert(lastBox.y >= previewBox.y && lastBox.y + lastBox.height <= previewBox.y + previewBox.height + 1, 'last changed row is reachable by scrolling');
    await dialog.locator('[data-holiday-date]').fill('2027-01-04'); await dialog.locator('[data-holiday-name]').fill('Unsaved draft holiday'); await dialog.locator('[data-holiday-add]').click();
    await dialog.locator('[data-calendar-inherit]').click(); assert.equal(await dialog.locator('.calendar-week input').count(), 0); assert.match(await dialog.locator('.calendar-reset').textContent(), /Christmas/); await captureLaptop(`${prefix}-reset`);
    await dialog.getByRole('button', { name: 'Back to custom calendar', exact: false }).click();
    assert.equal(await dialog.locator('.calendar-week input:checked').count(), 1); assert(await dialog.locator('.calendar-week input[value="6"]').isChecked());
    assert.equal(await dialog.getByRole('button', { name: 'Remove holiday 2027-01-04', exact: true }).count(), 1, 'returning preserves unsaved holidays');
    assert.equal(await dialog.locator('.calendar-state').textContent(), 'Custom calendar'); assert(await dialog.locator('[data-calendar-apply]').isEnabled());
    await captureLaptop(`${prefix}-returned-draft`); assert.deepEqual(await data(), saved, 'reset preview and return never save or reset the draft'); await page.keyboard.press('Escape');
    await openTask(2); assert.equal(await dialog.locator('[data-calendar-apply]').textContent(), 'Create task calendar'); assert.equal(await dialog.locator('.calendar-state').textContent(), 'Using global calendar'); await captureLaptop(`${prefix}-new`); await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('TASK CALENDAR BROWSER CHECKS PASSED');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done));
  await rm(temp, { recursive: true, force: true });
}
