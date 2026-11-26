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
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (dialog) => { if (dialog.type() === 'beforeunload') await dialog.accept(); else await dialog.dismiss(); });
  await page.addInitScript(() => {
    window.filePicks = 0;
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan')];
    window.showSaveFilePicker = async () => { const handle = await (await navigator.storage.getDirectory()).getFileHandle('save-as.plan', { create: true }); window.filePicks++; return handle; };
  });
  await page.goto(url); await page.locator('#gbody .r[data-id="21"]').waitFor();
  await page.evaluate(async () => {
    const { Store, D } = await import('./js/model.js'), { encodeProjectFile } = await import('./js/projectfiles.js');
    const s = new Store(); s.auto = false; const day = D('2026-11-01');
    const t = (id, name, offset, dur = 1, level = 0, ms = false) => ({ id, name, level, start: day + offset, dur: ms ? 0 : dur, ms, progress: 0, owner: '' });
    s.load({ tasks: [t(1, 'Commercial Procurement', 0, 1), t(2, 'Sleeve', 12, 1, 1), t(3, 'Artwork sharing', 12, 1, 2), t(4, 'PM Connection', 30, 40, 2), t(5, 'PM QA', 84, 1, 2), t(6, 'PM Readiness', 85, 1, 2), t(7, 'RM', 78, 1, 1), t(8, 'RM transfer', 78, 8, 2), t(9, 'RM readiness', 87, 1, 2), t(10, 'FG Production Readiness', 95, 0, 1, true)], links: [{ id: 'l1', from: 3, to: 5, type: 'FS', lag: 0 }, { id: 'l2', from: 5, to: 6, type: 'FS', lag: 0 }], collapsed: [], nextId: 11, nextLink: 3 });
    s.renameSheet(s.wb.active, 'MEZ transition · Commercial Procurement & Production Launch');
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan', { create: true });
    const writable = await handle.createWritable(); await writable.write(encodeProjectFile(s)); await writable.close();
  });
  await page.locator('#openprojectbtn').click(); await page.locator('#gbody .r[data-id="10"] [data-col=name] .t').filter({ hasText: 'FG Production Readiness' }).waitFor();
  let fixtureId = await page.locator('#tabs .tab.on').getAttribute('data-id');
  const selectFixture = async (target = page) => { await target.locator(`#tabs .tab[data-id="${fixtureId}"]`).click(); };
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const data = async () => { await saved(); return page.evaluate(async () => { const s = (await (await fetch('/api/projects')).json()).state; return s.workbook.sheets.find((x) => x.id === document.querySelector('#tabs .tab.on').dataset.id).data; }); };
  const row = (id) => page.locator(`#gbody .r[data-id="${id}"]`);
  async function settle() { await saved(); await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))); }
  async function fitAndMeasure() {
    await page.locator('[data-fit]').click(); await settle();
    const bounds = await page.evaluate(() => {
      const v = document.querySelector('#gb').getBoundingClientRect();
      return [...document.querySelectorAll('.bar')].map((b) => ({ name: b.getAttribute('aria-label') || b.dataset.id, left: Math.min(b.getBoundingClientRect().left, b.querySelector('.label').getBoundingClientRect().left) - v.left, right: Math.max(b.getBoundingClientRect().right, b.querySelector('.label').getBoundingClientRect().right) - v.left, width: document.querySelector('#gb').clientWidth }));
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
  const density = page.getByRole('combobox', { name: 'Row density' });
  await density.selectOption('compact'); await settle(); assert.equal((await geometry()).row, 24);
  await density.selectOption('auto'); await saved();
  console.log('PASS Fit includes actual bar/summary/milestone labels; header/footer and adaptive geometry resize and collapse correctly');
  assert.equal(await row(5).locator('.schedule-badge').getAttribute('aria-label'), 'Auto paused');
  const paused = (await data()).tasks.find((t) => t.id === 5).start;
  await page.locator('label.switch').filter({ has: page.locator('#optAuto') }).click();
  assert((await data()).tasks.find((t) => t.id === 5).start < paused, 'global toggle pulls default Auto tasks earlier');
  assert.equal(await row(5).locator('.schedule-badge').getAttribute('aria-label'), 'Auto');
  const calculated = (await data()).tasks.find((t) => t.id === 5).start;
  await page.locator('label.switch').filter({ has: page.locator('#optAuto') }).click();
  await row(3).locator('[data-col=start]').dblclick(); await page.locator('.editor').fill('2026-11-10'); await page.keyboard.press('Enter');
  assert.equal((await data()).tasks.find((t) => t.id === 5).start, calculated, 'toggle off pauses dependency updates');
  await page.locator('label.switch').filter({ has: page.locator('#optAuto') }).click();
  assert.equal((await data()).tasks.find((t) => t.id === 5).start, calculated - 3);
  await row(3).locator('[data-col=start]').dblclick(); await page.locator('.editor').fill('2026-11-20'); await page.keyboard.press('Enter');
  assert.equal((await data()).tasks.find((t) => t.id === 5).start, calculated + 7, 'Auto follows a later predecessor');
  await row(3).locator('[data-col=name]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Auto-calculate from connections', exact: true }).click(); await settle();
  assert.equal(await row(3).locator('.schedule-badge').getAttribute('aria-label'), 'Auto', 'a root can return to Auto without predecessors');
  await page.locator('.bar[data-id="5"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Use date anchor', exact: true }).click(); await settle();
  assert.equal(await row(5).locator('.schedule-badge').getAttribute('aria-label'), 'Date anchor');
  await row(5).locator('[data-col=start]').dblclick(); await page.locator('.editor').fill('2026-12-20'); await page.keyboard.press('Enter'); await settle();
  await page.locator('.bar[data-id="5"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Auto-calculate from connections', exact: true }).click(); await settle();
  assert.equal((await data()).tasks.find((t) => t.id === 5).start, (await data()).tasks.find((t) => t.id === 3).start + 1);
  assert.equal(await row(5).locator('.schedule-badge').getAttribute('aria-label'), 'Auto');
  await row(6).locator('[data-col=name]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Use manual dates', exact: true }).click(); await settle();
  assert.equal(await row(6).locator('.schedule-badge').getAttribute('aria-label'), 'Manual'); assert.equal(await page.locator('.bar[data-id="6"]').getAttribute('data-scheduling'), null);
  await page.keyboard.press('Control+z'); assert.equal((await data()).tasks.find((t) => t.id === 6).scheduling, 'auto'); await page.keyboard.press('Control+Shift+z');
  await fitAndMeasure(); await page.setViewportSize({ width: 1280, height: 800 }); await settle(); await fitAndMeasure();
  await page.screenshot({ path: join(evidence, 'fit-and-modes.png') });
  console.log('PASS task and Gantt menus calculate earliest dates, show mode badges and preserve undo/redo');
  // Ctrl+S uses a genuine browser file handle (OPFS stands in for an OS-picked file).
  await row(5).locator('[data-col=name]').dblclick(); await page.locator('.editor').fill('Saved during edit'); await page.keyboard.press('Control+s');
  await page.waitForFunction(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan')).getFile()).text().then((s) => s.includes('Saved during edit')));
  assert.equal(await page.evaluate(() => window.filePicks), 0); await saved();
  await settle(); await saved(); await page.reload(); await selectFixture(); await row(5).waitFor(); await saved();
  await row(5).locator('[data-col=name]').dblclick(); await page.locator('.editor').fill('Saved after refresh'); await page.keyboard.press('Control+s');
  await page.waitForFunction(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan')).getFile()).text().then((s) => s.includes('Saved after refresh')));
  assert.equal(await page.evaluate(() => window.filePicks), 0);
  await page.waitForFunction(() => !document.querySelector('#saveprojectbtn').disabled);
  await page.keyboard.press('Control+Shift+s'); await page.waitForFunction(() => window.filePicks === 1);
  await page.waitForFunction(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('save-as.plan')).getFile()).text().then((s) => s.includes('Saved after refresh')));
  await saved(); await settle();
  await page.setViewportSize({ width: 1920, height: 1000 }); await settle(); await fitAndMeasure(); await page.screenshot({ path: join(evidence, 'header-and-density.png') });
  console.log('PASS Ctrl+S commits edits, reuses the real file handle across refresh, Ctrl+Shift+S selects another file, SQLite saves independently');
  await page.setViewportSize({ width: 1000, height: 740 }); await settle(); await fitAndMeasure();
  await page.setViewportSize({ width: 760, height: 780 }); await settle();
  await row(5).locator('[data-col=name]').click({ button: 'right' }); const m = await page.getByRole('menu', { name: 'Task actions' }).boundingBox(); assert(m.x >= 0 && m.y >= 0 && m.x + m.width <= 760 && m.y + m.height <= 780);
  await page.keyboard.press('Escape');
  async function responsiveLayout(width, zoom = 1) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((factor) => { document.documentElement.style.zoom = String(factor); }, zoom);
    await settle(); await settle();
    const measured = await page.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; };
      const strip = document.querySelector('.strip');
      return {
        buttons: [...document.querySelectorAll('.tools button')].map(rect),
        toolbar: rect(document.querySelector('.topbar')),
        toolsOverflow: document.querySelector('.tools').scrollWidth - document.querySelector('.tools').clientWidth,
        auto: rect(document.querySelector('#optAuto').closest('label')),
        zoom: rect(document.querySelector('#zoomseg')),
        density: rect(document.querySelector('#density')),
        switches: [...strip.querySelectorAll('label.switch')].map(rect),
        strip: rect(strip), overflow: strip.scrollWidth - strip.clientWidth,
        formula: rect(document.querySelector('.fbar')),
        row: rect(document.querySelector('#gbody .r[data-id]')),
        bar: rect(document.querySelector('.bar')),
        labelsHidden: [...document.querySelectorAll('.tools .tool-label')].every((el) => getComputedStyle(el).display === 'none'),
      };
    });
    const description = JSON.stringify({ width, zoom, measured });
    assert(Math.max(...measured.buttons.map((b) => b.top)) - Math.min(...measured.buttons.map((b) => b.top)) < 1, description);
    assert(measured.toolsOverflow <= 1, description);
    if (width / zoom <= 1550) assert(measured.labelsHidden, description);
    assert(measured.overflow <= 1, description);
    for (const label of measured.switches) {
      assert(label.left >= measured.strip.left && label.right <= measured.strip.right + 1, description);
      assert(label.top >= measured.strip.top && label.bottom <= measured.strip.bottom + 1, description);
    }
    assert(Math.abs(measured.formula.bottom - measured.strip.bottom) < 1, description);
    if (width === 1630 && zoom === 1) {
      assert(Math.abs(measured.auto.top - measured.zoom.top) < 1, `Auto-schedule must stay on the first row: ${description}`);
      assert(Math.abs(measured.density.top - measured.zoom.top) <= 1, description);
    }
    assert(Math.abs((measured.row.top + measured.row.bottom) / 2 - (measured.bar.top + measured.bar.bottom) / 2) < 2 * zoom, description);
  }
  // A 789px timeline matches the cropped toolbar in the wrapping regression.
  for (const mode of ['compact', 'auto']) { await density.selectOption(mode); await responsiveLayout(1630); }
  await page.screenshot({ path: join(evidence, 'density-single-row.png') });
  for (const width of [1920, 1440, 1280, 1000, 760]) await responsiveLayout(width);
  await page.screenshot({ path: join(evidence, 'toolbar-760.png') });
  for (const zoom of [1.25, 1.5, 2]) await responsiveLayout(1440, zoom);
  await page.screenshot({ path: join(evidence, 'toolbar-zoom-200.png') });
  await responsiveLayout(1440);
  // A dragged splitter changes the available control width independently of the viewport.
  await page.evaluate(() => document.documentElement.style.setProperty('--gridw', '1050px'));
  await settle(); await settle();
  const auto = await page.locator('#optAuto').evaluate((el) => { const a = el.closest('label').getBoundingClientRect(), b = document.querySelector('.strip').getBoundingClientRect(); return { left: a.left, right: a.right, paneLeft: b.left, paneRight: b.right }; });
  assert(auto.left >= auto.paneLeft && auto.right <= auto.paneRight, JSON.stringify(auto));
  await page.screenshot({ path: join(evidence, 'toolbar-narrow-timeline.png') });
  assert.equal(await page.locator('.schedule-legend').count(), 0);
  const decorations = await page.locator('.bar:not(.summary)').evaluateAll((bars) => bars.map((bar) => ({ border: getComputedStyle(bar).borderBottomWidth, mark: getComputedStyle(bar, '::after').content })));
  for (const decoration of decorations) { assert.equal(decoration.border, '0px'); assert(['none', 'normal'].includes(decoration.mark)); }
  assert.equal(await row(5).locator('.schedule-badge').getAttribute('aria-label'), 'Auto');
  assert.equal(await row(6).locator('.schedule-badge').getAttribute('aria-label'), 'Manual');
  console.log('PASS toolbar stays in one row, uses icons at narrow widths, preserves full switch labels at 125–200% zoom and narrow split, and leaves scheduling badges only in the sheet');
  // An earliest milestone needs extra room for a start-to-start elbow to its left.
  await page.setViewportSize({ width: 1920, height: 740 });
  await page.evaluate(async () => {
    document.documentElement.style.setProperty('--gridw', '840px');
    const { Store, D } = await import('./js/model.js'), { encodeProjectFile } = await import('./js/projectfiles.js');
    const s = new Store(), start = D('2026-11-01'); s.auto = false;
    const task = (id, name, offset, dur, ms = false) => ({ id, name, start: start + offset, dur, ms, level: 0, progress: 0, owner: '' });
    s.load({ tasks: [task(1, 'Start gate', 0, 0, true), task(2, 'Parallel work', 0, 120), task(3, 'Finish gate', 120, 0, true)], links: [{ id: 'l1', from: 1, to: 2, type: 'SS', lag: 0 }], collapsed: [], nextId: 4, nextLink: 2 });
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan');
    const writable = await handle.createWritable(); await writable.write(encodeProjectFile(s)); await writable.close();
  });
  await page.locator('#openprojectbtn').click(); await page.locator('.bar[data-id="1"]').filter({ hasText: 'Start gate' }).waitFor();
  fixtureId = await page.locator('#tabs .tab.on').getAttribute('data-id');
  for (const mode of ['compact', 'auto']) {
    await density.selectOption(mode); await fitAndMeasure();
    const linkBounds = await page.locator('.lk[data-id="l1"] .vis').evaluate((path) => {
      const r = path.getBoundingClientRect(), viewport = document.querySelector('#gb').getBoundingClientRect();
      return { left: r.left - viewport.left, right: r.right - viewport.left, width: document.querySelector('#gb').clientWidth };
    });
    assert(linkBounds.left >= 6, `Start-to-start elbow is clipped in ${mode}: ${JSON.stringify(linkBounds)}`);
    assert(linkBounds.right <= linkBounds.width - 6, JSON.stringify(linkBounds));
    const handle = await page.locator('.bar[data-id="1"] .dot.s').boundingBox(), viewport = await page.locator('#gb').boundingBox();
    assert(handle.x - viewport.x >= 6, `Milestone start handle is clipped in ${mode}: ${JSON.stringify({ handle, viewport })}`);
  }
  await page.screenshot({ path: join(evidence, 'start-to-start-fit.png') });
  await density.selectOption('compact'); await page.setViewportSize({ width: 1920, height: 240 }); await settle();
  const scrollbars = await page.locator('#gx, #gb').evaluateAll((panes) => panes.map((pane) => ({
    id: pane.id, vertical: pane.offsetWidth - pane.clientWidth, horizontal: pane.offsetHeight - pane.clientHeight,
    overflows: pane.scrollHeight > pane.clientHeight || pane.scrollWidth > pane.clientWidth,
  })));
  for (const bar of scrollbars) { assert(bar.overflows, JSON.stringify(bar)); assert(bar.vertical <= 6 && bar.horizontal <= 6, `Scrollbar is too thick: ${JSON.stringify(bar)}`); }
  console.log('PASS Fit keeps milestone start-to-start elbows inside the chart in both densities; sheet and Gantt scrollbars are at most 6px');
  // Targeted critical paths exclude an independent later licence branch.
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.evaluate(async () => {
    const { Store, D } = await import('./js/model.js'), { encodeProjectFile } = await import('./js/projectfiles.js');
    const s = new Store(); s.auto = false; const start = D('2026-11-02');
    const task = (id, name, offset, dur) => ({ id, name, start: start + offset, dur, ms: dur === 0, level: 0, progress: 0 });
    s.load({ tasks: [task(1, 'Shared preparation', 0, 2), task(2, 'Production setup', 2, 3), task(3, 'FG Production Readiness', 5, 0), task(4, 'Licence processing', 2, 12), task(5, 'Independent work', 0, 1), task(6, 'Licence received', 14, 0)], links: [{ id: 'l1', from: 1, to: 2, type: 'FS', lag: 0 }, { id: 'l2', from: 2, to: 3, type: 'FS', lag: 0 }, { id: 'l3', from: 1, to: 4, type: 'FS', lag: 0 }, { id: 'l4', from: 4, to: 6, type: 'FS', lag: 0 }], collapsed: [], nextId: 7, nextLink: 5 });
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('fixture.plan');
    const writable = await handle.createWritable(); await writable.write(encodeProjectFile(s)); await writable.close();
  });
  await page.locator('#openprojectbtn').click(); await row(3).filter({ hasText: 'FG Production Readiness' }).waitFor();
  fixtureId = await page.locator('#tabs .tab.on').getAttribute('data-id');
  await fitAndMeasure();
  const beforeTarget = await data();
  const criticalIds = async () => { await settle(); return page.locator('.bar.critical:not(.summary)').evaluateAll((bars) => bars.map((b) => Number(b.dataset.id)).sort((a, b) => a - b)); };
  assert.deepEqual(await criticalIds(), [1, 4, 6]);
  const targetButton = page.locator('#critical-target');
  await targetButton.click();
  const targetDialog = page.getByRole('dialog', { name: 'Critical-path target', exact: true });
  await targetDialog.getByLabel('Calculate critical path to').selectOption('3');
  await page.screenshot({ path: join(evidence, 'critical-target-dialog.png') });
  await targetDialog.getByRole('button', { name: 'Show critical path', exact: true }).click();
  assert.deepEqual(await criticalIds(), [1, 2, 3]);
  assert.deepEqual(await data(), beforeTarget, 'target selection must not change tasks, links or dates');
  assert.equal(await row(4).locator('[data-col=float]').textContent(), '·');
  assert((await page.locator('#stat').textContent()).includes('FG Production Readiness'));
  assert((await targetButton.getAttribute('aria-label')).includes('FG Production Readiness'));
  const exportCheck = await page.evaluate(async () => {
    const { Store } = await import('./js/model.js'), { buildXlsx } = await import('./js/xlsx.js');
    const { readSpreadsheet } = await import('./js/xlsxread.js'), { mapSheet } = await import('./js/import.js');
    const { buildPdf } = await import('./js/pdf.js');
    const disk = (await (await fetch('/api/projects')).json()).state, s = new Store(disk), view = s.view(document.querySelector('#tabs .tab.on').dataset.id);
    const sheets = await readSpreadsheet(new File([await buildXlsx([{ name: 'Targeted plan', store: view }])], 'targeted.xlsx'));
    const rows = sheets[0].rows, mapped = mapSheet(sheets[0]);
    return { label: rows[0][13], target: rows[0][14], productionCritical: rows.find((r) => r[1] === 'Production setup')[9], licenceCritical: rows.find((r) => r[1] === 'Licence processing')[9], licenceFloat: rows.find((r) => r[1] === 'Licence processing')[7], importedNames: mapped.data.tasks.map((t) => t.name), pdfLabeled: (await buildPdf([{ name: 'Targeted plan', store: view }]).text()).includes('Critical-path target: FG Production Readiness') };
  });
  assert.equal(exportCheck.label, 'Critical-path target'); assert.equal(exportCheck.target, 'FG Production Readiness');
  assert.equal(exportCheck.productionCritical, 'Yes'); assert(!exportCheck.licenceCritical); assert(!exportCheck.licenceFloat);
  assert.deepEqual(exportCheck.importedNames, beforeTarget.tasks.map((t) => t.name)); assert(exportCheck.pdfLabeled);
  console.log('PASS PDF/Excel label the selected target; exported critical/float values match the view and Excel re-import preserves task rows');
  for (const mode of ['compact', 'auto']) { await density.selectOption(mode); await responsiveLayout(1630); }
  await page.screenshot({ path: join(evidence, 'critical-target-selected.png') });
  await saved(); await page.reload(); await selectFixture(); await row(3).waitFor(); await saved();
  assert.deepEqual(await criticalIds(), [1, 2, 3]);
  assert((await targetButton.getAttribute('aria-label')).includes('FG Production Readiness'));
  // A second profile reads the saved choice from SQLite, with no localStorage migration.
  const freshContext = await browser.newContext({ viewport: { width: 1920, height: 900 } });
  await freshContext.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const freshPage = await freshContext.newPage(); await freshPage.goto(url); await selectFixture(freshPage);
  await freshPage.locator('#gbody .r[data-id="3"]').waitFor();
  assert((await freshPage.locator('#critical-target').getAttribute('aria-label')).includes('FG Production Readiness'));
  assert.deepEqual(await freshPage.locator('.bar.critical:not(.summary)').evaluateAll((bars) => bars.map((b) => Number(b.dataset.id)).sort((a, b) => a - b)), [1, 2, 3]);
  await freshContext.close();
  await row(3).locator('[data-col=name]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Use project completion for critical path', exact: true }).click();
  assert.deepEqual(await criticalIds(), [1, 4, 6]);
  await page.locator('.bar[data-id="3"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Use as critical-path target', exact: true }).click();
  assert.deepEqual(await criticalIds(), [1, 2, 3]);
  await targetButton.click(); await targetDialog.getByLabel('Calculate critical path to').selectOption('');
  await targetDialog.getByRole('button', { name: 'Show critical path', exact: true }).click();
  assert.deepEqual(await criticalIds(), [1, 4, 6]);
  assert.deepEqual(await data(), beforeTarget);
  console.log('PASS milestone target scopes critical bars and float, preserves dates, restores from SQLite across profiles and clears through toolbar and context menus without toolbar wrapping');
  assert.deepEqual(errors, []); console.log('FIT SCHEDULING SAVING AND DENSITY CHECKS PASSED');
} catch (error) { if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {}); throw error; } finally { await browser?.close(); server.kill(); await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done)); await rm(temp, { recursive: true, force: true }); }
