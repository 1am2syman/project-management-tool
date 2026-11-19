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
  await pop.locator('[data-skip]').click(); await pop.waitFor({ state: 'detached' }); await toast('Unclassified delay recorded'); await settle();
  assert((await text(7, 'cause')).includes('Unclassified'));

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
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(evidence, 'preview.png') });

  assert.deepEqual(errors, []);
  console.log('Delay accounting browser checks passed');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  console.error(`Screenshots: ${evidence}`);
  throw error;
} finally {
  await browser?.close(); server.kill(); await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done)); await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
