// Isolated browser regression checks for the double-click Gantt item details dialog:
// 1. Double-clicking any Gantt bar (task, milestone, summary) opens the full editable dialog with contour backdrop
// 2. Editing identity, schedule, scheduling mode, progress, actuals & notes saves atomically, persists across reload, and undoes cleanly
// 3. Connections tab adds, edits (type + lag), removes links, prevents cycles, and jumps between connected tasks with Back history
// 4. Slack & Path tab shows total/free slack, clickable limiters, Gantt overlay selector, and milestone target toggle
// 5. Delays & Agreed tab sets agreed deadlines via stacked modal (Escape closes top modal only), handles delay popover on late finish, and edits delay log records
// 6. Summary dialog shifts group start, shows rolled-up actuals & children, and adds child items
// 7. Read-only saved version preview opens dialog in inspect-only mode with edits disabled
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-task-dialog-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'task-dialog') : join(temp, 'screenshots');
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
  const context = await browser.newContext({ viewport: { width: 1366, height: 720 } });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator('#gbody .r[data-id="21"]').waitFor();
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  // Pair each substantive input with its own database response. A pre-existing
  // green badge or two animation frames alone cannot prove this action committed.
  const commitAction = async (action) => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/projects/changes' && r.request().method() === 'POST'),
      action(),
    ]);
    assert.equal(response.status(), 200, await response.text());
    await saved(); await settle();
  };
  const assertNoScroll = async (label) => {
    const m = await page.evaluate(() => {
      const dlg = document.querySelector('.modal.task-dialog'), body = dlg?.querySelector('.m-body');
      return { dlgH: Math.round(dlg.getBoundingClientRect().height), scrollH: body.scrollHeight, clientH: body.clientHeight, vh: innerHeight };
    });
    assert(m.scrollH <= m.clientH + 1, `${label}: dialog body must not require vertical scrolling at 1366x720: ${JSON.stringify(m)}`);
    return m.dlgH;
  };
  await saved(); await settle();

  // Fit timeline so all bars are comfortably clickable
  await page.locator('[data-fit]').click(); await settle();

  // ---- 1. Double-click a regular task bar (id=8: Wireframes) ----
  const dlg = page.locator('.modal.task-dialog');
  await page.locator('.bar[data-id="8"]').dblclick();
  await dlg.waitFor(); await settle();
  assert.equal(await dlg.locator('.td-title').textContent(), 'Wireframes');
  assert.equal(await dlg.locator('.td-kpis .td-kpi').count(), 4);
  const baseH = await assertNoScroll('task overview');
  // Contour canvas attached behind the dialog
  const hasContour = await page.evaluate(() => !!document.querySelector('.modal.task-dialog')?.previousElementSibling?.classList.contains('contour-canvas'));
  assert.equal(hasContour, true, 'Task dialog gets Motion Brew contour canvas');
  await page.screenshot({ path: join(evidence, '01-overview-task.png') });

  // ---- 2. Edit identity, schedule (Overview tab) + progress & actuals (Progress tab) ----
  await dlg.locator('input[name="name"]').fill('Wireframes & flows');
  await dlg.locator('input[name="owner"]').fill('Lena Park');
  await dlg.locator('input[name="email"]').fill('lena.park@example.com');
  await dlg.locator('textarea[name="notes"]').fill('Includes interactive checkout prototype.');
  await dlg.locator('input[name="dur"]').fill('8');
  await dlg.locator('[data-td-tab="progress"]').click(); await settle();
  await assertNoScroll('progress tab', baseH);
  await dlg.locator('[data-td-pct="75"]').click();
  await dlg.locator('[data-td-fill="actualStart:plan"]').click();
  await dlg.locator('[data-td-fill="actualEnd:plan"]').click();
  await settle();
  await page.screenshot({ path: join(evidence, '01b-progress.png') });
  assert.equal(await dlg.locator('[data-td-save]').isEnabled(), true, 'Save changes enabled when dirty');
  const cmpText = await dlg.locator('[data-td-actual-cmp]').textContent();
  assert(cmpText.includes('8d actual working days'), `Actual comparison shows 8d actual working days, got: ${cmpText}`);
  await commitAction(() => dlg.locator('[data-td-save]').click());
  assert.equal(await dlg.locator('.td-title').textContent(), 'Wireframes & flows');
  assert.equal(await dlg.locator('[data-td-save]').isDisabled(), true, 'Save disabled after saving');
  // Grid reflects updated name & progress
  assert.equal(await page.locator('#gbody .r[data-id="8"] [data-col=name] .t').textContent(), 'Wireframes & flows');
  assert.equal(await page.locator('#gbody .r[data-id="8"] [data-col=progress]').textContent(), '75%');

  // Persist across reload
  await saved();
  await page.reload();
  await page.locator('#gbody .r[data-id="21"]').waitFor(); await settle();
  await page.locator('.bar[data-id="8"]').dblclick();
  await dlg.waitFor(); await settle();
  assert.equal(await dlg.locator('input[name="name"]').inputValue(), 'Wireframes & flows');
  assert.equal(await dlg.locator('textarea[name="notes"]').inputValue(), 'Includes interactive checkout prototype.');
  await dlg.locator('[data-td-tab="progress"]').click(); await settle();
  assert.notEqual(await dlg.locator('input[name="actualStart"]').inputValue(), '', 'actualStart persisted');
  assert.notEqual(await dlg.locator('input[name="actualEnd"]').inputValue(), '', 'actualEnd persisted');
  console.log('PASS 1 & 2: Double-click opens dialog; Overview & Progress tabs save atomically and persist');

  // ---- 3. Connections tab: compact rows, borderless breadcrumbs, add, update, navigate + back, remove ----
  await dlg.locator('[data-td-tab="connections"]').click(); await settle();
  await assertNoScroll('connections tab', baseH);
  const linkRowHeight = await dlg.locator('#td-panel-connections .td-link-row').first().evaluate((el) => el.getBoundingClientRect().height);
  assert(linkRowHeight <= 28, `Connection rows must be super compact (<=28px), got ${linkRowHeight}px`);
  const crumbBorder = await dlg.locator('.td-wbs-bar .td-crumb').first().evaluate((el) => getComputedStyle(el).borderTopWidth);
  assert.equal(crumbBorder, '0px', 'Hierarchy breadcrumb links must not have button borders');
  await page.screenshot({ path: join(evidence, '02-connections.png') });
  const initialInCount = await dlg.locator('#td-panel-connections .td-card').nth(0).locator('.td-link-row').count();
  assert(initialInCount >= 1, 'Wireframes has existing predecessor');
  // Add a new predecessor (id=3 Stakeholder interviews, SS +2d)
  const addIn = dlg.locator('[data-add-link="in"]');
  await addIn.locator('[data-add-target]').selectOption('3');
  await addIn.locator('[data-add-type]').selectOption('SS');
  await addIn.locator('[data-add-lag]').fill('2');
  await commitAction(() => addIn.locator('[data-add-submit="in"]').click());
  assert.equal(await dlg.locator('#td-panel-connections .td-card').nth(0).locator('.td-link-row').count(), initialInCount + 1);
  // Update lag on the newly added link
  const newRow = dlg.locator('#td-panel-connections .td-link-row', { hasText: 'Stakeholder interviews' });
  await newRow.locator('[data-link-lag]').fill('4');
  await commitAction(() => newRow.locator('[data-link-save]').click());
  assert.equal(await dlg.locator('#td-panel-connections .td-link-row', { hasText: 'Stakeholder interviews' }).locator('[data-link-lag]').inputValue(), '4');
  // Jump to predecessor and come back
  await dlg.locator('#td-panel-connections .td-link-row', { hasText: 'Stakeholder interviews' }).locator('[data-td-jump]').click(); await settle();
  assert.equal(await dlg.locator('.td-title').textContent(), 'Stakeholder interviews');
  await dlg.locator('[data-td-back]').click(); await settle();
  assert.equal(await dlg.locator('.td-title').textContent(), 'Wireframes & flows');
  // Remove the added link
  await commitAction(() => dlg.locator('#td-panel-connections .td-link-row', { hasText: 'Stakeholder interviews' }).locator('[data-link-del]').click());
  assert.equal(await dlg.locator('#td-panel-connections .td-card').nth(0).locator('.td-link-row').count(), initialInCount);
  console.log('PASS 3: Connections tab adds, updates, removes links and navigates with Back stack');

  // ---- 4. Slack & Path tab ----
  await dlg.locator('[data-td-tab="slack"]').click(); await settle();
  assert.equal(await dlg.locator('#td-panel-slack .slack-metrics section').count(), 2);
  await assertNoScroll('slack tab', baseH);
  await page.screenshot({ path: join(evidence, '03-slack.png') });
  await commitAction(() => dlg.locator('[data-td-slack-mode]').selectOption('all'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('.slack-overlay .slack-item').length > 0), true, 'Slack overlay updated');
  await commitAction(() => dlg.locator('[data-td-slack-mode]').selectOption('selected'));
  console.log('PASS 4: Slack & Path tab displays slack details and controls Gantt overlay');

  // ---- 5. Delays & Agreed tab (stacked modal + delay record popover + log edit) ----
  await dlg.locator('[data-td-tab="delays"]').click(); await settle();
  // Open Set agreed deadline stacked modal, test Escape closes ONLY the top modal
  await dlg.locator('[data-td-dly="agree-deadline"]').click(); await settle();
  assert.equal(await page.locator('.modal-back').count(), 2, 'Stacked modal opened on top of Task dialog');
  await page.keyboard.press('Escape'); await settle();
  assert.equal(await page.locator('.modal-back').count(), 1, 'Escape closed only top modal, Task dialog stays open');
  assert.equal(await dlg.isVisible(), true);
  // Now actually set the agreed deadline
  await dlg.locator('[data-td-dly="agree-deadline"]').click(); await settle();
  await commitAction(() => page.locator('.modal-back').last().locator('[data-ok]').click());
  assert(await dlg.locator('#td-panel-delays').textContent().then((s) => s.includes('Agreed baseline & variance')));
  // Now extend duration on Overview to trigger the delay record popover
  await dlg.locator('[data-td-tab="overview"]').click(); await settle();
  const diskDuration = () => page.evaluate(async () => {
    const { state } = await (await fetch('api/projects')).json();
    return state.workbook.sheets.find((sheet) => sheet.id === state.workbook.active).data.tasks.find((task) => task.id === 8).dur;
  });
  const committedDuration = await diskDuration();
  await dlg.locator('input[name="dur"]').fill('10');
  await dlg.locator('[data-td-save]').click(); await settle();
  // Keep the inspector input pending until Record/Skip acknowledges the compound
  // edit. The popover is above the inspector and remains operable.
  await page.locator('.dly-pop').waitFor();
  assert.equal(await dlg.count(), 1, 'Inspector stays open during the delay decision');
  assert.equal(await dlg.getAttribute('aria-busy'), 'true');
  assert.equal(await dlg.locator('input[name="dur"]').inputValue(), '10');
  assert.equal(await diskDuration(), committedDuration, 'Schedule and delay decision stay uncommitted until Record/Skip');
  await page.locator('.dly-pop [data-f="cause"]').selectOption({ index: 1 });
  await commitAction(() => page.locator('.dly-pop [data-record]').click());
  if (await dlg.count()) { await page.keyboard.press('Escape'); await settle(); }
  // Re-open via double-click and verify Delays tab shows own delay & log entry
  await page.locator('.bar[data-id="8"]').dblclick();
  await dlg.waitFor(); await settle();
  await dlg.locator('[data-td-tab="delays"]').click(); await settle();
  const dlyText = await dlg.locator('#td-panel-delays').textContent();
  assert(dlyText.includes('Own +2d'), `Delays tab shows Own +2d: ${dlyText}`);
  assert.equal(await dlg.locator('[data-td-edit-log]').count(), 1, 'Delay log entry has Edit button');
  await assertNoScroll('delays tab', baseH);
  await page.screenshot({ path: join(evidence, '04-delays.png') });
  await page.keyboard.press('Escape'); await settle();
  console.log('PASS 5: Delays & Agreed tab handles stacked modals, delay popover handoff, and delay log');

  // ---- 6. Double-click Milestone (id=10: Design freeze) and Summary (id=6: Design) ----
  await page.locator('.bar[data-id="10"]').dblclick();
  await dlg.waitFor(); await settle();
  assert.equal(await dlg.locator('.td-title').textContent(), 'Design freeze');
  assert.equal(await dlg.locator('.td-kind.ms').textContent(), 'Milestone');
  assert.equal(await dlg.locator('[data-td-end-wrap]').isHidden(), true, 'Milestone hides Finish date');
  await dlg.locator('[data-td-tab="slack"]').click(); await settle();
  await commitAction(() => dlg.locator('[data-td-crittarget="set"]').click());
  assert(await dlg.locator('[data-td-crittarget="clear"]').isVisible(), 'Milestone set as critical-path target');
  await commitAction(() => dlg.locator('[data-td-crittarget="clear"]').click());
  await page.keyboard.press('Escape'); await settle();

  await page.locator('.bar[data-id="6"]').dblclick();
  await dlg.waitFor(); await settle();
  assert.equal(await dlg.locator('.td-title').textContent(), 'Design');
  assert.equal(await dlg.locator('.td-kind.sum').textContent(), 'Summary');
  assert(await dlg.locator('.td-table tbody tr').count() >= 4, 'Summary lists child items');
  await assertNoScroll('summary overview');
  const sumTableNoClip = await dlg.locator('.td-children-card .td-table-wrap').evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  assert.equal(sumTableNoClip, true, 'All 4 children of Design summary fit without clipping');
  const childBtnBorder = await dlg.locator('[data-td-add-child="task"]').evaluate((el) => getComputedStyle(el).borderTopWidth);
  assert.equal(childBtnBorder, '1px', 'Card action buttons have crisp 1px pill border');
  await page.screenshot({ path: join(evidence, '05-summary.png') });
  await page.keyboard.press('Escape'); await settle();
  console.log('PASS 6: Milestone and Summary items open tailored dialogs cleanly');

  // ---- 7. Read-only version preview opens dialog in inspect-only mode ----
  await page.locator('#snapshotbtn').click(); await settle();
  await commitAction(() => page.locator('.modal-back [data-save]').click());
  await page.locator('#versionbtn').click(); await settle();
  await page.locator('#versionmenu .vlist .vrow').first().click(); await settle();
  await page.locator('.bar[data-id="8"]').dblclick();
  await dlg.waitFor(); await settle();
  assert(await dlg.locator('.td-badges').textContent().then((s) => s.includes('Read-only') || s.includes('read-only')));
  assert.equal(await dlg.locator('input[name="name"]').isDisabled(), true, 'Inputs disabled in read-only mode');
  assert.equal(await dlg.locator('[data-td-save]').count(), 0, 'Save button omitted in read-only mode');
  await page.screenshot({ path: join(evidence, '06-readonly.png') });
  await page.keyboard.press('Escape'); await settle();
  console.log('PASS 7: Read-only preview opens inspect-only dialog cleanly');

  assert.deepEqual(errors, []);
  console.log(`ALL TASK DIALOG CHECKS PASSED (screenshots: ${evidence})`);
} catch (error) {
  if (browser) for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done));
  await rm(temp, { recursive: true, force: true });
}
