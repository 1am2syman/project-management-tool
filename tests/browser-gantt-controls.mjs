// Isolated browser regression checks for:
// 1. No vertical today line or vertical calendar lines on the Gantt canvas (date axis today marker preserved)
// 2. Auto-resizing Fit view across viewport/splitter resize and task/milestone add/edit/delete
// 3. Three-way critical path toggle (off / show / only focus mode)
// 4. Hover-revealed single-row end dates (dd mmm, vertically centered within the shape), no pill on outside labels, stronger menu hover gray
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
  const settle = async () => { await saved(); return page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))); };
  await saved(); await settle();

  // ---- 1. Today vertical line and vertical calendar lines removed from Gantt canvas; date axis marker kept ----
  assert.equal(await page.locator('#todayline, .todayline').count(), 0, 'todayline must not exist on Gantt canvas');
  for (const z of ['40', '16', '6', '2.2']) {
    await page.locator(`#zoomseg [data-zoom="${z}"]`).click(); await settle();
    const vlines = await page.evaluate(() => ({
      dlPattern: document.querySelectorAll('#bg #dl').length,
      thinRects: [...document.querySelectorAll('#bg > rect')].filter((r) => Number(r.getAttribute('width')) === 1 && r.getAttribute('fill') !== 'rgba(245,158,11,.14)').length,
    }));
    assert.equal(vlines.dlPattern, 0, `no #dl vertical grid pattern at zoom ${z}`);
    assert.equal(vlines.thinRects, 0, `no vertical calendar lines at zoom ${z}`);
  }
  await page.locator('[data-act=today]').click(); await settle();
  const axisToday = await page.locator('.ghead .t3.td, .ghead .tdu').count();
  assert(axisToday >= 1, 'date axis today marker must remain present');
  console.log('PASS 1: today vertical line and vertical calendar lines removed from Gantt canvas while date axis marker stays');

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
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.bar.critical:not(.summary):not(.ms)')).backgroundColor !== 'rgb(244, 63, 94)');
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

  // ---- 4. Stronger menu hover gray, no pill on outside labels, and hover-revealed single-row end dates ----
  assert.equal(await page.locator('#optEnd').count(), 0, 'End dates toggle must be removed');

  // Check task-menu hover gray is clearly stronger than the old 0.055 alpha
  await page.locator('#gbody .r[data-id="16"] [data-col=name]').click({ button: 'right' });
  await page.locator('.task-menu').waitFor(); await settle();
  const menuItem = page.locator('.task-menu button', { hasText: 'Insert task below cascade' });
  await menuItem.hover(); await page.waitForTimeout(200);
  const hoverBg = await menuItem.evaluate((el) => getComputedStyle(el).backgroundColor);
  const alphaMatch = hoverBg.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
  assert(alphaMatch && Number(alphaMatch[1]) >= 0.1, `task-menu hover gray should be stronger (>=0.10 alpha), got ${hoverBg}`);
  await page.screenshot({ path: join(evidence, '03-task-menu-hover.png') });
  await page.keyboard.press('Escape'); await settle();

  // Add a short 1-day task so we definitely have an outside-text task bar alongside inside-text bars, summaries, and milestones
  await page.locator('#gbody .r[data-id="21"] [data-col=name]').click();
  await page.locator('[data-act=add]').click();
  await page.locator('.editor').fill('Final sign-off checklist');
  await page.keyboard.press('Enter'); await settle();
  const shortId = await page.evaluate(() => document.querySelector('#gbody .r.on')?.dataset.id);
  await page.locator(`#gbody .r[data-id="${shortId}"] [data-col=dur]`).dblclick();
  await page.locator('.editor').fill('1');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await checkFitted('after adding short task');

  // Verify outside labels (outside task bars, milestones, summaries) have NO pill styling
  const outsidePillCheck = await page.evaluate(() => [...document.querySelectorAll('.bar .label.out, .bar.ms .label, .bar.summary .label')].map((el) => {
    const cs = getComputedStyle(el);
    return {
      cls: el.parentElement.className,
      bg: cs.backgroundColor,
      radius: cs.borderRadius,
      border: cs.borderTopWidth,
      shadow: cs.boxShadow,
      padL: cs.paddingLeft,
      padR: cs.paddingRight,
    };
  }));
  assert(outsidePillCheck.length > 0, 'outside/milestone/summary labels exist');
  for (const x of outsidePillCheck) {
    assert.equal(x.bg, 'rgba(0, 0, 0, 0)', `outside label must have transparent background: ${JSON.stringify(x)}`);
    assert.equal(x.radius, '0px', `outside label must have no pill radius: ${JSON.stringify(x)}`);
    assert.equal(x.border, '0px', `outside label must have no border: ${JSON.stringify(x)}`);
    assert.equal(x.shadow, 'none', `outside label must have no shadow: ${JSON.stringify(x)}`);
  }

  // Verify all end dates are hidden when nothing is hovered
  await page.mouse.move(10, 10); await page.waitForTimeout(200);
  const hiddenCheck = await page.evaluate(() => [...document.querySelectorAll('.bar .edate')].map((ed) => {
    const cs = getComputedStyle(ed);
    return { opacity: cs.opacity, visibility: cs.visibility };
  }));
  assert(hiddenCheck.length > 0, 'all bars have .edate elements ready for hover');
  for (const x of hiddenCheck) {
    assert.equal(x.opacity, '0', `edate hidden when not hovered: ${JSON.stringify(x)}`);
    assert.equal(x.visibility, 'hidden', `edate visibility hidden when not hovered: ${JSON.stringify(x)}`);
  }

  // Helper to hover one bar of each type and verify single-row, vertical centering, position, and visibility
  async function checkHoverDates(densityLabel) {
    const targets = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('.bar')];
      const pick = (fn) => bars.find(fn)?.dataset.id || null;
      return {
        inside: pick((b) => !b.classList.contains('ms') && !b.classList.contains('summary') && !b.querySelector('.label').classList.contains('out')),
        outside: pick((b) => !b.classList.contains('ms') && !b.classList.contains('summary') && b.querySelector('.label').classList.contains('out')),
        milestone: pick((b) => b.classList.contains('ms')),
        summary: pick((b) => b.classList.contains('summary')),
      };
    });
    assert(targets.inside && targets.outside && targets.milestone && targets.summary, `all 4 bar types present (${densityLabel}): ${JSON.stringify(targets)}`);

    for (const [kind, id] of Object.entries(targets)) {
      const bar = page.locator(`.bar[data-id="${id}"]`);
      await bar.hover();
      await page.waitForTimeout(220);
      const m = await bar.evaluate((b) => {
        const ed = b.querySelector('.edate'), lbl = b.querySelector('.label'), txt = b.querySelector('.label-text');
        const bEl = ed.querySelector('b'), iEl = ed.querySelector('i');
        const br = b.getBoundingClientRect(), er = ed.getBoundingClientRect(), tr = txt.getBoundingClientRect();
        const bR = bEl.getBoundingClientRect(), iR = iEl.getBoundingClientRect();
        const cs = getComputedStyle(ed);
        return {
          opacity: cs.opacity, visibility: cs.visibility,
          directChild: ed.parentElement === b, inLabel: ed.parentElement === lbl,
          dd: bEl.textContent, mmm: iEl.textContent,
          bCenterY: bR.top + bR.height / 2, iCenterY: iR.top + iR.height / 2,
          bRight: bR.right, iLeft: iR.left,
          edCenterY: er.top + er.height / 2,
          barCenterY: br.top + br.height / 2,
          barLeft: br.left, barRight: br.right,
          edLeft: er.left, edRight: er.right,
          txtRight: tr.right,
        };
      });
      assert.equal(m.opacity, '1', `${densityLabel}/${kind}: edate visible on hover: ${JSON.stringify(m)}`);
      assert.equal(m.visibility, 'visible', `${densityLabel}/${kind}: edate visibility visible on hover: ${JSON.stringify(m)}`);
      assert.match(m.dd, /^\d{2}$/, `${densityLabel}/${kind}: 2-digit day dd: ${JSON.stringify(m)}`);
      assert.match(m.mmm, /^[A-Z][a-z]{2}$/, `${densityLabel}/${kind}: 3-letter month mmm: ${JSON.stringify(m)}`);
      // Single row: dd and mmm share the same vertical center and mmm sits to the right of dd
      assert(Math.abs(m.bCenterY - m.iCenterY) < 1, `${densityLabel}/${kind}: dd and mmm on one horizontal row: ${JSON.stringify(m)}`);
      assert(m.iLeft >= m.bRight - 0.5, `${densityLabel}/${kind}: mmm to the right of dd: ${JSON.stringify(m)}`);
      // Perfectly centered vertically within the shape
      assert(Math.abs(m.edCenterY - m.barCenterY) < 1.5, `${densityLabel}/${kind}: edate vertically centered within shape: ${JSON.stringify(m)}`);
      if (kind === 'inside') {
        assert.equal(m.directChild, true, `${densityLabel}/inside: edate is direct child of bar`);
        assert(m.edRight <= m.barRight && m.barRight - m.edRight <= 16, `${densityLabel}/inside: aligned to right inside end: ${JSON.stringify(m)}`);
        assert(m.txtRight <= m.edLeft + 1, `${densityLabel}/inside: label text must not overlap edate: ${JSON.stringify(m)}`);
        await page.screenshot({ path: join(evidence, `04-hover-inside-${densityLabel}.png`) });
      } else {
        assert.equal(m.inLabel, true, `${densityLabel}/${kind}: edate sits inside label`);
        assert(m.edLeft >= m.txtRight - 1, `${densityLabel}/${kind}: edate sits to the right of text: ${JSON.stringify(m)}`);
        if (kind === 'outside') await page.screenshot({ path: join(evidence, `05-hover-outside-${densityLabel}.png`) });
        if (kind === 'milestone') await page.screenshot({ path: join(evidence, `06-hover-milestone-${densityLabel}.png`) });
      }
    }
    // Moving mouse away hides all end dates again
    await page.locator('.brand').hover();
    await page.waitForFunction(() => !document.querySelector('.bar:hover'));
    await page.waitForFunction(() => [...document.querySelectorAll('.bar .edate')].every(ed => getComputedStyle(ed).opacity === '0'));
    const allHiddenAgain = await page.evaluate(() => [...document.querySelectorAll('.bar .edate')].every((ed) => getComputedStyle(ed).opacity === '0'));
    assert.equal(allHiddenAgain, true, `${densityLabel}: end dates hide again after mouse leaves`);
  }

  await checkHoverDates('adaptive');
  await page.getByRole('combobox', { name: 'Row density' }).selectOption('compact');
  await checkFitted('compact density');
  await checkHoverDates('compact');

  assert.deepEqual(errors, []);
  console.log('PASS 4: hover gray stronger, outside labels have no pill, and single-row vertically centered end dates show on bar hover');
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
