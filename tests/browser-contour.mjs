// Contour backdrop and Motion Brew chrome: every dialog and menu gets an animated canvas directly behind it, plain surfaces stay plain,
// the canvas never blocks clicks, closing removes it, reduced motion draws one still frame, and a failed script leaves white surfaces.
// The main page gets one quiet corner of the same lines (bottom-left of the work area, fading out by 60% of the page width), behind the grid and Gantt.
// It listens to the pointer anywhere on the page: movement far from the corner makes the lines flow and ripple.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-contour-'));
const evidence = process.env.PLAN_TEST_ARTIFACTS ? resolve(process.env.PLAN_TEST_ARTIFACTS, 'contour') : join(temp, 'screenshots');
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
  const errors = [], external = [];
  async function open({ reducedMotion = 'no-preference', block = null } = {}) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion });
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== new URL(url).origin) { external.push(u.href); return route.abort(); }
      if (block && u.pathname.endsWith(block)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url); await page.locator('#gbody .r').first().waitFor();
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    return { context, page };
  }
  const canvases = (page) => page.locator('.contour-canvas');
  // Number of non-white pixels and a cheap fingerprint of the picture, read straight from the canvas.
  const ink = (page, i = 0) => page.locator('.contour-canvas').nth(i).evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, sum = 0;
    for (let k = 0; k < d.length; k += 4) { if (d[k] < 250) n++; sum = (sum * 31 + d[k] + d[k + 1] * 3 + (k % 977)) % 1000003; }
    return { n, sum, w: c.width, h: c.height };
  });
  // The same for the page corner: its canvas is transparent, so count and fingerprint the alpha channel.
  const corner = (page) => page.locator('.contour-ambient').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, sum = 0;
    for (let k = 3; k < d.length; k += 4) { if (d[k] > 0) n++; sum = (sum * 31 + d[k] + (k % 977)) % 1000003; }
    return { n, sum };
  });
  const behind = (page, selector) => page.locator(selector).evaluate((el) => {
    const c = el.previousElementSibling;
    if (!c?.classList.contains('contour-canvas')) return null;
    const a = el.getBoundingClientRect(), b = c.getBoundingClientRect();
    return { on: el.classList.contains('contour-on'), dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top), dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height), events: getComputedStyle(c).pointerEvents };
  });
  const settle = (page, ms = 200) => page.evaluate((t) => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), t)), ms);
  const aligned = (r, what) => { assert(r, `${what}: a canvas sits directly behind the surface`); assert(r.on, `${what}: surface is transparent over the canvas`); assert(r.dx < 1.5 && r.dy < 1.5 && r.dw < 1.5 && r.dh < 1.5, `${what}: canvas covers the surface exactly ${JSON.stringify(r)}`); assert.equal(r.events, 'none', `${what}: canvas ignores the pointer`); };

  // ---------- fonts and tokens ----------
  const { context, page } = await open();
  assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /^Geist/, 'the app is set in Geist');
  assert(await page.evaluate(() => document.fonts.check('600 14px Geist') && document.fonts.check('12px "Geist Mono"')), 'both bundled font files load');
  assert.equal(await canvases(page).count(), 0, 'no canvas while nothing is open');
  await page.screenshot({ path: join(evidence, 'main.png') });

  // ---------- dialog: Settings ----------
  await page.locator('#settingsbtn').click(); await page.locator('.modal').waitFor(); await settle(page);
  aligned(await behind(page, '.modal'), 'Settings dialog');
  assert.equal(await canvases(page).count(), 1);
  const early = await ink(page);
  assert(early.n > 100, `lines are visible once the dialog has opened (${early.n} px)`);
  const share = early.n / (early.w * early.h);
  assert(share < 0.2, `lines stay a light texture, not a fill (${(share * 100).toFixed(1)}%)`);
  await settle(page, 1800);
  const later = await ink(page);
  assert.notEqual(early.sum, later.sum, 'the contours drift while the dialog is open');
  // The canvas must not block the dialog: the real controls answer clicks.
  const hit = await page.evaluate(() => { const b = document.querySelector('.modal .m-x').getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.m-x') != null; });
  assert(hit, 'the close button is what a click would hit');
  const modalBg = await page.locator('.modal').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(modalBg, 'rgba(0, 0, 0, 0)', 'the dialog surface itself is transparent while the canvas is behind it');
  // Pointer hill: moving over the dialog changes the picture.
  const box = await page.locator('.modal').boundingBox();
  const before = await ink(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20); await settle(page, 300);
  const hovered = await ink(page);
  assert.notEqual(before.sum, hovered.sum, 'the lines react to the pointer');
  await page.screenshot({ path: join(evidence, 'dialog-settings.png') });
  await page.locator('.modal .m-x').click(); await page.locator('.modal').waitFor({ state: 'detached' }); await settle(page);
  assert.equal(await canvases(page).count(), 0, 'closing the dialog removes its canvas');

  // ---------- the other dialogs, each opened from the real button ----------
  for (const [button, name] of [['#calendarbtn', 'Project calendar'], ['#impbtn', 'Import']]) {
    await page.locator(button).click(); await page.locator('.modal').waitFor(); await settle(page);
    aligned(await behind(page, '.modal'), name);
    await page.screenshot({ path: join(evidence, `dialog-${name.toLowerCase().replace(/\W+/g, '-')}.png`) });
    await page.keyboard.press('Escape'); await page.locator('.modal').waitFor({ state: 'detached' }).catch(() => {}); await settle(page);
    if (await page.locator('.modal').count()) { await page.locator('.modal .m-x').first().click(); await page.locator('.modal').waitFor({ state: 'detached' }); }
    assert.equal(await canvases(page).count(), 0, `${name}: canvas removed on close`);
  }

  // ---------- menus and popovers: static ones toggle `hidden`, the others are appended to <body> ----------
  const surfaces = [
    ['#expbtn', '#expmenu', 'Export menu'], ['#tplbtn', '#tplpop', 'Templates popover'], ['#colbtn', '#colpop', 'Columns popover'], ['#versionbtn', '#versionmenu', 'Versions menu'],
  ];
  for (const [button, menu, name] of surfaces) {
    await page.locator(button).click(); await page.locator(menu).waitFor({ state: 'visible' }); await settle(page);
    aligned(await behind(page, menu), name);
    assert.equal(await canvases(page).count(), 1, `${name}: exactly one canvas`);
    await page.screenshot({ path: join(evidence, `menu-${menu.slice(1)}.png`) });
    await page.keyboard.press('Escape'); await page.mouse.click(700, 400); await settle(page);
    if (await page.locator(menu).isVisible()) await page.locator(button).click();
    await page.locator(menu).waitFor({ state: 'hidden' }); await settle(page);
    assert.equal(await canvases(page).count(), 0, `${name}: canvas removed when the menu hides`);
  }
  await page.locator('.tab.on').first().click({ button: 'right' }); await page.locator('#ctxmenu').waitFor({ state: 'visible' }); await settle(page);
  aligned(await behind(page, '#ctxmenu'), 'Sheet context menu');
  await page.screenshot({ path: join(evidence, 'menu-ctxmenu.png' ) });
  const itemHit = await page.evaluate(() => { const b = document.querySelector('#ctxmenu button'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + 8, r.top + r.height / 2)?.closest('button') === b; });
  assert(itemHit, 'menu items stay clickable above the canvas');
  await page.keyboard.press('Escape'); await page.mouse.click(700, 400); await settle(page);
  await page.locator('#gbody .r[data-id="5"] [data-col=name]').click({ button: 'right' }); await page.locator('.task-menu').waitFor(); await settle(page);
  aligned(await behind(page, '.task-menu'), 'Task menu');
  await page.screenshot({ path: join(evidence, 'menu-task.png') });
  await page.keyboard.press('Escape'); await page.locator('.task-menu').waitFor({ state: 'detached' }).catch(() => {}); await settle(page);
  assert.equal(await canvases(page).count(), 0, 'task menu: canvas removed with the menu');

  // ---------- surfaces that stay plain ----------
  await page.locator('#analysisbtn').click(); await page.locator('#analysis').waitFor({ state: 'visible' }); await settle(page);
  assert.equal(await canvases(page).count(), 0, 'the full-page analysis view has no contour');
  assert.equal(await page.locator('#analysis').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(248, 247, 243)', 'and keeps its warm alabaster canvas');
  await page.keyboard.press('Escape'); await settle(page);
  if (await page.locator('#analysis').isVisible()) await page.locator('#analysisbtn').click();
  await page.locator('#logbtn').click(); await page.locator('#diagnostics-dialog[open]').waitFor(); await settle(page);
  assert.equal(await canvases(page).count(), 0, 'the diagnostic log dialog has no contour');
  assert.equal(await page.locator('#diagnostics-dialog').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)', 'and stays solid white');
  await page.keyboard.press('Escape');

  // ---------- chrome: buttons, forms, focus ----------
  await page.locator('#settingsbtn').click(); await page.locator('.modal').waitFor(); await settle(page);
  // The dialog focuses its first field, which is white with an ink border by design. Blur it and let the 150ms colour transition finish.
  await page.evaluate(() => document.activeElement?.blur()); await settle(page, 400);
  const style = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el), add = [...document.querySelectorAll('.modal button')].find((b) => /Add cause/.test(b.textContent)), input = document.querySelector('.modal .dly-addrow input');
    return { btnBg: cs(add).backgroundColor, btnRadius: cs(add).borderRadius, btnColor: cs(add).color, inBg: cs(input).backgroundColor, inRadius: cs(input).borderRadius, modalRadius: cs(document.querySelector('.modal')).borderRadius };
  });
  assert.equal(style.btnBg, 'rgb(22, 21, 19)', 'the main action is an ink button, not blue');
  assert.equal(style.btnColor, 'rgb(255, 255, 255)');
  assert(parseFloat(style.btnRadius) >= 100 || style.btnRadius.includes('9999') || style.btnRadius.includes('e+'), `pill radius: ${style.btnRadius}`);
  assert.equal(style.inBg, 'rgb(244, 243, 239)', 'form fields are warm stone tiles');
  assert.equal(style.modalRadius, '24px');
  await page.locator('.modal .dly-addrow input').focus(); await settle(page, 400);
  const ring = await page.locator('.modal .dly-addrow input').evaluate((el) => getComputedStyle(el).borderTopColor);
  assert.equal(ring, 'rgb(22, 21, 19)', 'focus is ink-black');
  await page.locator('.modal .m-x').click(); await settle(page);
  await context.close();

  // ---------- grid and Gantt: same language, same geometry, and no animated backdrop ----------
  const { context: dataContext, page: data } = await open();
  const view = await data.evaluate(() => {
    const cs = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
    // A plain task bar: the first bars in the demo are summaries (7px) and milestones, which look different by design.
    const plain = '.bar:not(.summary):not(.ms):not(.critical)', crit = '.bar.critical:not(.summary):not(.ms)';
    const fill = document.querySelector(`${plain} .fill`);
    return {
      font: cs('#gbody .r .c.nm').fontFamily, mono: cs('#gbody .r .c:not(.nm):not(.rn)').fontFamily,
      row: cs('#gbody .r').height, bar: cs(plain).height, barBg: cs(plain).backgroundColor, barRadius: cs(plain).borderRadius,
      fillBg: fill ? getComputedStyle(fill).backgroundColor : null, critBg: cs(crit).backgroundColor,
      band: cs('.g-band .c:not(.hl):not(:first-child)').backgroundColor, today: cs('.ghead .t3.td').backgroundColor,
    };
  });
  assert.match(view.font, /^Geist/, 'grid text is set in Geist'); assert.match(view.mono, /^"?Geist Mono/, 'grid figures are set in Geist Mono');
  assert.equal(view.row, '24px', 'row height unchanged'); assert.equal(view.bar, '18px', 'bar height unchanged');
  assert.equal(view.barBg, 'rgb(87, 84, 77)', 'task bars are warm ink-grey'); assert.equal(view.fillBg, 'rgb(22, 21, 19)', 'progress fills are ink');
  assert.equal(view.barRadius, '9999px', 'task bars are pills');
  assert.equal(view.critBg, 'rgb(244, 63, 94)', 'critical-path red is unchanged');
  assert.equal(view.band, 'rgb(250, 249, 246)', 'the sheet header band is a warm alabaster tile'); assert.equal(view.today, 'rgb(22, 21, 19)', 'the current day is ink');
  // Selection uses crisp obsidian ink, matching the rest of the palette with zero stray blue.
  await data.locator('#gbody .r[data-id="7"] [data-col=dur]').click();
  assert.equal(await data.locator('#gbody .c.sel').first().evaluate((el) => getComputedStyle(el).outlineColor), 'rgb(22, 21, 19)', 'the selected cell outline is obsidian ink');
  // No stray accent colours: the sheet tab, the selected-column header and the focus-mode tones are ink or grey, never blue, teal or purple.
  const accents = await data.evaluate(() => {
    const cs = (el, prop) => getComputedStyle(el)[prop], root = getComputedStyle(document.documentElement);
    return {
      tab: cs(document.querySelector('.tab.on .sd'), 'backgroundColor'), tabLine: cs(document.querySelector('.tab.on'), 'boxShadow'),
      colHead: cs(document.querySelector('.g-letters .c.sel'), 'color'), tones: ['--hier', '--up', '--down'].map((v) => root.getPropertyValue(v).trim()),
    };
  });
  assert.equal(accents.tab, 'rgb(22, 21, 19)', 'the active sheet tab dot is ink, whatever colour the sheet was given');
  assert.match(accents.tabLine, /rgb\(22, 21, 19\)/, 'the active sheet tab underline is ink'); assert.equal(accents.colHead, 'rgb(22, 21, 19)', 'the selected column letter is ink');
  assert.deepEqual(accents.tones, ['#161513', '#57544d', '#8b877d'], 'focus-mode tones are ink, ink-grey and light grey');
  await data.locator('#optFocus').evaluate((el) => { if (!el.checked) el.click(); });
  await data.locator('#gbody .r[data-id="9"] .c.nm').click(); await settle(data, 300);
  const rails = await data.evaluate(() => [...document.querySelectorAll('.r.r-up .c.rn, .r.r-down .c.rn, .r.r-anc .c.rn, .r.r-desc .c.rn')].map((el) => getComputedStyle(el).boxShadow));
  assert(rails.length > 0, 'focus mode marks related rows');
  for (const shadow of rails) assert(!/rgb\((13, 148, 136|124, 58, 237|43, 89, 230)\)/.test(shadow), `focus rail is not teal, purple or blue: ${shadow}`);
  // The main page has no animated canvas inside the grid or the Gantt, however the pointer moves over them or a bar is pressed.
  await data.mouse.move(1100, 420); await data.mouse.move(1300, 560, { steps: 8 });
  await data.locator('.bar:not(.summary):not(.ms)').first().click();
  await settle(data, 600);
  assert.equal(await data.locator('.contour-canvas').count(), 0, 'no dialog canvas on the grid or Gantt page');
  assert.equal(await data.locator('#gb canvas, #gx canvas, .gx canvas, #canvas canvas').count(), 0, 'nothing is drawn inside the grid or the Gantt');

  // ---------- the quiet corner ----------
  assert.equal(await data.locator('.contour-ambient').count(), 1, 'exactly one corner canvas on the main page');
  const geo = await data.evaluate(() => {
    const c = document.querySelector('.contour-ambient'), r = c.getBoundingClientRect(), m = document.getElementById('main').getBoundingClientRect(), cs = getComputedStyle(c);
    const probe = document.elementFromPoint(40, m.bottom - 20);
    return { left: r.left, bottom: r.bottom, width: r.width, height: r.height, mainBottom: m.bottom, mainHeight: m.height, page: document.documentElement.clientWidth,
      z: cs.zIndex, events: cs.pointerEvents, position: cs.position, mask: cs.maskImage || cs.webkitMaskImage, probe: probe?.className || probe?.tagName, inBody: c.parentElement === document.body, hidden: c.getAttribute('aria-hidden') };
  });
  assert(Math.abs(geo.left) < 1 && Math.abs(geo.bottom - geo.mainBottom) < 1.5, `the corner sits at the bottom-left of the work area (${geo.left}, ${geo.bottom} vs ${geo.mainBottom})`);
  assert(Math.abs(geo.width - Math.round(geo.page * 0.6)) <= 1, `it is 60% of the page wide (${geo.width} of ${geo.page})`);
  assert(geo.height <= geo.width + 1 && geo.height <= geo.mainHeight + 1, 'and never taller than that or than the work area');
  assert.equal(geo.z, '-1', 'behind the grid and Gantt'); assert.equal(geo.events, 'none', 'it never takes the pointer'); assert.equal(geo.position, 'fixed'); assert.equal(geo.hidden, 'true');
  assert(geo.inBody, 'it lives outside the grid and Gantt');
  assert.notEqual(geo.probe, 'contour-ambient', 'the content, not the canvas, answers at the corner');
  const r1 = (v) => (Math.round(v * 10) / 10).toString().replace('.', '\\.');
  assert(new RegExp(`${r1(geo.page * 0.01)}px`).test(geo.mask) && new RegExp(`${r1(geo.page * 0.6)}px`).test(geo.mask) && /0(px)? 100%/.test(geo.mask), `a radial mask from the corner: full to 1% of the page, gone at 60% (${geo.mask})`);
  // Behind the content: over the task rows the picture is identical with and without the canvas. Focus mode is switched off first, because it dims unrelated rows to half
  // opacity, and a half-transparent row lets the faint lines show through.
  await data.locator('#optFocus').evaluate((el) => { if (el.checked) el.click(); }); await settle(data, 300);
  const rowsBox = await data.evaluate(() => { const t = document.querySelector('#gbody .tot').getBoundingClientRect(), g = document.querySelector('.g-headrow').getBoundingClientRect(), c = document.querySelector('.contour-ambient').getBoundingClientRect(); return { top: Math.max(g.bottom, c.top), bottom: t.bottom - 2 }; });
  assert(rowsBox.bottom - rowsBox.top > 150, 'there are rows over the corner to test against');
  const rowsClip = { x: 0, y: Math.ceil(rowsBox.top), width: 300, height: Math.floor(rowsBox.bottom - rowsBox.top) };
  const withCorner = await data.screenshot({ clip: rowsClip });
  await data.addStyleTag({ content: '.contour-ambient{visibility:hidden !important}' }); await settle(data, 200);
  const withoutCorner = await data.screenshot({ clip: rowsClip });
  await data.addStyleTag({ content: '.contour-ambient{visibility:visible !important}' }); await settle(data, 200);
  assert(withCorner.equals(withoutCorner), 'the grid rows cover the corner completely: the lines show only where the page is empty');
  // Pixels: hide the app so only the corner shows, then look at what a visitor would see. Near the corner there are lines; past 60% nothing.
  await data.addStyleTag({ content: '#app{visibility:hidden !important}' }); await settle(data, 400);
  const clip = { x: 0, y: Math.max(0, Math.round(geo.bottom - geo.height) - 40), width: Math.round(geo.width) + 40, height: Math.round(geo.height) + 40 };
  const shot = (await data.screenshot({ clip })).toString('base64');
  const seen = await data.evaluate(async ({ b64, clip, page }) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: 'image/png' }));
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height; const cx = cv.getContext('2d'); cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data, scale = bmp.width / clip.width, cornerY = cv.height - 40 * scale; // the corner is 40px above the bottom of the clip
    let near = 0, far = 0;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const dist = Math.hypot(x / scale, (cornerY - y) / scale), v = d[(y * cv.width + x) * 4];
      if (y <= cornerY && v < 254) { if (dist < page * 0.12) near++; else if (dist > page * 0.6 + 2) far++; }
    }
    return { near, far };
  }, { b64: shot, clip, page: geo.page });
  assert(seen.near > 50, `lines are visible near the corner (${seen.near} px)`);
  assert.equal(seen.far, 0, `nothing is visible past 60% of the page width (${seen.far} px)`);
  await data.screenshot({ path: join(evidence, 'page-corner.png') });
  await data.addStyleTag({ content: '#app{visibility:visible !important}' });
  // It moves while the page is idle, and it rests while a dialog covers the page.
  const idleA = await corner(data); await settle(data, 500); const idleB = await corner(data);
  assert.notEqual(idleA.sum, idleB.sum, 'the corner drifts while the page is idle');
  // The corner hears the pointer anywhere on the page: far from the corner (top-right) the lines change faster than when the pointer rests there.
  const churn = (ms, act) => data.evaluate(async ({ ms, run }) => {
    const c = document.querySelector('.contour-ambient'), grab = () => c.getContext('2d').getImageData(0, 0, c.width, c.height).data, wait = (t) => new Promise((r) => setTimeout(r, t));
    const frames = []; const end = performance.now() + ms; while (performance.now() < end) { frames.push(Uint8ClampedArray.from(grab())); await wait(90); }
    let total = 0; for (let f = 1; f < frames.length; f++) for (let k = 3; k < frames[f].length; k += 16) total += Math.abs(frames[f][k] - frames[f - 1][k]);
    return total;
  }, { ms, run: act });
  await data.mouse.move(1300, 150); await settle(data, 1500); // park the pointer far from the corner and let everything calm down
  const calm = await churn(900);
  const moving = data.mouse.move(1300, 150).then(async () => { for (let k = 0; k < 40; k++) { await data.mouse.move(1000 + (k % 2 ? 300 : 0), 120 + (k % 5) * 40, { steps: 3 }); await data.waitForTimeout(20); } });
  const lively = await churn(900); await moving;
  assert(lively > calm * 1.3, `moving the pointer far from the corner stirs the lines (${lively} vs ${calm} when it rests)`);
  await settle(data, 1200);
  await data.locator('#settingsbtn').click(); await data.locator('.modal').waitFor(); await settle(data, 400);
  const coveredA = await corner(data); await settle(data, 500); const coveredB = await corner(data);
  assert.equal(coveredA.sum, coveredB.sum, 'the corner rests while a dialog is open');
  await data.locator('.modal .m-x').click(); await data.locator('.modal').waitFor({ state: 'detached' }); await settle(data, 600);
  const resumedA = await corner(data); await settle(data, 500); const resumedB = await corner(data);
  assert.notEqual(resumedA.sum, resumedB.sum, 'and moves again once it closes');
  // A narrower window keeps the proportions.
  await data.setViewportSize({ width: 1000, height: 700 }); await settle(data, 500);
  const narrow = await data.evaluate(() => { const r = document.querySelector('.contour-ambient').getBoundingClientRect(); return { width: r.width, page: document.documentElement.clientWidth, bottom: r.bottom, mainBottom: document.getElementById('main').getBoundingClientRect().bottom }; });
  assert(Math.abs(narrow.width - Math.round(narrow.page * 0.6)) <= 1 && Math.abs(narrow.bottom - narrow.mainBottom) < 1.5, `the corner follows a resize (${narrow.width} of ${narrow.page})`);
  await dataContext.close();

  // ---------- reduced motion: one still frame, no animation ----------
  const still = await open({ reducedMotion: 'reduce' });
  await still.page.locator('#settingsbtn').click(); await still.page.locator('.modal').waitFor(); await settle(still.page);
  aligned(await behind(still.page, '.modal'), 'Reduced-motion dialog');
  const a = await ink(still.page); await settle(still.page, 900); const b = await ink(still.page);
  assert(a.n > 100, 'a still frame of the lines is drawn');
  assert.equal(a.sum, b.sum, 'and it does not move');
  await still.page.mouse.move(500, 300); await settle(still.page, 300);
  assert.equal((await ink(still.page)).sum, a.sum, 'nor react to the pointer');
  await still.page.locator('.modal .m-x').click(); await still.page.locator('.modal').waitFor({ state: 'detached' }); await settle(still.page, 300);
  assert.equal(await still.page.locator('.contour-ambient').count(), 1, 'reduced motion still has the corner');
  const stillA = await corner(still.page); assert(stillA.n > 50, 'drawn once as a still frame');
  await still.page.mouse.move(60, 600); await still.page.mouse.down(); await still.page.mouse.up(); await settle(still.page, 900);
  assert.equal((await corner(still.page)).sum, stillA.sum, 'and it neither moves nor reacts to the pointer');
  await still.context.close();

  // ---------- engine unavailable: surfaces stay solid white and usable ----------
  const broken = await open({ block: '/js/contour.js' });
  await broken.page.locator('#settingsbtn').click(); await broken.page.locator('.modal').waitFor(); await settle(broken.page);
  assert.equal(await canvases(broken.page).count(), 0, 'no canvas without the engine');
  assert.equal(await broken.page.locator('.contour-ambient').count(), 0, 'and no corner either');
  assert.equal(await broken.page.locator('.modal').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)', 'the dialog stays solid white');
  await broken.page.locator('.modal .m-x').click(); await broken.page.locator('.modal').waitFor({ state: 'detached' });
  await broken.context.close();

  assert.deepEqual(external, []);
  assert.deepEqual(errors.filter((e) => !/contour/i.test(e)), []);
  console.log('PASS contour backdrop browser checks');
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done));
  if (!process.env.PLAN_TEST_ARTIFACTS) await rm(temp, { recursive: true, force: true });
}
