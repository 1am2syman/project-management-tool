// Optional integration check: install Playwright for development, then run node tests/browser-structure.mjs.
// Creates its own browser and temporary SQLite database; never opens the user's projects.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-task-ui-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'structure') : join(temp, 'screenshots');
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
  const task = (id, name, level = 0) => ({ id, name, level, start, dur: 3, progress: 0, owner: '', email: '', ms: false });
  const initial = { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Procurement browser fixture', data: { tasks: [task(1, 'Commercial Procurement'), task(2, 'Sleeve'), task(3, 'Sleeve AW', 1), task(4, 'PM Connection', 1), task(5, 'CFC'), task(6, 'CFC AW', 1), task(7, 'CFC connection', 1), task(8, 'Shipping')], links: [{ id: 'l1', from: 3, to: 6, type: 'SS', lag: 0 }], collapsed: [], nextId: 9, nextLink: 2 } }] };
  await page.addInitScript((wb) => { if (!localStorage.getItem('pm-workbook-v1')) { localStorage.setItem('pm-workbook-v1', JSON.stringify(wb)); localStorage.setItem('pm-proto-v2:prefs', JSON.stringify({ auto: false, critical: true })); } }, initial);
  await page.goto(url); await page.locator('#gbody .r[data-id="8"]').waitFor();
  async function state(p = page) {
    await p.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
    return p.evaluate(async () => (await (await fetch('/api/projects')).json()).state);
  }
  const data = async (p = page) => { const s = await state(p); return s.workbook.sheets.find((sheet) => sheet.id === s.workbook.active).data; };
  const row = (id) => page.locator(`#gbody .r[data-id="${id}"]`);
  async function select(id) { await row(id).locator('[data-col=name]').click(); }
  async function key(value) { await page.keyboard.press(value); }
  async function menu(id, label) { await row(id).locator('[data-col=name]').click({ button: 'right' }); await page.getByRole('menuitem', { name: label, exact: true }).click(); }
  async function drag(id, targetId, ratio, { cancel = false, invalid = false } = {}) {
    await row(id).locator('.row-handle').waitFor({ state: 'visible' });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const handle = await row(id).locator('.row-handle').boundingBox(), target = await row(targetId).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(target.x + 115, target.y + target.height * ratio, { steps: 10 });
    await page.locator('.row-drop:not([hidden])').waitFor();
    if (invalid) assert.match(await page.locator('.row-drop').getAttribute('class'), /invalid/);
    if (cancel) await key('Escape');
    await page.mouse.up(); await page.locator('body.reordering-rows').waitFor({ state: 'detached' });
  }
  await select(2); await key('Alt+ArrowRight');
  await page.waitForFunction(() => document.querySelector('.r[data-id="2"]').getAttribute('aria-level') === '2');
  await select(5); await page.locator('[data-act=indent]').focus(); await key('Alt+ArrowRight');
  await page.waitForFunction(() => document.querySelector('.r[data-id="5"]').getAttribute('aria-level') === '2');
  assert.deepEqual((await data()).tasks.map((t) => t.level), [0, 1, 2, 2, 1, 2, 2, 0]);
  console.log('PASS nested cascades via keyboard');

  await menu(4, 'Insert milestone above');
  await page.locator('.editor').fill('Inserted approval'); await key('Enter');
  let d = await data(), inserted = d.tasks.find((t) => t.name === 'Inserted approval');
  assert(inserted.ms && inserted.level === 2); assert.equal(d.tasks[d.tasks.findIndex((t) => t.id === 4) - 1].id, inserted.id);
  await menu(3, 'Convert to milestone'); assert((await data()).tasks.find((t) => t.id === 3).ms); assert.equal((await data()).links.length, 1);
  await key('Control+z'); assert.equal((await data()).tasks.find((t) => t.id === 3).ms, false);
  await key('Control+Shift+z'); assert((await data()).tasks.find((t) => t.id === 3).ms);
  await menu(3, 'Convert to task (1 working day)'); assert.equal((await data()).tasks.find((t) => t.id === 3).dur, 1);
  await row(1).locator('[data-col=name]').click({ button: 'right' });
  assert(await page.getByRole('menuitem', { name: 'Convert to milestone', exact: true }).isDisabled()); await key('Escape');
  console.log('PASS contextual insertion and conversion with retained links and undo/redo');

  await select(4); await key('Control+Enter'); await page.locator('.editor').fill('Shortcut task');
  await key('Control+Shift+Enter'); await page.locator('.editor').fill('Shortcut milestone'); await key('Enter');
  d = await data(); assert(d.tasks.some((t) => t.name === 'Shortcut task' && !t.ms)); assert(d.tasks.some((t) => t.name === 'Shortcut milestone' && t.ms));
  await select(4); await key('Shift+F10'); await page.getByRole('menu', { name: 'Task actions' }).waitFor(); await key('End'); await key('Escape');
  console.log('PASS task/milestone shortcuts during editing and keyboard context menu');

  await row(2).locator('.tog:not(.sp)').click();
  await row(3).waitFor({ state: 'detached' });
  await drag(2, 5, 0.9);
  d = await data(); assert(d.tasks.findIndex((t) => t.id === 2) > d.tasks.findIndex((t) => t.id === 7)); assert(d.collapsed.includes(2));
  assert(d.tasks.some((t) => t.id === 3 && t.level === 2));
  await key('Control+z'); await key('Control+Shift+z');
  await row(2).locator('.tog:not(.sp)').click();
  await row(3).waitFor({ state: 'visible' });
  await drag(5, 2, 0.5); assert.equal((await data()).tasks.find((t) => t.id === 5).level, 2);
  await key('Control+z');
  let before = JSON.stringify((await data()).tasks);
  await drag(2, 3, 0.5, { invalid: true }); assert.equal(JSON.stringify((await data()).tasks), before);
  await drag(2, 5, 0.1, { cancel: true }); assert.equal(JSON.stringify((await data()).tasks), before);
  await select(8); assert.equal(await row(8).getAttribute('class').then((v) => /\bon\b/.test(v)), true);
  console.log('PASS pointer reorder, nested drop, collapsed subtree, invalid drop and Escape cancellation');

  await page.locator('#calendarbtn').click();
  const dialog = page.getByRole('dialog', { name: /Project calendar/ });
  await dialog.getByRole('button', { name: 'Mon–Fri', exact: true }).click();
  await dialog.locator('[data-holiday-date]').fill('2026-11-09');
  await dialog.locator('[data-holiday-name]').fill('Office closure'); await dialog.getByRole('button', { name: 'Add holiday', exact: true }).click();
  await dialog.locator('[data-holiday-date]').fill('2026-11-09'); await dialog.getByRole('button', { name: 'Add holiday', exact: true }).click();
  assert.match(await dialog.locator('[data-calendar-error]').textContent(), /already listed/);
  await dialog.locator('[data-holiday-date]').fill('2026-11-10'); await dialog.getByRole('button', { name: 'Add holiday', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove holiday 2026-11-10', exact: true }).click();
  for (const input of await dialog.locator('.calendar-week input').all()) await input.uncheck();
  assert(await dialog.getByRole('button', { name: 'Apply calendar', exact: true }).isDisabled());
  await dialog.getByRole('button', { name: 'Mon–Fri', exact: true }).click();
  assert.match(await dialog.locator('[data-calendar-preview]').textContent(), /will change dates/);
  assert.equal((await data()).calendar.workdays.length, 7, 'draft calendar is not saved');
  await dialog.getByRole('button', { name: 'Apply calendar', exact: true }).click();
  d = await data(); assert.deepEqual(d.calendar, { workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-09', name: 'Office closure' }] });
  assert.equal((await row(8).locator('[data-col=end]').textContent()).trim(), 'Nov 11');
  assert.equal((await row(8).locator('[data-col=dur]').textContent()).trim(), '3');
  assert.equal(await page.locator('#bg rect[fill="rgba(245,158,11,.14)"]').count(), 1);
  await key('Control+z'); assert.equal((await data()).calendar.workdays.length, 7);
  await key('Control+Shift+z'); assert.equal((await data()).calendar.workdays.length, 5);
  console.log('PASS calendar preview, duplicate holidays, validation, applying and undo/redo');

  // Actual XLSX bytes through the parser, then import mapping, and native project-file persistence.
  const roundtrip = await page.evaluate(async () => {
    const { Store } = await import('./js/model.js'); const { buildXlsx } = await import('./js/xlsx.js'); const { readSpreadsheet } = await import('./js/xlsxread.js');
    const { spreadsheetCalendars, mapSheet } = await import('./js/import.js'); const { encodeProjectFile, parseProjectFile } = await import('./js/projectfiles.js');
    const disk = (await (await fetch('/api/projects')).json()).state, s = new Store(disk);
    const blob = await buildXlsx([{ name: 'Plan calendars', store: s }]);
    const sheets = await readSpreadsheet(new File([blob], 'roundtrip.xlsx'));
    const calendars = spreadsheetCalendars(sheets), target = sheets.find((sh) => sh.rows[0]?.includes('Task'));
    const mapped = mapSheet(target, calendars.get(target.name)), computed = new Store(disk); computed.load(mapped.data);
    return { calendar: mapped.data.calendar, tasks: computed.tasks.map((t) => ({ name: t.name, dur: computed.duration(t.id) })), expected: s.tasks.map((t) => ({ name: t.name, dur: s.duration(t.id) })), nativeCalendar: parseProjectFile(encodeProjectFile(s)).data.calendar };
  });
  assert.deepEqual(roundtrip.calendar, d.calendar); assert.deepEqual(roundtrip.nativeCalendar, d.calendar); assert.deepEqual(roundtrip.tasks, roundtrip.expected);
  console.log('PASS actual Excel calendar/duration roundtrip and native project files');

  await page.locator('#calendarbtn').click();
  await page.getByRole('button', { name: 'Sun–Thu', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual((await data()).calendar, d.calendar, 'cancelled draft must not change the saved calendar');
  await page.setViewportSize({ width: 1440, height: 350 });
  await page.locator('#gx').evaluate((el) => { el.scrollTop = 0; });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const grip = await row(1).locator('.row-handle').boundingBox(), viewport = await page.locator('#gx').boundingBox();
  before = JSON.stringify((await data()).tasks);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(viewport.x + 120, viewport.y + viewport.height - 8, { steps: 10 });
  await page.waitForFunction(() => document.querySelector('#gx').scrollTop > 0);
  await key('Escape'); await page.mouse.up(); assert.equal(JSON.stringify((await data()).tasks), before);
  await page.setViewportSize({ width: 1440, height: 900 }); await select(8);
  console.log('PASS cancelled calendar draft and pointer autoscroll without changing tasks');
  await page.screenshot({ path: join(evidence, 'hierarchy.png') });
  await page.locator('#calendarbtn').click(); await page.screenshot({ path: join(evidence, 'calendar.png') }); await key('Escape');
  await page.setViewportSize({ width: 760, height: 780 }); await row(8).locator('[data-col=name]').click({ button: 'right' });
  const bounds = await page.getByRole('menu', { name: 'Task actions' }).boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 760 && bounds.y + bounds.height <= 780);
  await page.screenshot({ path: join(evidence, 'context-menu.png') }); await key('Escape');
  await state();
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fresh.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const restored = await fresh.newPage(); restored.on('pageerror', (error) => errors.push(error.message));
  await restored.goto(url); await restored.locator('#gbody .r[data-id="8"]').waitFor();
  assert.deepEqual((await data(restored)).calendar, d.calendar);
  assert.equal((await restored.locator('.r[data-id="8"] [data-col=end]').textContent()).trim(), 'Nov 11');
  await restored.keyboard.press('Control+z'); assert.equal((await data(restored)).calendar.workdays.length, 7);
  console.log('PASS narrow context-menu layout and SQLite restore into a fresh browser with undo history');
  const locked = await restored.evaluate(async () => {
    const response = await (await fetch('/api/projects')).json();
    const sheet = response.state.workbook.sheets.find((s) => s.id === response.state.workbook.active);
    sheet.readOnly = true; sheet.source = { driveId: 'fixture', itemId: 'fixture', by: 'Browser test', byEmail: '', fetchedAt: 0 };
    const result = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) });
    if (!result.ok) throw new Error('Cannot prepare read-only fixture');
    return JSON.stringify(sheet.data.tasks);
  });
  await restored.reload(); await restored.locator('#gbody .r[data-id="8"]').waitFor();
  assert.equal(await restored.locator('.row-handle').count(), 0);
  await restored.locator('.r[data-id="8"] [data-col=name]').click({ button: 'right' });
  assert.equal(await restored.locator('.task-menu button:not(:disabled)').count(), 1); assert(await restored.getByRole('menuitem', { name: 'Inspect task slack', exact: true }).isEnabled()); await restored.keyboard.press('Escape');
  await restored.locator('.r[data-id="8"] [data-col=name]').click(); await restored.keyboard.press('Control+Enter');
  assert.equal(JSON.stringify((await data(restored)).tasks), locked);
  await restored.locator('#calendarbtn').click(); assert(await restored.getByRole('button', { name: 'Apply calendar', exact: true }).isDisabled());
  await restored.keyboard.press('Escape');
  console.log('PASS read-only insertion, conversion, drag handles and calendar restrictions');
  assert.deepEqual(errors, []);
  console.log('BROWSER TASK AND CALENDAR CHECKS PASSED');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done));
  await rm(temp, { recursive: true, force: true });
}
