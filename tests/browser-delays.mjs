// Isolated delay-accounting UI checks: agreed columns, record popover, overdue chip, deadline and omission dialogs,
// delay causes in Settings, version types and the read-only preview.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-delays-ui-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'delays') : join(temp, 'screenshots');
await mkdir(evidence, { recursive: true });
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', temp, '--no-open', '--file-access', 'off'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stderr.on('data', (chunk) => { log += chunk; });
const iso = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
const t0 = new Date(), today = Math.floor(Date.UTC(t0.getFullYear(), t0.getMonth(), t0.getDate()) / 86400000), B = today + 7;
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(log)), 10000);
    server.once('exit', (code) => { clearTimeout(timer); no(new Error(`Server ${code}: ${log}`)); });
    server.stdout.on('data', (chunk) => { log += chunk; const m = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (m) { clearTimeout(timer); yes(m[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const newContext = async (width = 1920, height = 1000) => {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    return context;
  };
  const context = await newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (dialog) => { if (dialog.type() === 'beforeunload') await dialog.accept(); else await dialog.dismiss(); });
  await page.addInitScript(() => { window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('delays.plan')]; });
  await page.goto(url); await page.locator('#gbody .r').first().waitFor();
  // Fixture: Design > Build > Test > Launch chain, two loose tasks, one task that is already late (started two weeks ago).
  await page.evaluate(async ({ B, today }) => {
    const { Store } = await import('./js/model.js'), { encodeProjectFile } = await import('./js/projectfiles.js');
    const task = (id, name, dur, start = B, extra = {}) => ({ id, name, dur, ms: dur === 0, start, level: 0, progress: 0, scheduling: 'auto', owner: '', ...extra });
    const link = (id, from, to) => ({ id, from, to, type: 'FS', lag: 0 });
    const data = { tasks: [task(1, 'Design', 5), task(2, 'Build', 10), task(3, 'Test', 5), task(4, 'Launch', 0), task(5, 'Side work', 4), task(6, 'Stale task', 3, today - 14), task(7, 'Docs', 4)], links: [link('l1', 1, 2), link('l2', 2, 3), link('l3', 3, 4)], nextId: 8, nextLink: 4 };
    const s = new Store({ workbook: { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Delay plan', data }] }, preferences: { auto: true } });
    s.save = () => { s.sheet().data = JSON.parse(s.serialize()); };
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('delays.plan', { create: true });
    const writable = await handle.createWritable(); await writable.write(encodeProjectFile(s)); await writable.close();
  }, { B, today });
  await page.locator('#openprojectbtn').click(); await page.waitForFunction(() => document.querySelector('.brand b').textContent === 'Delay plan');
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const toast = (text) => page.waitForFunction((t) => document.querySelector('#toast').textContent.includes(t), text);
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const data = async () => { await saved(); return page.evaluate(async () => { const s = (await (await fetch('/api/projects')).json()).state; return s.workbook.sheets.find((x) => x.id === s.workbook.active).data; }); };
  const row = (id) => page.locator(`#gbody .r[data-id="${id}"]`);
  const cell = (id, col) => row(id).locator(`[data-col=${col}]`);
  const text = async (id, col) => (await cell(id, col).textContent()).replace(/\s+/g, ' ').trim();
  const pop = page.locator('.dly-pop');
  const headers = () => page.$$eval('#ghead .c', (cells) => cells.map((c) => c.textContent.trim()));
  const edit = async (id, col, value) => { await cell(id, col).dblclick(); await page.locator('.editor').fill(value); await page.keyboard.press('Enter'); await settle(); };
  const dialogOf = (name) => page.getByRole('dialog', { name, exact: true });
  const fits = async (ids) => page.evaluate((cols) => { const gx = document.querySelector('#gx').getBoundingClientRect(); return cols.map((c) => { const h = [...document.querySelectorAll('#ghead .c')].find((x) => x.textContent.trim() === c); const r = h?.getBoundingClientRect(); return [c, !!r && r.left >= gx.left && r.right <= gx.right + 1]; }); }, ids);
  const undo = async () => { await page.locator('#gx').focus().catch(() => {}); await page.keyboard.press('Control+z'); await settle(); };

  // ---------- nothing is agreed yet: no delay columns, no project agreed date ----------
  assert(!(await headers()).includes('Agreed'));
  assert(!(await page.locator('#stat').textContent()).includes('Agreed'));

  // ---------- agreed-deadline dialog: one-click expected date, then another date from the picker ----------
  await cell(5, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Set agreed deadline…', exact: true }).click();
  let dlg = dialogOf('Set agreed deadline'); await dlg.waitFor();
  assert(await dlg.locator('input[name=dlyd][value=expected]').isChecked(), 'the expected date is preselected');
  assert((await dlg.textContent()).includes('Expected date'));
  await page.screenshot({ path: join(evidence, 'deadline-dialog.png') });
  await dlg.getByRole('button', { name: 'Set agreed deadline' }).click(); await dlg.waitFor({ state: 'detached' }); await settle();
  assert((await headers()).includes('Agreed'), 'one agreed task shows the agreed columns');
  assert(!(await page.locator('#stat').textContent()).includes('Agreed'), 'a single deadline does not create a project agreed date');
  const sideAgreed = await text(5, 'agreed'); assert.notEqual(sideAgreed, '·');
  await cell(5, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change agreed deadline…', exact: true }).click();
  dlg = dialogOf('Change agreed deadline'); await dlg.waitFor();
  await dlg.locator('#dly-date').click(); await dlg.locator('#dly-cal [data-day]').nth(0).waitFor();
  await page.screenshot({ path: join(evidence, 'deadline-picker.png') });
  await dlg.locator('#dly-date').fill(iso(B + 12));
  await dlg.getByRole('button', { name: 'Set agreed deadline' }).click();
  assert((await dlg.locator('.set-err').textContent()).length > 0, 'changing an agreed date needs a reason and an approver');
  await dlg.locator('[data-f=reason]').fill('Client moved the deadline'); await dlg.locator('[data-f=approved]').fill('Sam');
  await dlg.getByRole('button', { name: 'Set agreed deadline' }).click(); await dlg.waitFor({ state: 'detached' }); await settle();
  assert.notEqual(await text(5, 'agreed'), sideAgreed);
  assert.equal(await text(5, 'agreedO'), sideAgreed, 'the original agreed date shows once a revision exists');
  assert((await data()).log.some((e) => e.type === 'revision' && e.taskId === 5 && e.reason === 'Client moved the deadline'));

  // ---------- Agreed baseline: one operation, columns visible without scrolling ----------
  await page.locator('#snapshotbtn').click();
  const save = page.getByRole('dialog', { name: 'Save version' }); await save.waitFor();
  await save.locator('#vtype').selectOption('baseline'); await save.locator('#vname').fill('Baseline');
  // Side work's agreed date differs from the plan, so the baseline replaces it as a recorded revision and asks who approved it.
  await save.getByRole('button', { name: 'Save version' }).click();
  assert((await save.locator('.set-err').textContent()).length > 0 && await page.locator('.vrow').count() === 0, 'a failed baseline agrees nothing and saves nothing');
  assert((await data()).log.every((e) => e.source !== 'baseline'));
  await save.locator('#dly-reason').fill('Re-baselined after the client review'); await save.locator('#dly-appr').fill('Sam');
  await page.screenshot({ path: join(evidence, 'baseline-dialog.png') });
  await save.getByRole('button', { name: 'Save version' }).click(); await save.waitFor({ state: 'detached' }); await settle();
  await toast('undo history starts here');
  assert((await page.locator('#stat').textContent()).includes('Agreed'));
  assert.equal(await text(1, 'agreed') !== '·', true);
  for (const [name, ok] of await fits(['Agreed', '± days'])) assert(ok, `${name} is visible in the sheet at 1920 without scrolling`);
  assert(await page.evaluate(() => { const h = [...document.querySelectorAll('#ghead .c')].find((x) => x.textContent.trim() === 'Own / Inherited').getBoundingClientRect(); return h.left < document.querySelector('#gx').getBoundingClientRect().right - 100; }), 'Own / Inherited is at least mostly visible');
  assert.equal(await page.locator('#gx').evaluate((el) => el.scrollLeft), 0);
  await page.screenshot({ path: join(evidence, 'baseline-1920.png') });
  await undo(); // the agreement cannot be undone on its own
  assert.notEqual(await text(1, 'agreed'), '·', 'Ctrl+Z does not remove the agreed dates of a saved baseline');
  await page.locator('#versionbtn').click();
  assert((await page.locator('.vrow', { hasText: 'Baseline' }).first().textContent()).includes('Agreed baseline'));
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1366, height: 768 }); await settle();
  for (const [name, ok] of await fits(['Agreed', '± days'])) assert(ok, `${name} is visible in the sheet at 1366 without scrolling`);
  await page.screenshot({ path: join(evidence, 'baseline-1366.png') });
  await page.setViewportSize({ width: 1920, height: 1000 }); await settle();

  // ---------- popover triggers: typed Days, End and Start, a drag and a typed link ----------
  const open = async () => { await pop.waitFor(); await settle(); };
  const cancelBtn = pop.locator('.dly-actions [data-cancel]');
  await edit(2, 'dur', '14'); await open();                                   // typed Days
  assert((await pop.textContent()).includes('+4'));
  await page.screenshot({ path: join(evidence, 'popover-1920.png') });
  await cancelBtn.click(); await pop.waitFor({ state: 'detached' }); await settle();
  assert.equal(await text(2, 'dur'), '10', 'Cancel reverts the edit');
  await edit(1, 'end', iso(B + 7)); await open();                             // typed End
  assert((await pop.textContent()).includes('Finish'));
  await page.keyboard.press('Escape'); await pop.waitFor({ state: 'detached' }); await settle();
  assert.equal(await text(1, 'dur'), '5', 'Escape reverts the edit');
  await edit(1, 'start', iso(B + 3)); await open();                           // typed Start
  assert((await pop.locator('select[data-f=kind]').inputValue()) === 'Late start');
  await cancelBtn.click(); await pop.waitFor({ state: 'detached' }); await settle();
  await edit(4, 'pred', '4FS+5'); await open();                               // link lag pushes the first agreed task late
  assert((await pop.textContent()).includes('Launch'), 'the popover opens on the task the link pushed');
  await cancelBtn.click(); await pop.waitFor({ state: 'detached' }); await settle();
  assert.equal(await text(4, 'pred'), '4', 'Cancel reverts the link edit');
  const handle = await page.locator('.bar[data-id="7"] .resize-end').boundingBox();    // a drag
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + 70, handle.y + handle.height / 2, { steps: 6 }); await page.mouse.up(); await open();
  await cancelBtn.click(); await pop.waitFor({ state: 'detached' }); await settle();
  assert.equal(await text(7, 'dur'), '4', 'Cancel reverts the drag');

  // ---------- Cancel takes back only the popover's own edit ----------
  await edit(7, 'dur', '6'); await open();
  await edit(5, 'name', 'Side work renamed');
  await cancelBtn.click(); await pop.waitFor({ state: 'detached' }); await settle();
  assert((await text(5, 'name')).startsWith('Side work renamed'), 'a later rename is not undone by Cancel');
  assert.equal(await text(7, 'dur'), '6', 'the popover edit stays when something else changed since');
  await edit(5, 'name', 'Side work');

  // ---------- outcomes: Record, Skip reason, Revision ----------
  await edit(2, 'dur', '14'); await open();
  await pop.locator('[data-f=cause]').selectOption({ label: 'Resource availability' });
  await pop.locator('[data-f=party]').fill('Acme Ltd');
  await pop.locator('[data-record]').click(); await pop.waitFor({ state: 'detached' }); await toast('Delay recorded · +4d Resource availability'); await settle();
  assert.equal(await text(2, 'var'), '+4'); assert.equal(await text(3, 'var'), '+4'); assert.equal(await text(4, 'var'), '+4');
  assert((await text(2, 'origin')).includes('Own +4')); assert((await text(3, 'origin')).includes('Inherited +4'));
  assert((await text(2, 'cause')).includes('Resource availability'));
  assert((await text(3, 'cause')).includes('Build'));
  assert.equal(await page.locator('.bar[data-id="2"] .dly-shade').count(), 1, 'shading on the task where the delay started');
  assert.equal(await page.locator('.bar[data-id="3"] .dly-shade').count(), 0, 'no shading on a task that only inherited the delay');
  assert.equal(await page.locator('.bar[data-id="4"] .dly-shade').count(), 0);
  assert((await page.locator('#stat').textContent()).includes('+4d'));
  await page.screenshot({ path: join(evidence, 'after-record-1920.png') });
  await undo(); // one step takes back the edit and its record together
  assert.equal(await text(2, 'dur'), '10'); assert.equal(await text(2, 'var'), '0');
  assert.equal((await data()).log.filter((e) => e.type === 'delay').length, 0);
  await page.keyboard.press('Control+y'); await settle();
  assert.equal(await text(2, 'dur'), '14'); assert.equal(await text(2, 'var'), '+4');

  await edit(7, 'dur', '7'); await open();                                     // Docs: Skip reason
  await pop.locator('[data-skip]').click(); await pop.waitFor({ state: 'detached' }); await toast('Delay recorded without a cause · classify it from the task menu'); await settle();
  assert((await text(7, 'cause')).includes('Unclassified'));

  // ---------- classify later: task menu, Cause cell (double-click, F2), then Ctrl+Z restores Unclassified ----------
  const editDelay = dialogOf('Edit delay record');
  const pickCause = async (name) => { await editDelay.locator('#dly-cause').selectOption({ label: name }); await editDelay.getByRole('button', { name: 'Save', exact: true }).click(); await editDelay.waitFor({ state: 'detached' }); await settle(); };
  await cell(7, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit delay record…', exact: true }).click(); await editDelay.waitFor();
  assert.equal(await editDelay.locator('#dly-cause').inputValue(), '', 'the dialog opens on Unclassified');
  assert.equal(await editDelay.locator('#dly-entry').count(), 0, 'one delay: no entry picker');
  await page.screenshot({ path: join(evidence, 'edit-delay-1920.png') });
  await pickCause('Supplier / subcontractor');
  assert((await text(7, 'cause')).includes('Supplier / subcontractor'), 'the Cause cell shows the new cause');
  assert.equal((await data()).log.filter((e) => e.type === 'delay' && e.taskId === 7)[0].cause != null, true);
  await undo();
  assert((await text(7, 'cause')).includes('Unclassified'), 'one Ctrl+Z restores Unclassified (menu)');
  await cell(7, 'cause').dblclick(); await editDelay.waitFor();
  await pickCause('Client / approver');
  assert((await text(7, 'cause')).includes('Client / approver'), 'double-clicking the Cause cell opens the dialog');
  await undo();
  assert((await text(7, 'cause')).includes('Unclassified'), 'one Ctrl+Z restores Unclassified (Cause cell)');
  await cell(7, 'cause').click(); await page.screenshot({ path: join(evidence, 'cause-cell-1920.png') });
  await page.setViewportSize({ width: 1366, height: 768 }); await settle(); await page.screenshot({ path: join(evidence, 'cause-cell-1366.png') });
  await page.setViewportSize({ width: 1920, height: 1000 }); await settle();
  await page.keyboard.press('F2'); await editDelay.waitFor();
  await page.keyboard.press('Escape'); await editDelay.waitFor({ state: 'detached' });
  await cell(7, 'cause').click(); await page.keyboard.press('Enter'); await editDelay.waitFor();
  await pickCause('Unknown');
  assert((await text(7, 'cause')).includes('Unknown'), 'Enter on the Cause cell opens the dialog too');
  await undo();
  assert((await text(7, 'cause')).includes('Unclassified'));
  await cell(3, 'cause').dblclick(); await settle();
  assert.equal(await editDelay.count(), 0, 'an inherited cause points at its source instead of opening a dialog');
  await toast('set its cause there');
  // a second delay at the same task: the dialog lists both and edits the one picked
  await edit(7, 'dur', '9'); await open();
  await pop.locator('[data-f=cause]').selectOption({ label: 'Client / approver' }); await pop.locator('[data-record]').click(); await pop.waitFor({ state: 'detached' }); await settle(); await saved();
  await cell(7, 'name').click({ button: 'right' }); // the Cause cell is still selected: scrolling back to Task must not close the menu
  await page.getByRole('menuitem', { name: 'Edit delay record…', exact: true }).click(); await editDelay.waitFor();
  const entries = await editDelay.locator('#dly-entry option').allInnerTexts();
  assert.equal(entries.length, 2, `the dialog lists both delays: ${entries}`);
  assert(/Unclassified/.test(entries[0]) && /Client \/ approver/.test(entries[1]), `date, kind, days and cause are listed: ${entries}`);
  await editDelay.locator('#dly-entry').selectOption({ index: 0 }); await pickCause('Supplier / subcontractor');
  const two = (await data()).log.filter((e) => e.type === 'delay' && e.taskId === 7);
  assert.equal(two.length, 2); assert.notEqual(two[0].cause, null); assert.notEqual(two[1].cause, null);
  assert.notEqual(two[0].cause, two[1].cause, 'the earlier entry was edited, the later one kept its cause');
  await undo(); await undo();
  assert.equal(await text(7, 'dur'), '7'); assert((await text(7, 'cause')).includes('Unclassified'));

  const launchAgreed = await text(4, 'agreed');
  await edit(3, 'dur', '7'); await open();                                     // Test: Revision
  await pop.locator('.dly-opt[data-mode=revision] > label').click();
  await pop.locator('[data-record]').click();
  assert((await pop.locator('.set-err').textContent()).length > 0, 'a revision needs a reason');
  await pop.locator('[data-f=reason]').fill('Scope grew'); await pop.locator('[data-f=approved]').fill('Sam');
  await pop.locator('[data-record]').click(); await pop.waitFor({ state: 'detached' }); await toast('Revision recorded'); await settle();
  assert.notEqual(await text(4, 'agreed'), launchAgreed, 'the revision moves the agreed date of the task it pushed');
  assert.equal(await text(3, 'var'), '+4', 'the inherited delay stays');
  assert((await headers()).includes('Original agreed'));
  for (const [name, ok] of await fits(['Original agreed', 'Agreed', '± days', 'Own / Inherited'])) assert(ok, `${name} is visible in the sheet at 1920 after a revision`);
  const clipped = await page.evaluate(() => [...document.querySelectorAll('#ghead .c')].filter((c) => ['Original agreed', 'Agreed', '± days', 'Own / Inherited'].includes(c.textContent.trim())).filter((c) => [c, ...c.querySelectorAll('*')].some((e) => e.scrollWidth > e.clientWidth + 1)).map((c) => c.textContent.trim()));
  assert.deepEqual(clipped, [], 'no delay column header is clipped');
  await page.screenshot({ path: join(evidence, 'after-revision-1920.png') });

  // ---------- overdue chip: recording is one undo step ----------
  const chip = page.locator('.dly-od-g[data-dly-overdue="6"]');
  await chip.waitFor({ state: 'attached' }); await chip.scrollIntoViewIfNeeded();
  await chip.click({ force: true }); await open();
  assert((await pop.locator('[data-f=newfin]').inputValue()).length === 10);
  await pop.locator('[data-f=cause]').selectOption({ index: 1 });
  await pop.locator('[data-record]').click(); await pop.waitFor({ state: 'detached' }); await settle();
  assert.equal(await page.locator('.dly-od-g[data-dly-overdue="6"]').count(), 0, 'the chip goes away once the new date is recorded');
  await undo();
  assert.equal(await page.locator('.dly-od-g[data-dly-overdue="6"]').count(), 1, 'one undo step takes back the date and its record');
  assert.equal(await text(6, 'dur'), '3');

  // ---------- pending inclusion ----------
  await cell(7, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Insert task below/  }).click(); await settle();
  assert.equal(await page.locator('.dly-chip.pend', { hasText: 'Inclusion' }).count(), 1);
  const added = await page.locator('#gbody .r:has(.dly-chip.pend)').first().getAttribute('data-id');
  await cell(added, 'start').click(); await cell(added, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Agree inclusion…', exact: true }).click();
  dlg = dialogOf('Agree inclusion'); await dlg.waitFor();
  await dlg.locator('[data-f=reason]').fill('Customer request'); await dlg.locator('[data-f=approved]').fill('Sam');
  await dlg.getByRole('button', { name: 'Agree inclusion' }).click(); await dlg.waitFor({ state: 'detached' }); await settle();
  assert.equal(await page.locator('.dly-chip.pend', { hasText: 'Inclusion' }).count(), 0);
  assert((await data()).log.some((e) => e.type === 'inclusion'));

  // ---------- removing an agreed task: Omit (keeping the chain) or Delete ----------
  await cell(2, 'name').click(); await page.keyboard.press('Control+Delete');
  dlg = dialogOf('Remove an agreed task'); await dlg.waitFor();
  assert(await dlg.locator('input[name=dlyrm][value=omit]').isChecked());
  assert((await dlg.textContent()).includes('Keep the chain'));
  await dlg.getByRole('button', { name: 'Remove task' }).click();
  assert((await dlg.locator('.set-err').textContent()).length > 0, 'omitting needs a reason and an approver');
  await dlg.locator('[data-f=reason]').fill('Bought off the shelf'); await dlg.locator('[data-f=approved]').fill('Sam');
  await page.screenshot({ path: join(evidence, 'omit-dialog.png') });
  await dlg.getByRole('button', { name: 'Remove task' }).click(); await dlg.waitFor({ state: 'detached' }); await settle();
  assert.equal(await page.locator('#gbody .r[data-id="2"]').count(), 0);
  let saved1 = await data();
  assert(saved1.log.some((e) => e.type === 'omission' && e.taskId === 2), 'the omission stays in the log');
  assert(saved1.links.some((l) => l.from === 1 && l.to === 3), 'the chain is kept');
  await cell(7, 'name').click(); await page.keyboard.press('Control+Delete');
  dlg = dialogOf('Remove an agreed task'); await dlg.waitFor();
  await dlg.locator('input[name=dlyrm][value=delete]').check();
  await dlg.getByRole('button', { name: 'Remove task' }).click(); await dlg.waitFor({ state: 'detached' }); await settle();
  saved1 = await data();
  assert(!saved1.tasks.some((t) => t.id === 7) && !saved1.log.some((e) => e.type === 'omission' && e.taskId === 7), 'Delete keeps no record');
  await undo(); await undo();

  // ---------- Settings -> Delay causes: usage counts, rename, retire, persistence ----------
  for (const name of ['Second', 'Third']) { await page.locator('#snapshotbtn').click(); const d = page.getByRole('dialog', { name: 'Save version' }); await d.locator('#vname').fill(name); await d.getByRole('button', { name: 'Save version' }).click(); await d.waitFor({ state: 'detached' }); }
  await page.locator('#settingsbtn').click();
  dlg = dialogOf('Settings'); await dlg.waitFor();
  const causeRow = (name) => dlg.locator('.dly-cause-row', { hasText: name });
  assert((await causeRow('Resource availability').textContent()).includes('Used by 1 delay'), 'a delay is counted once, not once per saved version');
  await dlg.locator('#dly-new').fill('Weather'); await dlg.locator('#dly-add').click();
  assert((await causeRow('Weather').textContent()).includes('Not used'));
  await causeRow('Weather').locator('[data-rename]').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('Bad weather'); await page.keyboard.press('Enter');
  await causeRow('Bad weather').waitFor();
  await causeRow('Resource availability').getByRole('button', { name: /Retire/ }).click();
  assert((await causeRow('Resource availability').textContent()).includes('Retired'), 'a cause that is in use is retired, not removed');
  await page.screenshot({ path: join(evidence, 'settings-causes.png') });
  await page.keyboard.press('Escape'); await dlg.waitFor({ state: 'detached' }).catch(() => {});
  await saved();
  await page.reload(); await page.locator('#gbody .r').first().waitFor();
  await page.locator('#settingsbtn').click(); dlg = dialogOf('Settings'); await dlg.waitFor();
  await causeRow('Bad weather').waitFor(); assert((await causeRow('Resource availability').textContent()).includes('Retired'));
  await page.keyboard.press('Escape');
  const fresh = await newContext(), freshPage = await fresh.newPage();
  await freshPage.goto(url); await freshPage.locator('#gbody .r').first().waitFor();
  await freshPage.locator('#settingsbtn').click();
  await freshPage.getByRole('dialog', { name: 'Settings', exact: true }).locator('.dly-cause-row', { hasText: 'Bad weather' }).waitFor();
  await fresh.close();

  // ---------- analysis: default comparison, every section, grid sums, Current agreed, stars, exports, re-import ----------
  const taskCount = (await data()).tasks.length;
  await page.locator('#analysisbtn').click();
  const an = page.locator('#analysis'); await an.locator('.an-kpis').waitFor(); await settle();
  assert((await an.locator('#an-a option:checked').innerText()).includes('Baseline'), 'Analysis compares the latest Agreed baseline');
  assert((await an.locator('#an-b option:checked').innerText()).includes('Current'), 'with the current plan');
  for (const id of ['dmil', 'dimp', 'dexp', 'dtrd', 'down', 'dlog']) assert.equal(await an.locator(`#an-${id}`).count(), 1, `section ${id} is on the page`);
  assert(/Milestone table/.test(await an.locator('.an-nav').innerText()), 'the Analysis menu lists the delay sections');
  const gridSums = () => an.locator('#an-dimp table.dly-grid').evaluate((g) => {
    const num = (t) => (t.trim() === '—' || !t.trim() ? 0 : +t.replace('−', '-').replace('+', ''));
    const rows = [...g.querySelectorAll('tbody tr')], total = rows.at(-1), body = rows.slice(0, -1), n = g.querySelectorAll('thead th').length - 1;
    return { label: total.children[0].textContent.trim(), n, ok: Array.from({ length: n }, (_, i) => body.reduce((a, r) => a + num(r.children[i + 1].textContent), 0) === num(total.children[i + 1].textContent)).every(Boolean) };
  });
  let sums = await gridSums(); assert(sums.n >= 1 && sums.ok && /Total/.test(sums.label), 'every impact grid column adds up to its total');
  const heads = () => an.locator('#an-dimp thead th').allInnerTexts();
  const keyHeads = await heads();
  await an.locator('[data-dly-showall]').click(); await settle();
  const allHeads = await heads(); assert(allHeads.length > keyHeads.length, 'Show all milestones adds columns');
  sums = await gridSums(); assert(sums.ok, 'all columns add up with every milestone shown');
  await an.locator('[data-dly-showall]').click(); await settle();
  const star = an.locator('[data-dly-star]').first(), starId = +(await star.getAttribute('data-dly-star'));
  await star.click(); await settle();
  assert((await heads()).length === keyHeads.length + 1, 'starring a milestone adds its column');
  assert.deepEqual((await data()).stars, [starId], 'key milestones are saved with the project');
  const revisions = (await an.locator('#an-dmil thead th').allInnerTexts()).includes('Revisions');
  assert(revisions, 'the fixture has a revision, so the milestone table shows Revisions');
  {
    assert(!/bad/.test(await an.locator('#an-dmil td.dly-agr').first().getAttribute('class')), 'a revision is not drawn as delay');
    await an.locator('[data-dly-explain]').selectOption({ index: 0 }); await settle();
    const stepTitles = await an.locator('#an-dexp .wf-step').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    assert(stepTitles.some((t) => /Current agreed/.test(t)), `Explain has a Current agreed subtotal: ${stepTitles}`);
    assert(await an.locator('#an-dexp .wf-legend .agreed').count() === 1, 'the legend names agreed changes');
    await an.locator('#an-dexp').screenshot({ path: join(evidence, 'explain.png') });
    assert.notEqual(await an.locator('#an-dexp .wf-bar').first().getAttribute('fill'), '#f43f5e', 'an agreed change is not red');
  }
  assert(/Own delay/.test(await an.locator('#an-down').innerText()) && /summed per task|per task/.test(await an.locator('#an-down thead').innerText()), 'Inherited says it is summed per task');
  {
    // Delay log rows edit the delay when the right-hand side is the current plan; a saved version is read-only
    const rowEdit = an.locator('#an-dlog [data-dly-edit]');
    assert((await rowEdit.count()) >= 1, 'Delay log rows offer Edit when comparing with the current plan');
    const unclassifiedOf = async () => +(((await an.locator('#an-down tbody tr').first().innerText()).trim().split('\t').at(-1)).replace('+', ''));
    const unBefore = await unclassifiedOf(); assert(unBefore > 0, `the owner table has Unclassified delay before classifying: ${unBefore}`);
    const docsRow = an.locator('#an-dlog tbody tr', { hasText: 'Docs' }).first();
    await docsRow.locator('[data-dly-edit]').click(); await editDelay.waitFor();
    await page.screenshot({ path: join(evidence, 'edit-delay-from-log.png') });
    await pickCause('Supplier / subcontractor');
    assert((await docsRow.textContent()).includes('Supplier / subcontractor') || (await an.locator('#an-dlog tbody tr', { hasText: 'Docs' }).first().textContent()).includes('Supplier / subcontractor'), 'the Delay log section refreshes after Save');
    assert((await unclassifiedOf()) < unBefore, 'the owner table Unclassified drops after classifying');
    const buildRow = () => an.locator('#an-dlog tbody tr', { hasText: 'Build' }).first();
    assert(/Resource availability/.test(await an.locator('#an-dmil').innerText()));
    await buildRow().locator('[data-dly-edit]').click(); await editDelay.waitFor(); await pickCause('Client / approver');
    assert(/Client \/ approver \+4/.test(await an.locator('#an-dmil').innerText()), 'Main causes follow the cause set from the Delay log');
    await an.locator('#an-b').selectOption({ label: await an.locator('#an-b option', { hasText: 'Second' }).first().innerText() }); await settle();
    assert.equal(await an.locator('#an-dlog [data-dly-edit]').count(), 0, 'a saved version is read-only: no Edit in the Delay log');
    await an.locator('#an-b').selectOption({ index: 0 }); await settle();
    assert((await an.locator('#an-dlog [data-dly-edit]').count()) >= 1);
    await an.locator('[data-an=close]').click(); await settle();
    assert.equal(await an.isHidden(), true);
    await undo(); await undo();
    assert((await text(7, 'cause')).includes('Unclassified'), 'Ctrl+Z restores Unclassified (Delay log)');
    assert((await text(2, 'cause')).includes('Resource availability'), 'the second Delay log edit was undone too');
    await page.locator('#analysisbtn').click(); await an.locator('.an-kpis').waitFor(); await settle();
    assert.equal(await an.locator('#an-dimp').count(), 1);
  }
  const dl = async (button) => { const wait = page.waitForEvent('download'); await an.locator(button).click(); const file = await wait; const target = join(temp, file.suggestedFilename()); await file.saveAs(target); return target; };
  const { execFileSync } = await import('node:child_process'), { readFileSync } = await import('node:fs');
  const pdf = readFileSync(await dl('[data-an=pdf]')).toString('latin1');
  for (const part of ['Delay accounting - milestones', 'Impact grid', 'Delay log']) assert(pdf.includes(part), `the Analysis PDF has ${part}`);
  const unzipOf = (file, name) => execFileSync('unzip', ['-p', file, name], { maxBuffer: 1 << 26 }).toString();
  const xlsx = await dl('[data-an=xlsx]'), strings = unzipOf(xlsx, 'xl/worksheets/*.xml'), workbookXml = unzipOf(xlsx, 'xl/workbook.xml');
  for (const part of ['Delay milestones', 'Impact grid', 'Delay log']) assert(workbookXml.includes(`sheet name="${part}"`), `the Analysis Excel has the ${part} sheet`);
  assert(strings.includes('Main causes') && strings.includes('Total vs original agreed'), 'with the milestone table and the impact grid filled in');
  await page.keyboard.press('Escape'); await settle();
  const sheetXlsx = join(temp, 'sheet.xlsx'), exportWait = page.waitForEvent('download');
  await page.locator('#expbtn').click(); await page.getByRole('button', { name: /Excel · this sheet/ }).click();
  await (await exportWait).saveAs(sheetXlsx);
  assert(unzipOf(sheetXlsx, 'xl/workbook.xml').includes('Delay log'), 'the sheet export has a Delay log sheet');
  assert(unzipOf(sheetXlsx, 'xl/worksheets/*.xml').includes('Agreed finish'), 'the sheet export has the agreed columns');
  const before = (await page.evaluate(async () => (await (await fetch('/api/projects')).json()).state.workbook.sheets.length));
  await page.locator('#impbtn').click(); const im = page.getByRole('dialog', { name: 'Import from Excel' }); await im.waitFor();
  const chooser = page.waitForEvent('filechooser'); await im.locator('[data-im=pick]').click(); await (await chooser).setFiles(sheetXlsx);
  await im.locator('[data-im=go]').waitFor(); await im.locator('[data-im=go]').click(); await settle(); await saved();
  const imported = await page.evaluate(async () => { const s = (await (await fetch('/api/projects')).json()).state.workbook; return { sheets: s.sheets.length, tasks: s.sheets.find((x) => x.id === s.active).data.tasks.map((t) => t.name) }; });
  assert.equal(imported.sheets, before + 1, 'the sheet export imports as a new sheet');
  assert.equal(imported.tasks.length, taskCount, `re-import brings back exactly the tasks, no Delay log rows: ${imported.tasks}`);
  await page.locator('.tab', { hasText: 'Delay plan' }).first().click().catch(() => {}); await settle();

  // ---------- version types: menu chip, edit dialog, read-only preview ----------
  await page.locator('#versionbtn').click();
  assert((await page.locator('.vrow', { hasText: 'Baseline' }).first().textContent()).includes('Agreed baseline'));
  assert((await page.locator('.vrow', { hasText: 'Second' }).first().textContent()).includes('Status update'));
  await page.locator('.vrow-wrap', { hasText: 'Second' }).locator('[data-edit]').click();
  const editDlg = page.locator('[role=dialog]', { has: page.locator('#vtype') }).last(); await editDlg.waitFor();
  assert.equal(await editDlg.locator('#vtype').inputValue(), 'status');
  await editDlg.locator('#vtype').selectOption('draft'); await editDlg.getByRole('button', { name: /Save/ }).click(); await editDlg.waitFor({ state: 'detached' });
  await page.locator('#versionbtn').click();
  assert((await page.locator('.vrow', { hasText: 'Second' }).first().textContent()).includes('Draft'));
  await page.locator('.vrow', { hasText: 'Baseline' }).first().click(); await settle();
  await cell(1, 'dur').dblclick({ force: true }); await settle();
  assert.equal(await pop.count(), 0, 'a read-only preview never opens the record popover');
  await cell(1, 'name').click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: /agreed deadline/ }).count(), 0, 'no agreeing in a read-only preview');
  assert.equal(await page.getByRole('menuitem', { name: 'Edit delay record…' }).count(), 0, 'no editing a delay record in a read-only preview');
  await page.keyboard.press('Escape');
  await cell(7, 'cause').dblclick({ force: true }); await settle();
  assert.equal(await dialogOf('Edit delay record').count(), 0, 'the Cause cell opens nothing in a read-only preview');
  await page.screenshot({ path: join(evidence, 'preview.png') });

  // ---------- Agreed baseline: a soft notice for delays without a cause, never a block ----------
  await page.reload(); await page.locator('#gbody .r').first().waitFor(); await settle();
  assert((await text(7, 'cause')).includes('Unclassified'));
  const openSave = async (type) => { await page.locator('#snapshotbtn').click(); const d = page.getByRole('dialog', { name: 'Save version' }); await d.waitFor(); if (type) await d.locator('#vtype').selectOption(type); return d; };
  const notice = (d) => d.locator('.dly-nocause:visible');
  let sv = await openSave('status');
  assert.equal(await notice(sv).count(), 0, 'no notice when the type is not Agreed baseline');
  await sv.locator('#vtype').selectOption('baseline');
  assert.equal(await notice(sv).count(), 1, 'the notice shows for an Agreed baseline');
  assert(/no cause/.test(await notice(sv).innerText()) && /Docs \+\d/.test(await notice(sv).innerText()), `the notice lists the unclassified delays: ${await notice(sv).innerText()}`);
  const unclassifiedNow = (await data()).log.filter((e) => e.type === 'delay' && !e.cause).length;
  assert.equal(await notice(sv).locator('select[data-dly-classify]').count(), unclassifiedNow);
  await sv.locator('#vname').fill('Keep this name'); await sv.locator('#vnote').fill('Keep this note');
  await page.screenshot({ path: join(evidence, 'baseline-notice-1920.png') });
  await page.setViewportSize({ width: 1366, height: 768 }); await settle();
  await page.screenshot({ path: join(evidence, 'baseline-notice-1366.png') });
  await page.setViewportSize({ width: 1920, height: 1000 }); await settle();
  while (await sv.locator('select[data-dly-classify]').count()) { const before = await sv.locator('select[data-dly-classify]').count(); await sv.locator('select[data-dly-classify]').first().selectOption({ index: 1 }); await page.waitForFunction((n) => document.querySelectorAll('select[data-dly-classify]').length < n, before); }
  assert.equal(await sv.count(), 1, 'classifying inside the notice keeps the dialog open');
  assert.equal(await sv.locator('#vname').inputValue(), 'Keep this name'); assert.equal(await sv.locator('#vnote').inputValue(), 'Keep this note'); assert.equal(await sv.locator('#vtype').inputValue(), 'baseline');
  assert.equal(await notice(sv).count(), 0, 'the notice goes away once every delay has a cause');
  assert((await data()).log.filter((e) => e.type === 'delay' && !e.cause).length === 0, 'the causes were stored');
  await sv.getByRole('button', { name: 'Cancel' }).click(); await sv.waitFor({ state: 'detached' });
  await undo(); // classifying inside the dialog is undoable like any other edit
  sv = await openSave('baseline');
  assert.equal(await notice(sv).count(), 1, 'the notice is back after undoing the classification');
  await sv.locator('#vname').fill('Baseline with open causes');
  if (await sv.locator('#dly-reason').count()) { await sv.locator('#dly-reason').fill('Re-baselined'); await sv.locator('#dly-appr').fill('Sam'); }
  await sv.getByRole('button', { name: 'Save version' }).click(); await sv.waitFor({ state: 'detached' }); await settle();
  await toast('undo history starts here');
  assert.equal((await data()).log.filter((e) => e.type === 'delay' && !e.cause).length, unclassifiedNow, 'saving is allowed with delays still unclassified, and nothing was classified for the user');
  await cell(7, 'cause').dblclick(); await editDelay.waitFor(); await pickCause('Supplier / subcontractor');
  assert(!(await text(7, 'cause')).includes('Unclassified'));
  const remaining = (await data()).log.filter((e) => e.type === 'delay' && !e.cause);
  for (const e of remaining) { await cell(e.taskId, 'cause').dblclick(); await editDelay.waitFor(); await pickCause('Supplier / subcontractor'); }
  sv = await openSave('baseline');
  assert.equal(await notice(sv).count(), 0, 'no notice when everything is classified');
  await page.keyboard.press('Escape'); await sv.waitFor({ state: 'detached' });

  // many delays without a cause: the list scrolls and Save version stays inside the dialog and the viewport at 1366x768
  for (let n = 0; n < 6; n++) { await edit(7, 'dur', String(20 + n)); await open(); await pop.locator('[data-skip]').click(); await pop.waitFor({ state: 'detached' }); await settle(); }
  await page.setViewportSize({ width: 1366, height: 768 }); await settle();
  sv = await openSave('baseline');
  const rows = await sv.locator('select[data-dly-classify]').count(); assert(rows >= 5, `at least 5 delays without a cause: ${rows}`);
  const fitsSave = await sv.evaluate((d) => { const b = d.querySelector('[data-save]').getBoundingClientRect(), m = d.getBoundingClientRect(), l = d.querySelector('.dly-nocause-list'); return { inView: b.top >= 0 && b.bottom <= innerHeight, inDialog: b.top >= m.top && b.bottom <= m.bottom + 1, listScrolls: l.scrollHeight > l.clientHeight, listH: l.clientHeight, sel: [...d.querySelectorAll('.dly-nocause-row select')].every((s) => s.scrollHeight <= s.clientHeight) }; });
  assert(fitsSave.inView && fitsSave.inDialog, `Save version is visible without scrolling at 1366x768 with ${rows} unclassified delays: ${JSON.stringify(fitsSave)}`);
  assert(fitsSave.listScrolls && fitsSave.listH <= 130, `the notice list is capped and scrolls: ${JSON.stringify(fitsSave)}`);
  assert(fitsSave.sel, 'the Classify select does not clip its text');
  await page.screenshot({ path: join(evidence, 'baseline-notice-many-1366.png') });
  await page.keyboard.press('Escape'); await sv.waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1920, height: 1000 }); await settle();

  // ---------- edge cases: a delay on an already manual task (F1) and a delay recorded from a lag edit (F2) ----------
  await page.reload(); await page.locator('#gbody .r').first().waitFor(); await settle();
  await cell(5, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Use manual dates', exact: true }).click(); await settle();
  await edit(5, 'pred', '4'); await settle();                                  // Test (row 4) now precedes the manual Side work, which ignores it
  assert.equal(await pop.count(), 0, 'a link into a manual task moves nothing');
  const sideStart = iso(B + 10);                                               // before Test finishes: a wrongly anchored task would jump behind it
  await edit(5, 'start', sideStart); await open();
  assert(!(await text(5, 'origin')).includes('Inherited'), `a manual task's own move is not inherited from a predecessor it ignores: ${await text(5, 'origin')}`);
  await pop.locator('[data-skip]').click(); await pop.waitFor({ state: 'detached' }); await settle();
  assert.equal((await data()).tasks.find((t) => t.id === 5).scheduling, 'manual', 'Record keeps a manual task manual');
  assert((await text(5, 'start')).length && (await cell(5, 'start').textContent()).trim() !== '', 'the start is shown');
  assert.equal(await page.evaluate(async (id) => { const s = (await (await fetch('/api/projects')).json()).state, d = s.workbook.sheets.find((x) => x.id === s.workbook.active).data; return d.tasks.find((t) => t.id === id).start; }, 5), B + 10, 'the dates are the ones that were typed');
  assert((await text(5, 'origin')).includes('Own'), 'the move shows as Own');
  await cell(3, 'pred').scrollIntoViewIfNeeded();
  await edit(3, 'pred', '3+3'); await open();                                 // F2: a lag typed on Test (after Build)
  await pop.locator('[data-f=cause]').selectOption({ label: 'Client / approver' });
  await pop.locator('[data-record]').click(); await pop.waitFor({ state: 'detached' }); await settle();
  assert((await text(3, 'origin')).includes('Own'), `the task where the lag was typed owns the delay: ${await text(3, 'origin')}`);
  assert(!(await text(3, 'origin')).includes('Inherited +3') , 'and does not inherit it from Build');
  assert((await text(3, 'cause')).includes('Client / approver') && !(await text(3, 'cause')).includes('Build'), `its Cause cell shows the cause: ${await text(3, 'cause')}`);
  await page.locator('#analysisbtn').click(); await an.locator('.an-kpis').waitFor(); await settle();
    const milestoneCauses = await an.locator('#an-dmil tbody tr').evaluateAll((rows) => rows.map((r) => r.textContent));
  assert(milestoneCauses.some((t) => /Launch/.test(t) && /Client \/ approver \+/.test(t)), `the cause reaches the milestone table: ${milestoneCauses}`);
  assert(!milestoneCauses.some((t) => /Launch|Project completion/.test(t) && /Other \/ unexplained/.test(t)), 'nothing is left unexplained for the lag delay');
  assert(/Test · own \+3/.test(await an.locator('#an-dimp').innerText()), 'the impact grid has a row for the lag delay');
  await an.locator('[data-an=close]').click(); await settle();

  // F4: a duplicate keeps the agreed dates and the log but no versions; the delay analysis must still be reachable.
  await page.locator('.tab.on').first().click({ button: 'right' });
  await page.locator('button[data-a=dup]').click(); await settle();
  await page.locator('#analysisbtn').click(); await an.locator('.an-empty').waitFor(); await settle();
  assert(/No versions yet/.test(await an.locator('.an-empty').innerText()), 'the duplicate has no versions');
  for (const id of ['dmil', 'dimp', 'dexp', 'down', 'dlog']) assert(await an.locator(`#an-${id}`).count(), `the duplicate's analysis has ${id}`);
  assert(/Launch/.test(await an.locator('#an-dmil').innerText()), 'the milestone table lists the milestones of the duplicate');
  assert(/Client \/ approver/.test(await an.locator('#an-dlog').innerText()), 'the delay log is kept in the duplicate');
  assert(await an.locator('.an-nav [data-go=dmil]').isVisible(), 'the section navigation lists the delay sections');
  await page.screenshot({ path: join(evidence, 'duplicate-analysis.png') });
  await an.locator('[data-an=close]').click(); await settle();

  assert.deepEqual(errors, []);
  console.log('Delay accounting browser checks passed');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  console.error(`Screenshots: ${evidence}`);
  throw error;
} finally {
  await browser?.close(); server.kill(); await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done)); await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
