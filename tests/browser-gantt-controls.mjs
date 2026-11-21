// Isolated browser regression checks for:
// 1. No vertical today line on the Gantt canvas (date axis today marker preserved)
// 2. Auto-resizing Fit view across viewport/splitter resize and task/milestone add/edit/delete
// 3. Three-way critical path toggle (off / show / only focus mode)
// 4. Activity end date toggle (2-row dd / mmm: right-inside for inside labels, right of text for outside labels & milestones)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-gantt-controls-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'gantt-controls') : join(temp, 'screenshots');
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
  const context = await browser.newContext({ viewport: { width: 1630, height: 900 } });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator('#gbody .r[data-id="21"]').waitFor();
  const saved = () => page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await saved(); await settle();

  // ---- 1. Today vertical line removed from Gantt canvas; date axis marker kept ----
  assert.equal(await page.locator('#todayline, .todayline').count(), 0, 'todayline must not exist on Gantt canvas');
  await page.locator('[data-act=today]').click(); await settle();
  const axisToday = await page.locator('.ghead .t3.td, .ghead .tdu').count();
  assert(axisToday >= 1, 'date axis today marker must remain present');
  console.log('PASS 1: today vertical line removed from Gantt canvas while date axis marker stays');

  // ---- 2. Auto-resizing Fit view ----
  const checkFitted = async (label) => {
    await settle(); await settle();
    const state = await page.evaluate(() => {
      const gb = document.querySelector('#gb'), v = gb.getBoundingClientRect();
      const bars = [...document.querySelectorAll('.bar')].map((b) => {
        const br = b.getBoundingClientRect(), lr = b.querySelector('.label').getBoundingClientRect();
        return { id: b.dataset.id, left: Math.min(br.left, lr.left) - v.left, right: Math.max(br.right, lr.right) - v.left, width: gb.clientWidth };
      });
      return { fitOn: document.querySelector('[data-fit]').classList.contains('on'), scrollLeft: gb.scrollLeft, width: gb.clientWidth, bars };
    });
    assert.equal(state.fitOn, true, `${label}: Fit button stays selected`);
    assert(state.scrollLeft <= 1, `${label}: Fit keeps scrollLeft at 0 (${state.scrollLeft})`);
    for (const b of state.bars) {
      assert(b.left >= -1, `${label}: bar ${b.id} clipped left ${JSON.stringify(b)}`);
      assert(b.right <= b.width - 4, `${label}: bar ${b.id} clipped right ${JSON.stringify(b)}`);
    }
    return state;
  };

  await page.locator('[data-fit]').click();
  const fitInitial = await checkFitted('initial fit');
  await page.screenshot({ path: join(evidence, '01-fit-default.png') });

  // Viewport resize while in Fit auto-refits
  await page.setViewportSize({ width: 1280, height: 800 });
  const fitNarrow = await checkFitted('viewport shrink');
  assert(fitNarrow.width < fitInitial.width, 'Gantt pane actually shrank');
  await page.setViewportSize({ width: 1630, height: 900 });
  await checkFitted('viewport restore');

  // Splitter drag while in Fit auto-refits
  const splitBox = await page.locator('#split').boundingBox();
  await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(splitBox.x + 220, splitBox.y + 200, { steps: 6 });
  await page.mouse.up();
  const fitSplit = await checkFitted('splitter drag narrower');
  assert(fitSplit.width < fitInitial.width - 150, `splitter reduced Gantt width (${fitSplit.width} vs ${fitInitial.width})`);
  // Restore splitter width
  const splitBox2 = await page.locator('#split').boundingBox();
  await page.mouse.move(splitBox2.x + splitBox2.width / 2, splitBox2.y + 200);
  await page.mouse.down();
  await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox2.y + 200, { steps: 6 });
  await page.mouse.up();
  await checkFitted('splitter restored');

  // Adding a task and extending it far into the future auto-refits
  await page.locator('#gbody .r[data-id="21"] [data-col=name]').click();
  await page.locator('[data-act=add]').click();
  await page.locator('.editor').fill('Extended follow-up phase');
  await page.keyboard.press('Enter'); await settle();
  const addedId = await page.evaluate(() => document.querySelector('#gbody .r.on')?.dataset.id);
  assert(addedId, 'added task row exists');
  await page.locator(`#gbody .r[data-id="${addedId}"] [data-col=dur]`).dblclick();
  await page.locator('.editor').fill('40');
  await page.keyboard.press('Enter');
  await checkFitted('after adding 40d task');

  // Adding a milestone far later auto-refits
  await page.locator('[data-act=addms]').click();
  await page.locator('.editor').fill('Post-launch audit');
  await page.keyboard.press('Enter'); await settle();
  const msId = await page.evaluate(() => document.querySelector('#gbody .r.on')?.dataset.id);
  await page.locator(`#gbody .r[data-id="${msId}"] [data-col=start]`).dblclick();
  await page.locator('.editor').fill('2027-06-15');
  await page.keyboard.press('Enter');
  await checkFitted('after adding far milestone');

  // Deleting the far milestone and task auto-refits back
  await page.locator(`#gbody .r[data-id="${msId}"] [data-col=name]`).click();
  await page.locator('[data-act=del]').click();
  await checkFitted('after deleting milestone');
  await page.locator(`#gbody .r[data-id="${addedId}"] [data-col=name]`).click();
  await page.locator('[data-act=del]').click();
  await checkFitted('after deleting task');

  // Reload preserves Fit mode
  await saved();
  await page.reload();
  await page.locator('#gbody .r[data-id="21"]').waitFor();
  await checkFitted('after reload');

  // Manual zoom exits Fit mode
  await page.locator('#zoomseg [data-zoom="16"]').click(); await settle();
  assert.equal(await page.locator('[data-fit]').evaluate((el) => el.classList.contains('on')), false, 'zoom preset exits Fit mode');
  await page.locator('[data-fit]').click(); await checkFitted('re-enter fit');
  console.log('PASS 2: Fit mode auto-resizes on viewport/splitter resize, task/milestone add/edit/delete, persists across reload, and exits on manual zoom');

  // ---- 3. Three-way Critical Path toggle (off / show / only) ----
  const critMode = () => page.locator('#critmode').getAttribute('data-mode');
  assert.equal(await critMode(), 'show', 'default critical mode is show');
  // Select a non-critical task while Focus is ON to verify Only overrides task focus cleanly
  await page.locator('#gbody .r[data-id="6"] [data-col=name]').click(); await settle();
  // Switch to OFF
  await page.locator('#critmode [data-crit=off]').click(); await settle();
  assert.equal(await critMode(), 'off');
  assert.equal(await page.locator('#app').evaluate((el) => el.classList.contains('crit-on')), false);
  const critBarOffColor = await page.locator('.bar.critical:not(.summary):not(.ms)').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(critBarOffColor, 'rgb(244, 63, 94)', 'critical bar is not red when off');
  // Switch to SHOW
  await page.locator('#critmode [data-crit=show]').click(); await settle();
  assert.equal(await critMode(), 'show');
  assert.equal(await page.locator('#app').evaluate((el) => el.classList.contains('crit-on')), true);
  assert.equal(await page.locator('#app').evaluate((el) => el.classList.contains('crit-only')), false);
  // Switch to ONLY (critical-path-only focus mode)
  await page.locator('#critmode [data-crit=only]').click(); await settle();
  assert.equal(await critMode(), 'only');
  const onlyState = await page.evaluate(() => {
    const app = document.querySelector('#app');
    const critBars = [...document.querySelectorAll('.bar.critical:not(.summary)')];
    const nonCritBars = [...document.querySelectorAll('.bar:not(.critical):not(.summary)')];
    const critLinksHi = document.querySelectorAll('svg.links-hi .lk.crit').length;
    const nonCritLinksDim = [...document.querySelectorAll('.lk:not(.crit)')].every((l) => l.classList.contains('dim'));
    const legend = document.querySelector('#focusleg');
    return {
      focusing: app.classList.contains('focusing'),
      critOnly: app.classList.contains('crit-only'),
      allCritInFocus: critBars.length > 0 && critBars.every((b) => !b.classList.contains('dim')),
      allNonCritDim: nonCritBars.length > 0 && nonCritBars.every((b) => b.classList.contains('dim')),
      critLinksHi,
      nonCritLinksDim,
      legendVisible: !legend.hidden,
      legendText: legend.textContent,
    };
  });
  assert.equal(onlyState.focusing, true, JSON.stringify(onlyState));
  assert.equal(onlyState.critOnly, true, JSON.stringify(onlyState));
  assert.equal(onlyState.allCritInFocus, true, JSON.stringify(onlyState));
  assert.equal(onlyState.allNonCritDim, true, JSON.stringify(onlyState));
  assert(onlyState.critLinksHi > 0, `critical links elevated to links-hi: ${JSON.stringify(onlyState)}`);
  assert.equal(onlyState.nonCritLinksDim, true, JSON.stringify(onlyState));
  assert.equal(onlyState.legendVisible, true, JSON.stringify(onlyState));
  assert(onlyState.legendText.includes('Critical path only'), JSON.stringify(onlyState));
  await page.screenshot({ path: join(evidence, '02-critical-only-focus.png') });
  // Reload restores 'only' mode from SQLite
  await saved(); await page.reload(); await page.locator('#gbody .r[data-id="21"]').waitFor(); await settle();
  assert.equal(await critMode(), 'only', 'critical-only mode persists across reload');
  // Return to 'show'
  await page.locator('#critmode [data-crit=show]').click(); await settle();
  assert.equal(await critMode(), 'show');
  console.log('PASS 3: three-way critical path toggle (off / show / only focus mode) works and persists');

  // ---- 4. Activity end date toggle (2-row dd / mmm) ----
  assert.equal(await page.locator('.edate').count(), 0, 'no end dates when toggle is off');
  await page.locator('label.switch').filter({ has: page.locator('#optEnd') }).click();
  await checkFitted('fit auto-resizes when end dates enabled');

  // Add a short 1-day task so we definitely have an outside-text task bar alongside inside-text bars and milestones
  await page.locator('#gbody .r[data-id="21"] [data-col=name]').click();
  await page.locator('[data-act=add]').click();
  await page.locator('.editor').fill('Final sign-off checklist');
  await page.keyboard.press('Enter'); await settle();
  const shortId = await page.evaluate(() => document.querySelector('#gbody .r.on')?.dataset.id);
  await page.locator(`#gbody .r[data-id="${shortId}"] [data-col=dur]`).dblclick();
  await page.locator('.editor').fill('1');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await checkFitted('after adding short task with end dates');

  const edateReport = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.bar')].map((b) => {
      const ed = b.querySelector('.edate');
      const lbl = b.querySelector('.label');
      const txt = b.querySelector('.label-text');
      const br = b.getBoundingClientRect(), er = ed?.getBoundingClientRect(), tr = txt.getBoundingClientRect();
      return {
        id: b.dataset.id,
        ms: b.classList.contains('ms'),
        summary: b.classList.contains('summary'),
        out: lbl.classList.contains('out'),
        directChild: ed?.parentElement === b,
        inLabel: ed?.parentElement === lbl,
        dd: ed?.querySelector('b')?.textContent,
        mmm: ed?.querySelector('i')?.textContent,
        ddTop: ed?.querySelector('b')?.getBoundingClientRect().top,
        mmmTop: ed?.querySelector('i')?.getBoundingClientRect().top,
        barLeft: br.left, barRight: br.right,
        edLeft: er?.left, edRight: er?.right,
        txtRight: tr.right,
      };
    });
    return items;
  });

  const insideBars = edateReport.filter((x) => !x.ms && !x.summary && !x.out);
  const outsideBars = edateReport.filter((x) => !x.ms && !x.summary && x.out);
  const milestones = edateReport.filter((x) => x.ms);
  assert(insideBars.length > 0, 'at least one inside-text task bar');
  assert(outsideBars.length > 0, 'at least one outside-text task bar');
  assert(milestones.length > 0, 'at least one milestone');

  for (const x of edateReport) {
    assert.match(x.dd, /^\d{2}$/, `2-digit day dd: ${JSON.stringify(x)}`);
    assert.match(x.mmm, /^[A-Z][a-z]{2}$/, `3-letter month mmm: ${JSON.stringify(x)}`);
    assert(x.mmmTop > x.ddTop, `mmm must be below dd (two rows): ${JSON.stringify(x)}`);
  }
  for (const x of insideBars) {
    assert.equal(x.directChild, true, `inside bar end date is inside bar: ${JSON.stringify(x)}`);
    assert(x.edRight <= x.barRight && x.barRight - x.edRight <= 16, `inside end date aligned to right inside end: ${JSON.stringify(x)}`);
    assert(x.txtRight <= x.edLeft + 1, `inside label text must not overlap end date: ${JSON.stringify(x)}`);
  }
  for (const x of outsideBars) {
    assert.equal(x.inLabel, true, `outside bar end date sits in outside label: ${JSON.stringify(x)}`);
    assert(x.edLeft >= x.txtRight - 1, `outside end date sits to the right of text: ${JSON.stringify(x)}`);
  }
  for (const x of milestones) {
    assert.equal(x.inLabel, true, `milestone end date sits in milestone label: ${JSON.stringify(x)}`);
    assert(x.edLeft >= x.txtRight - 1, `milestone end date sits to the right of text: ${JSON.stringify(x)}`);
  }

  await page.screenshot({ path: join(evidence, '03-end-dates-adaptive.png') });
  await page.getByRole('combobox', { name: 'Row density' }).selectOption('compact');
  await checkFitted('end dates compact density');
  await page.screenshot({ path: join(evidence, '04-end-dates-compact.png') });

  // Both Critical-only + End dates together
  await page.locator('#critmode [data-crit=only]').click(); await settle();
  await page.screenshot({ path: join(evidence, '05-crit-only-and-end-dates.png') });

  // Toggle end dates OFF removes them cleanly
  await page.locator('label.switch').filter({ has: page.locator('#optEnd') }).click(); await settle();
  assert.equal(await page.locator('.edate').count(), 0, 'turning end dates off removes all .edate nodes');
  assert.deepEqual(errors, []);
  console.log('PASS 4: activity end dates render as 2-row dd/mmm in exact inside/outside/milestone positions');
  console.log(`ALL GANTT CONTROL CHECKS PASSED (screenshots: ${evidence})`);
} catch (error) {
  if (browser) for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done));
  await rm(temp, { recursive: true, force: true });
}
