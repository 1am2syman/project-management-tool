// Isolated slack UI, workday geometry, exports and display-scaling regression checks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-slack-ui-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'slack') : join(temp, 'screenshots');
await mkdir(evidence, { recursive: true });
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', temp, '--no-open', '--file-access', 'off'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stderr.on('data', (chunk) => { log += chunk; });
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(log)), 10000);
    server.once('exit', (code) => { clearTimeout(timer); no(new Error(`Server ${code}: ${log}`)); });
    server.stdout.on('data', (chunk) => { log += chunk; const m = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (m) { clearTimeout(timer); yes(m[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const newContext = async (scale = 1) => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, deviceScaleFactor: scale });
    await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    return context;
  };
  const context = await newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (dialog) => { if (dialog.type() === 'beforeunload') await dialog.accept(); else await dialog.dismiss(); });
  await page.addInitScript(() => { window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('slack.plan')]; });
  await page.goto(url); await page.locator('#gbody .r[data-id="21"]').waitFor();
  await page.evaluate(async () => {
    const { Store, D } = await import('./js/model.js'), { encodeProjectFile } = await import('./js/projectfiles.js');
    const s = new Store(); s.auto = false; const day = D('2026-11-02');
    const t = (id, name, offset, dur, level = 0) => ({ id, name, start: day + offset, dur, level, ms: dur === 0, progress: 0 });
    s.load({ tasks: [t(10, 'Installation phase', 0, 1), t(1, 'Prepare components', 0, 2, 1), t(2, 'Installation', 4, 2, 1), t(3, 'Handover', 9, 0), t(4, 'Independent work', 0, 12), t(5, 'Short task', 0, 1)], links: [{ id: 'l1', from: 1, to: 2, type: 'FS', lag: 0 }, { id: 'l2', from: 2, to: 3, type: 'FS', lag: 0 }] });
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('slack.plan', { create: true });
    const writable = await handle.createWritable(); await writable.write(encodeProjectFile(s)); await writable.close();
  });
  await page.locator('#openprojectbtn').click(); await page.getByText('Prepare components', { exact: true }).first().waitFor();
  const fixtureId = await page.locator('#tabs .tab.on').getAttribute('data-id');
  const selectFixture = target => target.locator(`#tabs .tab[data-id="${fixtureId}"]`).click();
  const row = (id) => page.locator(`#gbody .r[data-id="${id}"]`);
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const data = async () => { await saved(); return page.evaluate(async () => { const s = (await (await fetch('/api/projects')).json()).state; return s.workbook.sheets.find((x) => x.id === document.querySelector('#tabs .tab.on').dataset.id).data; }); };
  const settle = async () => { await saved(); return page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))); };
  const dialog = page.getByRole('dialog', { name: 'Task slack', exact: true });
  await row(3).locator('[data-col=name]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Use as critical-path target', exact: true }).click();
  const before = await data();
  assert.equal(await row(1).locator('[data-col=float]').textContent(), '5');
  assert.equal(await row(1).locator('[data-col=freeFloat]').textContent(), '2');
  await row(1).locator('[data-col=float]').click();
  await dialog.waitFor(); assert((await dialog.textContent()).includes('5 working days'));
  assert((await dialog.textContent()).includes('2 working days'));
  assert((await dialog.textContent()).includes('Installation (FS)'));
  assert((await dialog.textContent()).includes('Handover'));
  assert((await dialog.textContent()).includes('2026-11-07 → 2026-11-08'));
  await page.keyboard.press('Escape'); await settle();
  assert.equal(await page.locator('.slack-item').count(), 1);
  assert.equal(await page.locator('.slack-item').getAttribute('data-task'), '1');
  // Clicking the derived value and keyboard inspection both preserve editing history/dates.
  await page.keyboard.press('Enter'); await dialog.waitFor(); await page.keyboard.press('Escape');
  await row(4).locator('[data-col=float]').click(); assert((await dialog.textContent()).includes('Outside selected target')); await page.keyboard.press('Escape');
  await row(10).locator('[data-col=freeFloat]').click(); assert((await dialog.textContent()).includes('Not calculated for summary')); await page.keyboard.press('Escape');
  await row(1).locator('[data-col=name]').click(); await page.locator('#slackbtn').click();
  await dialog.getByLabel('Show slack on Gantt').selectOption('all'); await saved(); await page.keyboard.press('Escape'); await settle();
  assert((await page.locator('.slack-item').count()) > 1); assert.equal(await page.locator('.slack-overlay text').count(), 1);
  await page.locator('[data-fit]').click(); await settle();
  const fitted = await page.locator('.slack-item').evaluateAll((els) => {
    const pane = document.querySelector('#gb').getBoundingClientRect();
    return els.map((el) => { const r = el.getBoundingClientRect(); return { left: r.left - pane.left, right: r.right - pane.left, width: document.querySelector('#gb').clientWidth }; });
  });
  for (const bound of fitted) { assert(bound.left >= -1, JSON.stringify(bound)); assert(bound.right <= bound.width - 8, JSON.stringify(bound)); }
  await page.locator('#slackbtn').click(); await dialog.getByLabel('Show slack on Gantt').selectOption('off'); await saved(); await page.keyboard.press('Escape'); await settle();
  assert.equal(await page.locator('.slack-item').count(), 0);
  await page.locator('#slackbtn').click(); await dialog.getByLabel('Show slack on Gantt').selectOption('selected'); await saved(); await page.keyboard.press('Escape');
  assert.deepEqual(await data(), before);
  await page.reload(); await selectFixture(page); await row(1).waitFor(); await page.locator('#slackbtn').click();
  assert.equal(await dialog.getByLabel('Show slack on Gantt').inputValue(), 'selected'); await page.keyboard.press('Escape');
  // Slack guides never intercept a bar move; Escape restores original dates.
  await page.getByRole('combobox', { name: 'Row density' }).selectOption('compact'); await saved();
  await page.locator('#zoomseg [data-zoom="16"]').click(); await row(1).locator('[data-col=name]').click(); await settle();
  const bar = page.locator('.bar[data-id="1"]'), box = await bar.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 32, box.y + box.height / 2, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up(); assert.deepEqual(await data(), before);
  // Resize and commit then undo, with overlay recalculation during the drag.
  const resize = await bar.boundingBox();
  await page.mouse.move(resize.x + resize.width - 2, resize.y + resize.height / 2); await page.mouse.down(); await page.mouse.move(resize.x + resize.width + 15, resize.y + resize.height / 2, { steps: 5 }); await page.mouse.up();
  assert.notDeepEqual(await data(), before); await page.keyboard.press('Control+z'); assert.deepEqual(await data(), before);
  const exports = await page.evaluate(async () => {
    const { Store } = await import('./js/model.js'), { buildXlsx } = await import('./js/xlsx.js'), { buildPdf } = await import('./js/pdf.js');
    const { readSpreadsheet } = await import('./js/xlsxread.js'), { mapSheet } = await import('./js/import.js');
    const state = (await (await fetch('/api/projects')).json()).state, s = new Store(state), view = s.view(document.querySelector('#tabs .tab.on').dataset.id), projects = [{ name: 'Slack fixture', store: view }];
    const sheets = await readSpreadsheet(new File([await buildXlsx(projects)], 'slack.xlsx'));
    const rows = sheets[0].rows, headings = rows[0], a = rows.find((r) => r[1] === 'Prepare components');
    const pdf = await buildPdf(projects, { slack: true }).text(), plainPdf = await buildPdf(projects).text();
    return { total: a[headings.indexOf('Total slack (workdays)')], free: a[headings.indexOf('Free slack (workdays)')], target: headings[headings.indexOf('Critical-path target') + 1], names: mapSheet(sheets[0]).data.tasks.map((t) => t.name), pdf: pdf.includes('Total / Free slack: working days') && pdf.includes('Critical-path target: Handover'), plain: plainPdf.includes('Total / Free slack: working days') };
  });
  assert.equal(exports.total, 5); assert.equal(exports.free, 2); assert.equal(exports.target, 'Handover');
  assert.deepEqual(exports.names, before.tasks.map((t) => t.name)); assert(exports.pdf); assert(!exports.plain);
  await page.locator('#expbtn').click(); assert(await page.getByLabel('Include slack columns in PDF').isChecked());
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'PDF · this sheet', exact: false }).click();
  assert((await download).suggestedFilename().endsWith('.pdf'));
  assert.deepEqual(errors, []); await saved(); await context.close();
  // Fresh profiles prove database restoration and exercise actual device pixel ratios.
  for (const scale of [1, 1.5, 2]) {
    const scaledContext = await newContext(scale), scaled = await scaledContext.newPage(); await scaled.goto(url); await selectFixture(scaled); await scaled.locator('#gbody .r[data-id="1"]').waitFor();
    await scaled.locator('#gbody .r[data-id="1"] [data-col=name]').click();
    for (const density of ['compact', 'auto']) {
      await scaled.getByRole('combobox', { name: 'Row density' }).selectOption(density); await scaled.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
      await scaled.locator('[data-fit]').click();
      await scaled.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      assert.equal(await scaled.locator('.slack-item').count(), 1);
      const geometry = await scaled.locator('.slack-item[data-task="1"]').evaluate((el) => {
        const tail = el.querySelector('.slack-free').getBoundingClientRect(), row = document.querySelector('#gbody .r[data-id="1"]'), bar = document.querySelector('.bar[data-id="1"]'), r = row.getBoundingClientRect(), b = bar.getBoundingClientRect();
        return { row: (r.top + r.bottom) / 2, bar: (b.top + b.bottom) / 2, guide: (tail.top + tail.bottom) / 2, start: tail.left - b.right, dashed: getComputedStyle(el.querySelector('.slack-total')).strokeDasharray, pointer: getComputedStyle(el.closest('svg')).pointerEvents };
      });
      assert(Math.abs(geometry.row - geometry.bar) < 2); assert(Math.abs(geometry.guide - geometry.bar) < 2); assert(Math.abs(geometry.start) < 2, JSON.stringify(geometry)); assert.notEqual(geometry.dashed, 'none'); assert.equal(geometry.pointer, 'none');
      await scaled.screenshot({ path: join(evidence, `slack-${scale}-${density}.png`) });
    }
    await scaled.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved'); await scaledContext.close();
  }
  const lastContext = await newContext(), last = await lastContext.newPage(); await last.goto(url); await selectFixture(last); await last.locator('#gbody .r[data-id="1"]').waitFor();
  await last.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await last.evaluate(async () => {
    const { changesBetween } = await import('./js/changes.js');
    const response = await (await fetch('/api/projects')).json(), original = structuredClone(response.state), sheet = response.state.workbook.sheets.find((s) => s.id === document.querySelector('#tabs .tab.on').dataset.id);
    sheet.readOnly = true; sheet.source = { driveId: 'fixture', itemId: 'fixture', by: 'Browser test', byEmail: '', fetchedAt: 0 };
    const result = await fetch('/api/projects/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: response.revision, changes: changesBetween(original, response.state) }) });
    if (!result.ok) throw new Error('Cannot prepare read-only fixture');
  });
  await last.reload(); await selectFixture(last); await last.locator('#gbody .r[data-id="1"] [data-col=float]').click();
  assert((await last.getByRole('dialog', { name: 'Task slack', exact: true }).textContent()).includes('5 working days'));
  await last.keyboard.press('Escape');
  await last.setViewportSize({ width: 760, height: 780 }); await last.locator('#slackbtn').click();
  const modalBounds = await last.getByRole('dialog', { name: 'Task slack', exact: true }).boundingBox(); assert(modalBounds.x >= 0 && modalBounds.x + modalBounds.width <= 760);
  await last.keyboard.press('Escape'); await last.setViewportSize({ width: 1920, height: 1000 });
  // An inconsistent manual schedule must show the negative local allowance and warning.
  await last.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await last.evaluate(async () => {
    const { changesBetween } = await import('./js/changes.js');
    const response = await (await fetch('/api/projects')).json(), original = structuredClone(response.state), sheet = response.state.workbook.sheets.find((s) => s.id === document.querySelector('#tabs .tab.on').dataset.id);
    sheet.data.tasks.find((t) => t.id === 2).start = sheet.data.tasks.find((t) => t.id === 1).start;
    const result = await fetch('/api/projects/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: response.revision, changes: changesBetween(original, response.state) }) });
    if (!result.ok) throw new Error('Cannot prepare violated fixture');
  });
  await last.reload(); await selectFixture(last); await last.locator('#gbody .r[data-id="1"] [data-col=freeFloat]').click();
  const lastDialog = last.getByRole('dialog', { name: 'Task slack', exact: true });
  assert((await lastDialog.textContent()).includes('-2 working days')); assert((await lastDialog.textContent()).includes('violated dependency'));
  await last.screenshot({ path: join(evidence, 'slack-conflict-details.png') }); await last.keyboard.press('Escape');
  await last.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await last.evaluate(async () => {
    const { D } = await import('./js/model.js');
    const { changesBetween } = await import('./js/changes.js');
    const response = await (await fetch('/api/projects')).json(), original = structuredClone(response.state), sheet = response.state.workbook.sheets.find((s) => s.id === document.querySelector('#tabs .tab.on').dataset.id);
    const first = sheet.data.tasks.find((t) => t.id === 1), milestone = sheet.data.tasks.find((t) => t.id === 3);
    sheet.data.tasks = [{ ...first, level: 0, start: D('2026-11-06'), dur: 3 }, { ...milestone, start: D('2026-11-20') }];
    sheet.data.links = [{ id: 'l1', from: 1, to: 3, type: 'FS', lag: 0 }];
    sheet.data.calendar = { workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-09', name: 'Closure' }] };
    const result = await fetch('/api/projects/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: response.revision, changes: changesBetween(original, response.state) }) });
    if (!result.ok) throw new Error('Cannot prepare working-calendar fixture');
  });
  await last.reload(); await selectFixture(last); await last.locator('#gbody .r[data-id="1"] [data-col=float]').click();
  assert((await lastDialog.textContent()).includes('6 working days')); assert((await lastDialog.textContent()).includes('2026-11-17 → 2026-11-19'));
  await last.screenshot({ path: join(evidence, 'slack-workday-details.png') }); await last.keyboard.press('Escape');
  await last.locator('[data-fit]').click();
  // Tails end at the working-calendar latest finish (Thu Nov 19), just before the Nov 20 milestone.
  const ends = await last.evaluate(() => { const tail = document.querySelector('.slack-item[data-task="1"] rect').getBoundingClientRect(), ms = document.querySelector('.bar[data-id="3"]').getBoundingClientRect(), label = document.querySelector('.slack-item[data-task="1"] text'); return { tail: tail.right, milestone: (ms.left + ms.right) / 2, label: label?.textContent }; });
  assert(Math.abs(ends.tail - ends.milestone) < 3, JSON.stringify(ends)); assert.equal(ends.label, '6d slack');
  await last.screenshot({ path: join(evidence, 'slack-workday-gantt.png') });
  await lastContext.close();
  console.log('Slack browser checks passed');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); server.kill(); await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done)); await rm(temp, { recursive: true, force: true });
}
