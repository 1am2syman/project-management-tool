// Isolated interaction checks for Fit, scheduling, layout, adaptive density and connected file saves.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-fit-ui-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'fit') : join(temp, 'screenshots');
await mkdir(evidence, { recursive: true });
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', temp, '--no-open'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stderr.on('data', (chunk) => { log += chunk; });
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(log)), 10000);
    server.once('exit', (code) => { clearTimeout(timer); no(new Error(`Server ${code}: ${log}`)); });
    server.stdout.on('data', (chunk) => { log += chunk; const m = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (m) { clearTimeout(timer); yes(m[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (dialog) => { if (dialog.type() === 'beforeunload') await dialog.accept(); else await dialog.dismiss(); });
  await page.addInitScript(() => {
    window.filePicks = 0;
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan')];
    window.showSaveFilePicker = async () => { window.filePicks++; return (await navigator.storage.getDirectory()).getFileHandle('save-as.plan', { create: true }); };
  });
  await page.goto(url); await page.locator('#gbody .r[data-id="21"]').waitFor();
  await page.evaluate(async () => {
    const { Store, D } = await import('./js/model.js'), { encodeProjectFile } = await import('./js/projectfiles.js');
    const s = new Store(); s.auto = true; const day = D('2026-11-01');
    const t = (id, name, offset, dur = 1, level = 0, ms = false) => ({ id, name, level, start: day + offset, dur: ms ? 0 : dur, ms, progress: 0, owner: '' });
    s.load({ tasks: [t(1, 'Commercial Procurement', 0, 1), t(2, 'Sleeve', 12, 1, 1), t(3, 'Artwork sharing', 12, 1, 2), t(4, 'PM Connection', 30, 40, 2), t(5, 'PM QA', 84, 1, 2), t(6, 'PM Readiness', 85, 1, 2), t(7, 'RM', 78, 1, 1), t(8, 'RM transfer', 78, 8, 2), t(9, 'RM readiness', 87, 1, 2), t(10, 'FG Production Readiness', 95, 0, 1, true)], links: [{ id: 'l1', from: 3, to: 5, type: 'FS', lag: 0 }, { id: 'l2', from: 5, to: 6, type: 'FS', lag: 0 }], collapsed: [], nextId: 11, nextLink: 3 });
    s.renameSheet(s.wb.active, 'MEZ transition · Commercial Procurement & Production Launch');
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan', { create: true });
    const writable = await handle.createWritable(); await writable.write(encodeProjectFile(s)); await writable.close();
  });
  await page.locator('#openprojectbtn').click(); await page.locator('#gbody .r[data-id="10"] [data-col=name] .t').filter({ hasText: 'FG Production Readiness' }).waitFor();
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const data = async () => { await saved(); return page.evaluate(async () => { const s = (await (await fetch('/api/projects')).json()).state; return s.workbook.sheets.find((x) => x.id === s.workbook.active).data; }); };
  const row = (id) => page.locator(`#gbody .r[data-id="${id}"]`);
  async function settle() { await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))); }
  async function fitAndMeasure() {
    await page.locator('[data-fit]').click(); await settle();
    const bounds = await page.evaluate(() => {
      const v = document.querySelector('#gb').getBoundingClientRect();
      return [...document.querySelectorAll('.bar')].map((b) => ({ name: b.title, left: Math.min(b.getBoundingClientRect().left, b.querySelector('.label').getBoundingClientRect().left) - v.left, right: Math.max(b.getBoundingClientRect().right, b.querySelector('.label').getBoundingClientRect().right) - v.left, width: document.querySelector('#gb').clientWidth }));
    });
    for (const b of bounds) { assert(b.left >= -1, JSON.stringify(b)); assert(b.right <= b.width - 8, JSON.stringify(b)); }
  }
  await fitAndMeasure();
  const layout = await page.evaluate(() => {
    const r = (s) => { const a = document.querySelector(s).getBoundingClientRect(); return { top: a.top, bottom: a.bottom, width: a.width }; };
    return { brand: r('.brand'), tools: r('.tools'), status: r('#save-status'), footer: r('.sheetbar'), height: innerHeight };
  });
  assert(Math.abs(layout.brand.top - layout.tools.top) < 10); assert(layout.brand.width >= 330); assert(layout.status.top >= layout.footer.top); assert(layout.status.bottom <= layout.height);
  async function geometry() { return page.evaluate(() => { const row = document.querySelector('#gbody .r[data-id]'), bar = document.querySelector('.bar'); return { row: row.getBoundingClientRect().height, center: row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2, barCenter: bar.getBoundingClientRect().top + bar.getBoundingClientRect().height / 2, body: document.querySelector('#gb').clientHeight, canvas: document.querySelector('#canvas').clientHeight, rows: document.querySelectorAll('#gbody .r[data-id]').length }; }); }
  let g = await geometry(); assert(Math.abs(g.center - g.barCenter) < 2); assert(Math.abs(g.body - g.canvas) < g.rows + 2, JSON.stringify(g)); const tall = g.row;
  await page.setViewportSize({ width: 1920, height: 740 }); await settle(); g = await geometry(); assert(g.row < tall); assert(Math.abs(g.body - g.canvas) < g.rows + 2);
  await row(2).locator('.tog:not(.sp)').click(); await settle(); const collapsed = await geometry(); assert(collapsed.row > g.row); await row(2).locator('.tog:not(.sp)').click();
  await page.locator('[data-act=density]').click(); await settle(); assert.equal((await geometry()).row, 24); await page.locator('[data-act=density]').click();
  console.log('PASS Fit includes actual bar/summary/milestone labels; header/footer and adaptive geometry resize and collapse correctly');
  await page.locator('.bar[data-id="5"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Auto-calculate from connections', exact: true }).click();
  assert.equal((await data()).tasks.find((t) => t.id === 5).start, (await data()).tasks.find((t) => t.id === 3).start + 1);
  assert.equal(await row(5).locator('.schedule-badge').getAttribute('aria-label'), 'Auto');
  await row(6).locator('[data-col=name]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Use manual dates', exact: true }).click();
  assert.equal(await row(6).locator('.schedule-badge').getAttribute('aria-label'), 'Manual'); assert.equal(await page.locator('.bar[data-id="6"]').getAttribute('data-scheduling'), 'manual');
  await page.keyboard.press('Control+z'); assert.equal((await data()).tasks.find((t) => t.id === 6).scheduling, undefined); await page.keyboard.press('Control+Shift+z');
  await fitAndMeasure(); await page.setViewportSize({ width: 1280, height: 800 }); await settle(); await fitAndMeasure();
  await page.screenshot({ path: join(evidence, 'fit-and-modes.png') });
  console.log('PASS task and Gantt menus calculate earliest dates, show mode badges and preserve undo/redo');
  // Ctrl+S uses a genuine browser file handle (OPFS stands in for an OS-picked file).
  await row(5).locator('[data-col=name]').dblclick(); await page.locator('.editor').fill('Saved during edit'); await page.keyboard.press('Control+s');
  await page.waitForFunction(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan')).getFile()).text().then((s) => s.includes('Saved during edit')));
  assert.equal(await page.evaluate(() => window.filePicks), 0); await saved();
  await settle(); await saved(); await page.reload(); await row(5).waitFor(); await saved();
  await row(5).locator('[data-col=name]').dblclick(); await page.locator('.editor').fill('Saved after refresh'); await page.keyboard.press('Control+s');
  await page.waitForFunction(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan')).getFile()).text().then((s) => s.includes('Saved after refresh')));
  assert.equal(await page.evaluate(() => window.filePicks), 0);
  await page.keyboard.press('Control+Shift+s'); await page.waitForFunction(() => window.filePicks === 1);
  await page.waitForFunction(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('save-as.plan')).getFile()).text().then((s) => s.includes('Saved after refresh')));
  await saved(); await settle();
  await page.setViewportSize({ width: 1920, height: 1000 }); await settle(); await fitAndMeasure(); await page.screenshot({ path: join(evidence, 'header-and-density.png') });
  console.log('PASS Ctrl+S commits edits, reuses the real file handle across refresh, Ctrl+Shift+S selects another file, SQLite saves independently');
  await page.setViewportSize({ width: 1000, height: 740 }); await settle(); await fitAndMeasure();
  await page.setViewportSize({ width: 760, height: 780 }); await settle();
  await row(5).locator('[data-col=name]').click({ button: 'right' }); const m = await page.getByRole('menu', { name: 'Task actions' }).boundingBox(); assert(m.x >= 0 && m.y >= 0 && m.x + m.width <= 760 && m.y + m.height <= 780);
  assert.deepEqual(errors, []); console.log('FIT SCHEDULING SAVING AND DENSITY CHECKS PASSED');
} catch (error) { if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {}); throw error; } finally { await browser?.close(); server.kill(); await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done)); await rm(temp, { recursive: true, force: true }); }
