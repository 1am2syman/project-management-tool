// Oracle-style display methods on a real mixed-calendar chain, using an isolated database/profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-critical-ui-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'critical-path') : join(temp, 'screenshots');
await mkdir(evidence, { recursive: true });
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', temp, '--no-open', '--file-access', 'off'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stderr.on('data', chunk => { log += chunk; });
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(log)), 10000);
    server.once('exit', code => { clearTimeout(timer); no(new Error(`Server ${code}: ${log}`)); });
    server.stdout.on('data', chunk => { log += chunk; const match = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (match) { clearTimeout(timer); yes(match[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  await page.goto(url); await page.locator('#gbody .r[data-id="21"]').waitFor();
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await saved();
  await page.evaluate(async () => {
    const { Store, D } = await import('./js/model.js');
    const response = await (await fetch('/api/projects')).json(), s = new Store(response.state);
    const task = (id, name, dur, calendar) => ({ id, name, dur, calendar, start: D('2026-11-02'), ms: dur === 0, progress: 0, level: 0 });
    s.auto = true;
    s.load({ calendar: { workdays: [1, 2, 3, 4, 5], holidays: [] }, tasks: [task(1, 'Site work', 5, { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] }), task(2, 'Office review', 2), task(3, 'Handover', 0)], links: [{ id: 'l1', from: 1, to: 2, type: 'FS', lag: 0 }, { id: 'l2', from: 2, to: 3, type: 'FS', lag: 0 }] });
    s.save(); const result = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...response, state: s.savedState() }) });
    if (!result.ok) throw new Error('Cannot prepare critical-path fixture');
  });
  await page.reload(); await page.getByText('Site work', { exact: true }).first().waitFor(); await saved();
  const data = () => page.evaluate(async () => { const { state } = await (await fetch('/api/projects')).json(); return state.workbook.sheets.find(s => s.id === state.workbook.active).data; });
  const before = await data(), site = page.locator('.bar[data-id="1"]');
  assert(!(await site.getAttribute('class')).includes('critical'));
  assert.equal(await page.locator('#gbody .r[data-id="1"] [data-col=float]').textContent(), '2');
  await page.locator('#critical-target').click();
  const dialog = page.getByRole('dialog', { name: 'Critical-path target', exact: true });
  const method = dialog.getByLabel('Define critical activities as'), threshold = dialog.getByLabel('Total Float threshold (working days)');
  assert.equal(await method.inputValue(), 'float');
  await threshold.fill('-1'); await dialog.getByRole('button', { name: 'Show critical path' }).click(); assert(await dialog.getByRole('alert').isVisible());
  await method.selectOption('longest'); assert(!(await threshold.isVisible())); assert(!(await dialog.getByRole('alert').isVisible()));
  await dialog.getByLabel('Calculate critical path to').selectOption('3');
  await page.screenshot({ path: join(evidence, 'longest-path-dialog.png') });
  await dialog.getByRole('button', { name: 'Show critical path' }).click(); await saved();
  assert((await site.getAttribute('class')).includes('critical'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.bar[data-id="1"]')).backgroundColor === 'rgb(244, 63, 94)');
  assert((await page.locator('.lk[data-id="l1"]').getAttribute('class')).includes('crit'));
  assert.equal(await page.locator('#gbody .r[data-id="1"] [data-col=float]').textContent(), '2');
  assert.deepEqual(await data(), before);
  await page.locator('#gbody .r[data-id="1"] [data-col=float]').click();
  assert((await page.getByRole('dialog', { name: 'Task slack', exact: true }).textContent()).includes('On the Longest Path to Handover'));
  await page.keyboard.press('Escape'); await page.locator('[data-fit]').click();
  await page.screenshot({ path: join(evidence, 'longest-path-gantt.png') });
  await page.reload(); await site.waitFor(); assert((await site.getAttribute('class')).includes('critical'));
  await page.locator('#critical-target').click(); assert.equal(await method.inputValue(), 'longest');
  await method.selectOption('float'); await threshold.fill('1');
  await dialog.getByRole('button', { name: 'Show critical path' }).click(); await saved();
  assert(!(await site.getAttribute('class')).includes('critical'));
  await page.locator('#critical-target').click(); await threshold.fill('2');
  await dialog.getByRole('button', { name: 'Show critical path' }).click(); await saved(); assert((await site.getAttribute('class')).includes('critical'));
  await page.locator('#critical-target').click(); await method.selectOption('longest');
  await dialog.getByRole('button', { name: 'Show critical path' }).click(); await saved();
  const exports = await page.evaluate(async () => {
    const { Store } = await import('./js/model.js'), { buildXlsx } = await import('./js/xlsx.js'), { buildPdf } = await import('./js/pdf.js');
    const { readSpreadsheet } = await import('./js/xlsxread.js'), { mapSheet } = await import('./js/import.js');
    const { state } = await (await fetch('/api/projects')).json(), s = new Store(state), projects = [{ name: 'Mixed calendars', store: s.view(s.wb.active) }];
    const sheets = await readSpreadsheet(new File([await buildXlsx(projects)], 'critical.xlsx')), rows = sheets[0].rows, site = rows.find(r => r[1] === 'Site work');
    return { float: site[7], critical: site[9], method: rows[1][14], imported: mapSheet(sheets[0]).data.tasks.map(t => t.name), pdf: (await buildPdf(projects, { slack: true }).text()).includes('Critical-path method: Longest Path') };
  });
  assert.deepEqual(exports, { float: 2, critical: 'Yes', method: 'Longest Path', imported: ['Site work', 'Office review', 'Handover'], pdf: true });
  assert.deepEqual(await data(), before); assert.deepEqual(errors, []); await saved(); await context.close();
  // Database restoration with a genuinely fresh browser profile, independent of localStorage.
  const fresh = await browser.newContext({ viewport: { width: 760, height: 780 } }), next = await fresh.newPage();
  await next.goto(url); await next.locator('.bar[data-id="1"].critical').waitFor(); await next.locator('#critical-target').click();
  const restored = next.getByRole('dialog', { name: 'Critical-path target', exact: true });
  assert.equal(await restored.getByLabel('Define critical activities as').inputValue(), 'longest');
  const bounds = await restored.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 760);
  await next.screenshot({ path: join(evidence, 'longest-path-mobile.png') });
  await next.keyboard.press('Escape'); await next.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved'); await fresh.close();
  console.log('Critical path browser checks passed');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); server.kill(); await new Promise(done => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done)); await rm(temp, { recursive: true, force: true });
}
