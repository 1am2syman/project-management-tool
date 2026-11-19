// Isolated browser checks for project versions: snapshot, dropdown, read-only preview,
// restore, copy, rename/delete, .plan round-trip and the version analysis overlay with exports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-versions-ui-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'versions') : join(temp, 'screenshots');
await mkdir(evidence, { recursive: true });
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', join(temp, 'data'), '--no-open', '--file-access', 'off'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stderr.on('data', (chunk) => { log += chunk; });
const LOCK = 'You are viewing a saved version. Return to Current to edit.';
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(log)), 10000);
    server.once('exit', (code) => { clearTimeout(timer); no(new Error(`Server ${code}: ${log}`)); });
    server.stdout.on('data', (chunk) => { log += chunk; const m = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (m) { clearTimeout(timer); yes(m[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], confirms = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (dialog) => { if (dialog.type() === 'confirm') confirms.push(dialog.message()); if (dialog.type() === 'confirm' || dialog.type() === 'beforeunload') await dialog.accept(); else await dialog.dismiss(); });
  await page.addInitScript(() => {
    const dir = () => navigator.storage.getDirectory();
    window.showSaveFilePicker = async () => (await dir()).getFileHandle('versions.plan', { create: true });
    window.showOpenFilePicker = async () => [await (await dir()).getFileHandle('versions.plan')];
  });
  await page.goto(url); await page.locator('#gbody .r[data-id="21"]').waitFor();

  const row = (id) => page.locator(`#gbody .r[data-id="${id}"]`);
  const cell = (id, col) => row(id).locator(`[data-col=${col}]`);
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const server_ = async () => { await saved(); return page.evaluate(async () => (await (await fetch('/api/projects')).json()).state); };
  const active = async () => { const s = await server_(); return s.workbook.sheets.find((x) => x.id === s.workbook.active); };
  const toast = async (text) => page.waitForFunction((t) => document.querySelector('#toast').textContent.includes(t), text);
  const edit = async (id, col, value) => { await cell(id, col).dblclick(); await page.locator('.editor').fill(value); await page.keyboard.press('Enter'); await settle(); };
  const menu = page.locator('#versionmenu'), banner = page.locator('#verbanner');
  const pick = async (label) => { await page.locator('#versionbtn').click(); await menu.waitFor(); await menu.locator('.vrow', { hasText: label }).first().click(); await settle(); };
  const snapshot = async (name, note = '') => {
    await page.locator('#snapshotbtn').click();
    const dialog = page.getByRole('dialog', { name: 'Save version' }); await dialog.waitFor();
    await dialog.locator('#vname').fill(name); if (note) await dialog.locator('#vnote').fill(note);
    await dialog.getByRole('button', { name: 'Save version' }).click(); await dialog.waitFor({ state: 'detached' });
  };

  // ---------- snapshot ----------
  assert.equal(await page.locator('#versionlbl').textContent(), 'Current');
  await page.locator('#snapshotbtn').click();
  const first = page.getByRole('dialog', { name: 'Save version' });
  assert.equal(await first.locator('#vname').inputValue(), 'Version 1');
  await first.getByRole('button', { name: 'Cancel' }).click();
  await snapshot('Baseline', 'Approved by the steering group'); await toast('Saved v1 · Baseline');
  let sheet = await active();
  assert.deepEqual(sheet.versions.map((v) => [v.id, v.name, v.note]), [['v1', 'Baseline', 'Approved by the steering group']]);
  assert.equal(JSON.parse(sheet.versions[0].data).tasks.find((t) => t.id === 13).dur, 16);
  const history = await page.evaluate(async () => (await (await fetch('/api/history')).json()).entries[0].summary);
  assert.equal(history, 'Updated project versions');

  await edit(13, 'dur', '22');
  assert.equal(await cell(13, 'dur').textContent(), '22');
  await snapshot('Frontend +6d');
  await page.locator('#snapshotbtn').click();
  const again = page.getByRole('dialog', { name: 'Save version' });
  assert((await again.textContent()).includes('No changes since v2 · Frontend +6d'));
  await page.keyboard.press('Escape'); await again.waitFor({ state: 'detached' });

  // ---------- dropdown and read-only preview ----------
  await page.locator('#versionbtn').click(); await menu.waitFor();
  assert.deepEqual(await menu.locator('.vrow b').allTextContents(), ['Current plan', 'v2 · Frontend +6d', 'v1 · Baseline']);
  assert.equal(await page.locator('#versionbtn').getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: join(evidence, 'version-dropdown-1920.png') });
  await page.keyboard.press('Escape'); assert(await menu.isHidden());
  await pick('v1 · Baseline');
  assert.equal(await page.locator('#versionlbl').textContent(), 'v1 · Baseline');
  assert(await banner.isVisible()); assert((await banner.textContent()).includes('Approved by the steering group'));
  assert(await page.locator('#app').evaluate((el) => el.classList.contains('previewing')));
  assert.equal(await cell(13, 'dur').textContent(), '16');
  assert(await page.locator('#optAuto').isDisabled());
  await page.screenshot({ path: join(evidence, 'version-preview-1920.png') });
  await cell(13, 'dur').click(); await page.keyboard.type('9'); await toast(LOCK);
  assert.equal(await cell(13, 'dur').textContent(), '16');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z'); await settle(); assert.equal(await cell(13, 'dur').textContent(), '16');
  sheet = await active();
  assert.equal(sheet.data.tasks.find((t) => t.id === 13).dur, 22, 'the live plan is never overwritten by the preview');
  await banner.getByRole('button', { name: 'Back to current' }).click(); await settle();
  assert(await banner.isHidden()); assert.equal(await cell(13, 'dur').textContent(), '22');
  assert.equal(await page.locator('#versionlbl').textContent(), 'Current');

  // ---------- restore (undoable) ----------
  await pick('v1 · Baseline');
  await banner.getByRole('button', { name: 'Restore…' }).click();
  const restore = page.getByRole('dialog', { name: 'Restore v1 · Baseline' }); await restore.waitFor();
  assert.equal(await restore.locator('#vkeep').isChecked(), false, 'the current plan already matches the latest version');
  await restore.locator('#vkeep').check();
  await restore.getByRole('button', { name: 'Restore version' }).click(); await toast('Restored v1 · Baseline');
  assert(await banner.isHidden()); assert.equal(await cell(13, 'dur').textContent(), '16');
  sheet = await active();
  assert.deepEqual(sheet.versions.map((v) => v.name), ['Baseline', 'Frontend +6d', 'Before restoring v1']);
  assert.equal(sheet.data.tasks.find((t) => t.id === 13).dur, 16);
  await page.locator('#gx').focus(); await page.keyboard.press('Control+z'); await settle();
  assert.equal(await cell(13, 'dur').textContent(), '22', 'undo reverses the restore in one step');
  await page.keyboard.press('Control+Shift+z'); await settle(); assert.equal(await cell(13, 'dur').textContent(), '16');
  await page.keyboard.press('Control+z'); await settle();

  // ---------- rename and delete ----------
  await page.locator('#versionbtn').click(); await menu.locator('[data-edit="v2"]').click();
  const rename = page.getByRole('dialog', { name: 'Edit v2 · Frontend +6d' }); await rename.waitFor();
  await rename.locator('#vname').fill('Frontend slip'); await rename.getByRole('button', { name: 'Save' }).click();
  await page.locator('#versionbtn').click(); await menu.locator('[data-del="v3"]').click(); await toast('Deleted v3');
  assert.match(confirms.at(-1), /Delete v3 · Before restoring v1\?/);
  sheet = await active();
  assert.deepEqual(sheet.versions.map((v) => [v.id, v.name]), [['v1', 'Baseline'], ['v2', 'Frontend slip']]);
  assert.equal(sheet.nextVersion, 4);

  // ---------- version analysis ----------
  await page.locator('#analysisbtn').click();
  const overlay = page.locator('#analysis'); await overlay.locator('.an-kpis').waitFor();
  assert.equal(await overlay.locator('#an-a').inputValue(), 'v2'); assert.equal(await overlay.locator('#an-b').inputValue(), '');
  assert.equal(await overlay.locator('[data-kpi=finish] .k-d').textContent(), 'No change');
  assert.equal(await overlay.locator('.wf-step').count(), 0);
  assert((await overlay.locator('.wf-empty').textContent()).includes('No scheduling changes'));
  await overlay.locator('#an-a').selectOption('v1');
  await overlay.locator('[data-kpi=finish] .k-d', { hasText: '+6 working days' }).waitFor();
  for (const id of ['summary', 'trends', 'milestones', 'gantt', 'changes', 'slips', 'critical', 'owners']) assert(await overlay.locator(`#an-${id}`).isVisible(), id);
  assert.equal(await overlay.locator('[data-chart=finish] circle').count(), 3);
  assert(await overlay.locator('[data-chart=ms] path.ch-line').count() >= 5);
  assert(await overlay.locator('.an-gantt .g-ghost').count() > 10);
  assert(await overlay.locator('.an-gantt .g-bar.late').count() > 3);
  assert((await overlay.locator('#an-milestones').textContent()).includes('Slipped'));
  assert((await overlay.locator('#an-slips').textContent()).includes('Duration +6d'));
  assert.equal(await overlay.locator('.wf-step').count(), 1, 'Frontend is counted once, not for every downstream slip');
  assert((await overlay.locator('.wf-detail').textContent()).includes('Frontend app'));
  assert((await overlay.locator('.wf-detail .wf-impact b').textContent()).includes('+6d'));
  assert((await overlay.locator('.wf-chains').textContent()).includes('Launch'));
  assert.equal(await overlay.locator('.wf-explain').evaluate((el) => el.open), false, 'explanation is available on demand');
  assert.equal(await overlay.locator('.an-metrics').evaluate((el) => el.open), false, 'secondary metrics start collapsed');
  await overlay.locator('.wf-explain > summary').click();
  assert(await overlay.locator('.wf-chains').isVisible(), 'full controlling chains remain available');
  await overlay.locator('.wf-explain > summary').click();
  await overlay.locator('.an-metrics > summary').click();
  assert(await overlay.locator('.an-metrics .an-t').isVisible(), 'full metrics remain available');
  assert((await overlay.locator('.an-metrics').textContent()).includes('Violated links'));
  await overlay.locator('.an-metrics > summary').click();
  await overlay.locator('[data-series="1"]').click();
  assert.equal(await overlay.locator('[data-chart=ms] .ch-series[opacity="1"]').count(), 1, 'legend isolates a milestone');
  await overlay.locator('[data-series="1"]').click();
  assert(await overlay.locator('[data-chart=ms] .ch-series[opacity="1"]').count() >= 5, 'legend restores all series');
  await overlay.locator('.wf-breakdown > summary').click();
  await overlay.locator('[data-wf-select="0"]').click();
  assert(await overlay.locator('.wf-detail h3').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'table selection reveals the selected explanation');
  await overlay.locator('.wf-breakdown > summary').click();
  assert.equal(await overlay.locator('[data-wf-select="0"]').getAttribute('aria-pressed'), 'true');
  await overlay.locator('[data-wf-step="0"]').focus(); await page.keyboard.press('Enter');
  assert.equal(await overlay.locator('[data-wf-step="0"]').evaluate((el) => el === document.activeElement), true);
  const allRows = await overlay.locator('.an-logwrap tbody tr').count();
  await overlay.locator('[data-filter=duration]').click();
  assert.equal(await overlay.locator('.an-logwrap tbody tr').count(), 1);
  await overlay.locator('[data-filter=all]').click(); await overlay.locator('.an-search').fill('Frontend');
  const searched = await overlay.locator('.an-logwrap tbody tr').count(); assert(searched > 0 && searched < allRows);
  assert.equal(await overlay.locator('.an-search').evaluate((el) => el === document.activeElement), true, 'typing keeps focus in the search field');
  const ganttRows = await overlay.locator('.an-gantt .g-name').count();
  await overlay.locator('[data-an=only]').check();
  assert(await overlay.locator('.an-gantt .g-name').count() < ganttRows);
  await overlay.locator('[data-an=only]').uncheck();
  await page.screenshot({ path: join(evidence, 'analysis-summary-1920.png') });
  for (const id of ['milestones', 'gantt', 'changes', 'critical']) { await overlay.locator(`[data-go=${id}]`).click(); await page.waitForTimeout(450); await page.screenshot({ path: join(evidence, `analysis-${id}-1920.png`) }); }
  // The overlay owns the keyboard: grid shortcuts do not reach the plan underneath.
  await overlay.locator('.an-body').focus(); await page.keyboard.press('Control+Delete'); await page.keyboard.press('Control+z');
  for (const [kind, ext, check] of [['pdf', '.pdf', (b) => b.subarray(0, 8).toString() === '%PDF-1.4'], ['xlsx', '.xlsx', (b) => b.subarray(0, 2).toString() === 'PK']]) {
    const download = page.waitForEvent('download'); await overlay.locator(`[data-an=${kind}]`).click();
    const file = await download, path = join(temp, file.suggestedFilename()); await file.saveAs(path);
    assert(file.suggestedFilename().endsWith(ext) && file.suggestedFilename().includes('analysis-v1-vs-Now'), file.suggestedFilename());
    assert(check(await readFile(path)), kind);
    if (process.env.PLAN_TEST_ARTIFACTS) await file.saveAs(join(evidence, `version-analysis.${kind === 'pdf' ? 'pdf' : 'xlsx'}`));
  }
  await overlay.locator('[data-an=swap]').click();
  assert.equal(await overlay.locator('#an-a').inputValue(), ''); assert.equal(await overlay.locator('[data-kpi=finish] .k-d').textContent(), '-6 working days');
  assert((await overlay.locator('.wf-detail .wf-impact b').textContent()).includes('-6d'));
  await page.keyboard.press('Escape'); assert(await overlay.isHidden());
  assert.equal(await page.locator('#analysisbtn').evaluate((el) => el === document.activeElement), true, 'focus returns to the Analysis button');
  assert.equal(await cell(13, 'dur').textContent(), '22'); assert(await row(21).isVisible());

  // Compare to current from the preview banner uses the shown version as the baseline.
  await pick('v1 · Baseline'); await banner.getByRole('button', { name: 'Compare to current' }).click();
  await overlay.locator('.an-kpis').waitFor(); assert.equal(await overlay.locator('#an-a').inputValue(), 'v1');
  await overlay.getByRole('button', { name: 'Close version analysis' }).click();

  // ---------- export shows the version on screen; copy as a new project ----------
  const pdfDownload = page.waitForEvent('download'); await page.locator('#expbtn').click(); await page.getByRole('button', { name: 'PDF · this sheet' }).click();
  assert.match((await pdfDownload).suggestedFilename(), /^Launch-plan-v1-/);
  await banner.getByRole('button', { name: 'Copy as new project' }).click(); await settle();
  assert.equal(await page.locator('.brand b').textContent(), 'Launch plan · Baseline');
  assert(await banner.isHidden()); assert.equal(await cell(13, 'dur').textContent(), '16');
  await page.locator('#versionbtn').click(); assert((await menu.textContent()).includes('No versions yet')); await page.keyboard.press('Escape');
  await page.locator('.tab', { hasText: /^Launch plan$/ }).click(); await settle();
  assert.equal(await page.locator('#versionlbl').textContent(), 'Current');

  // ---------- .plan round trip ----------
  await pick('v2 · Frontend slip');
  await page.locator('#saveprojectbtn').click(); await toast('Saved');
  const doc = await page.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('versions.plan')).getFile()).text()));
  // Save version defaults to the type Status update, and any typed version makes the file format 6 (older apps cannot open it).
  assert.equal(doc.version, 6);
  assert.deepEqual(doc.project.versions.map((v) => v.type), ['status', 'status']);
  assert.deepEqual(doc.project.versions.map((v) => [v.n, v.name]), [[1, 'Baseline'], [2, 'Frontend slip']]);
  assert.equal(doc.project.nextVersion, 4);
  assert.equal(doc.project.data.tasks.find((t) => t.id === 13).dur, 22, 'Save writes the live plan, not the version on screen');
  assert(await banner.isVisible(), 'saving leaves the preview open');
  await page.locator('#openprojectbtn').click(); await settle();
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 3);
  await page.locator('#versionbtn').click(); await menu.waitFor();
  assert.deepEqual(await menu.locator('.vrow b').allTextContents(), ['Current plan', 'v2 · Frontend slip', 'v1 · Baseline']);
  await page.keyboard.press('Escape');

  // ---------- persistence across reload ----------
  await saved(); await page.reload(); await row(21).waitFor();
  assert.equal(await page.locator('#versionlbl').textContent(), 'Current', 'a reload always opens the current plan');
  await page.locator('#versionbtn').click();
  assert.equal(await menu.locator('.vrow').count(), 3); await page.keyboard.press('Escape');

  // ---------- multi-step waterfall selection and keyboard navigation ----------
  await page.locator('.tab', { hasText: /^Launch plan$/ }).click(); await settle();
  await edit(17, 'dur', '8');
  await page.locator('#analysisbtn').click(); await overlay.locator('.wf-chart').waitFor();
  await overlay.locator('#an-a').selectOption('v1');
  assert.equal(await overlay.locator('.wf-step').count(), 2);
  await overlay.locator('[data-go=gantt]').click(); await page.waitForTimeout(450);
  assert.equal(await overlay.locator('[data-go=gantt]').getAttribute('aria-current'), 'location');
  await overlay.locator('[data-wf-step="0"]').focus(); await page.keyboard.press('Tab');
  assert.equal(await overlay.locator('[data-wf-step="1"]').evaluate((el) => el === document.activeElement && el.matches(':focus-visible') && getComputedStyle(el.querySelector('.wf-selected')).stroke === 'rgb(43, 89, 230)'), true, 'unselected step has visible keyboard focus');
  await overlay.locator('[data-wf-pick]').selectOption('1');
  assert((await overlay.locator('.wf-detail h3').textContent()).includes('QA & bug bash'));
  await overlay.locator('[data-wf-step="1"]').focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await overlay.locator('[data-wf-step="0"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await overlay.locator('[data-wf-step="0"]').evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('End'); assert.equal(await overlay.locator('[data-wf-step="1"]').getAttribute('aria-pressed'), 'true');
  await overlay.locator('[data-wf-prev]').click(); await overlay.locator('[data-wf-next]').click();
  assert((await overlay.locator('.wf-detail h3').textContent()).includes('QA & bug bash'));
  await overlay.locator('[data-go=gantt]').click(); await page.waitForTimeout(450);
  await page.screenshot({ path: join(evidence, 'waterfall-multiple-1920.png') });
  await page.keyboard.press('Escape');

  // ---------- empty state and narrow layout ----------
  await page.locator('#addsheet').click(); await settle();
  await page.locator('#analysisbtn').click(); await overlay.locator('.an-empty').waitFor();
  assert(await overlay.locator('[data-an=pdf]').isDisabled());
  await overlay.getByRole('button', { name: 'Take snapshot…' }).click();
  await page.getByRole('dialog', { name: 'Save version' }).getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.tab', { hasText: /^Launch plan$/ }).click(); await settle();
  await page.setViewportSize({ width: 1366, height: 768 }); await settle();
  await pick('v1 · Baseline');
  await page.screenshot({ path: join(evidence, 'version-preview-1366.png') });
  const fits = await page.evaluate(() => [...document.querySelectorAll('#verbanner > *, .brand > *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 0.5));
  assert(fits, 'banner and brand controls stay inside the viewport');
  await page.locator('#versionbtn').click(); await page.screenshot({ path: join(evidence, 'version-dropdown-1366.png') }); await page.keyboard.press('Escape');
  await banner.getByRole('button', { name: 'Compare to current' }).click(); await overlay.locator('.an-kpis').waitFor();
  const clipped = await overlay.evaluate((root) => [...root.querySelectorAll('.kpi > *')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
  assert.deepEqual(clipped, [], 'headline cards are not clipped at 1366px');
  await page.screenshot({ path: join(evidence, 'analysis-summary-1366.png') });
  for (const id of ['gantt', 'changes']) { await overlay.locator(`[data-go=${id}]`).click(); await page.waitForTimeout(450); await page.screenshot({ path: join(evidence, `analysis-${id}-1366.png`) }); }
  await overlay.locator('[data-go=gantt]').click(); await page.waitForTimeout(450);
  const overflow = await overlay.locator('.wf').evaluate((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: innerWidth }));
  assert(overflow.left >= 0 && overflow.right <= overflow.width, 'waterfall stays inside the overlay at1366px');
  assert(await overlay.locator('.wf-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'waterfall endpoints fit together');
  for (const scale of [1, 1.5, 2]) {
    const scaled = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: scale });
    const scaledPage = await scaled.newPage();
    await scaledPage.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    await scaledPage.goto(url); await scaledPage.locator('#analysisbtn').click(); await scaledPage.locator('#an-a').selectOption('v1');
    await scaledPage.locator('[data-go=gantt]').click(); await scaledPage.waitForTimeout(450);
    await scaledPage.screenshot({ path: join(evidence, `waterfall-1366-scale-${scale}.png`) });
    await scaled.close();
  }
  await page.keyboard.press('Escape');

  // ---------- connected scope replacement, imported through the real .plan flow ----------
  await page.evaluate(async () => {
    const { Store, D } = await import('/js/model.js');
    const { encodeProjectFile } = await import('/js/projectfiles.js');
    const start = D('2026-11-19');
    const task = (id, name, dur) => ({ id, name, dur, ms: dur === 0, start, level: 0, progress: 0, scheduling: 'auto' });
    const link = (id, from, to) => ({ id, from, to, type: 'FS', lag: 0 });
    const baseline = { tasks: [task(1, 'Frontend app', 16), task(2, 'Integration review', 2), task(3, 'QA & bug bash', 10), task(4, 'Launch', 0)], links: [link('l1', 1, 2), link('l2', 2, 3), link('l3', 3, 4)], nextId: 5, nextLink: 4 };
    const s = new Store({ workbook: { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Waterfall scope example', data: baseline }] }, preferences: { auto: true } });
    s.save = () => { s.sheet().data = JSON.parse(s.serialize()); };
    const result = s.snapshotVersion({ name: 'Baseline' }); if (result.error) throw Error(result.error);
    const changed = JSON.parse(s.serialize()); changed.tasks = changed.tasks.filter((t) => t.id !== 2);
    changed.tasks.find((t) => t.id === 1).dur = 22; changed.tasks.find((t) => t.id === 3).dur = 8;
    changed.tasks.push(task(5, 'Security approval', 3)); changed.links = [link('l4', 1, 5), link('l5', 5, 3), link('l3', 3, 4)]; changed.nextId = 6; changed.nextLink = 6;
    s.load(changed); s.save();
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('versions.plan', { create: true });
    const writable = await handle.createWritable(); await writable.write(encodeProjectFile(s)); await writable.close();
  });
  await page.locator('#openprojectbtn').click(); await settle();
  await page.waitForFunction(() => document.querySelector('.brand b').textContent === 'Waterfall scope example');
  await page.setViewportSize({ width: 1920, height: 1100 });
  await page.locator('#analysisbtn').click(); await overlay.locator('.wf-chart').waitFor();
  assert.equal(await overlay.locator('.wf-step').count(), 3);
  assert((await overlay.locator('.wf-kpis').textContent()).includes('+5d'));
  assert((await overlay.locator('.wf-table').textContent()).includes('Integration review (removed)'));
  assert((await overlay.locator('.wf-table').textContent()).includes('Security approval (added)'));
  await overlay.locator('[data-wf-step="0"]').click();
  assert((await overlay.locator('.wf-detail').textContent()).includes('joint effect'));
  await overlay.locator('[data-go=gantt]').click(); await page.waitForTimeout(450);
  await page.screenshot({ path: join(evidence, 'waterfall-scope-1920.png') });
  for (const kind of ['pdf', 'xlsx']) {
    const downloaded = page.waitForEvent('download'); await overlay.locator(`[data-an=${kind}]`).click();
    const file = await downloaded; await file.saveAs(join(evidence, `waterfall-scope.${kind}`));
  }
  await page.keyboard.press('Escape');

  // Keep the layout fixture independent of the file-connection checks above.
  const denseContext = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  await denseContext.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const densePage = await denseContext.newPage();
  densePage.on('pageerror', (e) => errors.push(e.message));
  densePage.on('dialog', (dialog) => dialog.accept());
  await densePage.goto(url); await densePage.locator('#gbody .r').first().waitFor();
  const denseOverlay = densePage.locator('#analysis');
  const denseSettle = () => densePage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  // Dense comparisons retain both endpoints; full names and compact controls remain usable.
  await densePage.evaluate(async () => {
    const { Store, D } = await import('/js/model.js');
    const { encodeProjectFile } = await import('/js/projectfiles.js');
    const tasks = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Regional stakeholder consultation and requirements validation ${i + 1}`, start: D('2026-11-02'), dur: 5, level: 0, progress: 0, ms: false }));
    const links = tasks.slice(1).map((t, i) => ({ id: `l${i + 1}`, from: i + 1, to: t.id, type: 'FS', lag: 0 }));
    const store = new Store({ workbook: { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'International platform transformation programme', data: { tasks, links, nextId: 13, nextLink: 12 } }] }, preferences: { auto: true } });
    store.save = () => { store.sheet().data = JSON.parse(store.serialize()); };
    store.snapshotVersion({ name: 'Steering committee approved delivery baseline' });
    const changed = JSON.parse(store.serialize()); changed.tasks.forEach((task, i) => { task.dur += i % 2 ? 2 : -1; }); store.load(changed); store.save();
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('dense.plan', { create: true });
    const writer = await handle.createWritable(); await writer.write(encodeProjectFile(store)); await writer.close(); window.showOpenFilePicker = async () => [handle];
  });
  await densePage.locator('#openprojectbtn').click();
  await densePage.waitForFunction(() => document.querySelector('.brand b').textContent === 'International platform transformation programme');
  await densePage.locator('#analysisbtn').click(); await denseOverlay.locator('.wf-chart').waitFor();
  assert.equal(await denseOverlay.locator('.wf-step').count(), 12);
  for (const width of [1920, 1366, 1024, 800]) {
    await densePage.setViewportSize({ width, height: width === 800 ? 600 : 900 }); await denseSettle();
    await denseOverlay.locator('[data-go=gantt]').click(); await denseSettle();
    assert.equal(await denseOverlay.locator('[data-go=gantt]').getAttribute('aria-current'), 'location');
    const fit = await denseOverlay.locator('.wf-scroll').evaluate((el) => {
      const clip = el.getBoundingClientRect(), endpoints = [...el.querySelectorAll('.wf-end')].map((r) => r.getBoundingClientRect());
      return el.scrollWidth <= el.clientWidth + 1 && endpoints.every((r) => r.left >= clip.left && r.right <= clip.right);
    });
    assert(fit, `both endpoints fit at ${width}px`);
    assert(await denseOverlay.locator('.wf-detail').evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'no independently scrolling inspector');
    assert(await denseOverlay.evaluate((el) => el.querySelector('.an-body').scrollWidth <= el.querySelector('.an-body').clientWidth + 1), 'no page overflow');
    if (width === 800) assert(await denseOverlay.locator('.an-head').evaluate((el) => el.getBoundingClientRect().height <= 110), 'compact header uses two deliberate rows');
    await denseOverlay.locator('[data-wf-pick]').selectOption('11');
    assert((await denseOverlay.locator('.wf-detail h3').textContent()).endsWith('12'));
    await denseOverlay.locator('[data-an=names]').check();
    assert((await denseOverlay.locator('.an-gantt .g-name').last().textContent()).endsWith('12'), 'full labels retain identifying suffixes');
    await densePage.screenshot({ path: join(evidence, `analysis-dense-${width}.png`) });
  }
  await denseOverlay.locator('.an-body').evaluate((el) => { el.scrollTop = 0; }); await denseSettle();
  assert.equal(await denseOverlay.locator('[data-go=summary]').getAttribute('aria-current'), 'location', 'manual scroll updates navigation');
  await denseOverlay.locator('.an-more').last().locator('summary').click();
  await denseOverlay.locator('[data-go=owners]').click(); await denseSettle();
  assert.equal(await denseOverlay.locator('[data-go=owners]').getAttribute('aria-current'), 'location', 'last section stays identifiable');

  await denseContext.close();

  assert.deepEqual(errors, []);
  console.log(`Screenshots: ${evidence}`);
  console.log('BROWSER VERSION CHECKS PASSED');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  console.error(`Screenshots: ${evidence}`);
  throw error;
} finally {
  await browser?.close(); server.kill(); await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done));
  if (!process.env.PLAN_TEST_ARTIFACTS) await rm(temp, { recursive: true, force: true });
}
