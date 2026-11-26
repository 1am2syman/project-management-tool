// Isolated production-browser action/fault checks; complements browser-durability.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.PLAYWRIGHT_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw Error('Unknown PLAYWRIGHT_BROWSER: ' + engine);
const browserType = playwright[engine];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-durability-actions-'));
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', temp, '--no-open', '--file-access', 'off'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', browser, url;
const pageErrors = [];
server.stderr.on('data', b => { log += b; });
const routeReleases = new Set();
const deferred = () => { let release; const promise = new Promise(r => { release = r; }); routeReleases.add(release); return { promise, release }; };
async function receipt(signal) {
  let timer;
  try { await Promise.race([signal.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Expected action did not send a commit request')), 15000); })]); }
  finally { clearTimeout(timer); }
}
const isWrite = request => new URL(request.url()).pathname === '/api/projects/changes' && request.method() === 'POST';
const day = Math.floor(Date.now() / 86400000), start = day + 7;
const disk = async () => { const r = await fetch(url + 'api/projects'); assert(r.ok); return r.json(); };
const stateTask = (state, id) => state.workbook.sheets.find(s => s.id === 's1').data.tasks.find(t => t.id === id);
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const ready = page => page.waitForFunction(() => window.PlanDiagnostics?.snapshot().entries.some(e => e.event === 'app.ready'), null, { polling: 100 });
async function status(page, value) {
  try { await page.waitForFunction(value => document.querySelector('#save-status')?.dataset.state === value, value, { polling: 100 }); }
  catch (cause) {
    const detail = await page.evaluate(() => ({ badge: document.querySelector('#save-status')?.outerHTML, toast: document.querySelector('#toast')?.textContent, entries: window.PlanDiagnostics?.snapshot().entries.slice(-8) }));
    throw Error(`Expected storage status ${value}: ${JSON.stringify(detail)}`, { cause });
  }
}
async function ack(page, action, code = 200) {
  const [response] = await Promise.all([page.waitForResponse(r => isWrite(r.request())), action()]);
  assert.equal(response.status(), code, await response.text());
  await status(page, code === 200 ? 'saved' : 'error'); await frames(page);
}
async function fixture(page) {
  await page.evaluate(async ({ day, start }) => {
    const { Store } = await import('/js/model.js'), DL = await import('/js/delays.js');
    const task = (id, name, dur, date = start) => ({ id, name, dur, start: date, level: 0, ms: !dur, progress: 0, scheduling: 'auto', owner: '' });
    const data = { tasks: [task(1, 'First', 4), task(2, 'Second', 4), task(3, 'Launch', 0), task(4, 'Overdue', 3, day - 14)], links: [{ id: 'l1', from: 1, to: 2, type: 'FS', lag: 0 }, { id: 'l2', from: 2, to: 3, type: 'FS', lag: 0 }], nextId: 5, nextLink: 3 };
    const sample = new Store({ workbook: { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Action fixture', data }] }, preferences: { auto: true } }, { disk: true });
    sample.save = () => { sample.sheet().data = JSON.parse(sample.serialize()); };
    assertFixture(DL.agreeBaseline(sample, {}));
    const snapshot = sample.snapshotVersion({ name: 'Agreed original' });
    if (snapshot.error) throw Error(snapshot.error);
    sample.undoStack = []; sample.redoStack = [];
    function assertFixture(error) { if (error) throw Error(error); }
    const next = sample.savedState(), current = await (await fetch('/api/projects')).json();
    const { changesBetween } = await import('/js/changes.js');
    const response = await fetch('/api/projects/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.revision, changes: changesBetween(current.state, next) }) });
    if (!response.ok) throw Error(await response.text());
  }, { day, start });
  await page.reload(); await ready(page); await status(page, 'saved');
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true });
  const control = { writes: [], requests: [], handle: null }, errors = [];
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== new URL(url).origin) return route.abort();
    control.requests.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    if (isWrite(route.request())) { control.writes.push(route.request().postDataJSON()); if (control.handle) return control.handle(route); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => { errors.push(e.message); pageErrors.push(e.message); console.error('PAGEERROR', e.message); });
  page.on('dialog', d => d.accept());
  await page.goto(url); await ready(page); await status(page, 'saved'); await fixture(page);
  return { page, context, control, errors };
}
const row = (page, id) => page.locator(`#gbody .r[data-id="${id}"]`);
const cell = (page, id, col) => row(page, id).locator(`[data-col="${col}"]`);
async function edit(page, id, col, value) {
  await cell(page, id, col).dblclick(); await page.locator('.editor').fill(value); await page.keyboard.press('Enter');
}
async function scenario(name, run) { await run(); console.log('PASS ' + name); }
async function close(context) {
  for (const release of routeReleases) release();
  routeReleases.clear();
  await context.close();
}
try {
  url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(Error(log)), 10000);
    server.once('exit', c => { clearTimeout(timer); no(Error(`server ${c}: ${log}`)); });
    server.stdout.on('data', b => { log += b; const m = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (m) { clearTimeout(timer); yes(m[1]); } });
  });
  browser = await browserType.launch({ executablePath: engine === 'chromium' ? process.env.PLAYWRIGHT_CHROMIUM : undefined, headless: process.env.PLAN_TEST_HEADED !== '1' });

  await scenario('read-only rendered controls block file actions and layout resizing', async () => {
    const { page: writer, context, control } = await newPage();
    try {
      const reader = await context.newPage(); reader.setDefaultTimeout(15000);
      reader.on('pageerror', e => pageErrors.push(e.message));
      await reader.addInitScript(() => {
        window.pickerCalls = [];
        window.showOpenFilePicker = async () => { window.pickerCalls.push('open'); throw new DOMException('Unexpected picker', 'AbortError'); };
        window.showSaveFilePicker = async () => { window.pickerCalls.push('save'); throw new DOMException('Unexpected picker', 'AbortError'); };
      });
      await reader.goto(url); await ready(reader); await status(reader, 'readonly');
      const before = await disk(), writes = control.writes.length;
      const selectors = ['#openprojectbtn', '#savefilebtn', '#saveprojectbtn', '#snapshotbtn', '#addsheet'];
      for (const selector of selectors) {
        assert.equal(await reader.locator(selector).isDisabled(), true, selector + ' is visibly disabled');
        await reader.locator(selector).click({ force: true });
        await reader.locator(selector).dispatchEvent('click');
      }
      for (const keys of ['Control+o', 'Control+s', 'Control+Shift+s']) await reader.keyboard.press(keys);
      const geometry = page => page.evaluate(() => ({ pane: document.querySelector('#gx').getBoundingClientRect().width, columns: [...document.querySelectorAll('#gletters .c')].map(e => e.getBoundingClientRect().width) }));
      const acceptedGeometry = await geometry(reader);
      const column = await reader.locator('#gletters .rs').first().boundingBox(); assert(column);
      await reader.mouse.move(column.x + column.width / 2, column.y + column.height / 2); await reader.mouse.down(); await reader.mouse.move(column.x + 90, column.y + column.height / 2, { steps: 5 }); await reader.mouse.up();
      const split = await reader.locator('#split').boundingBox(); assert(split);
      await reader.mouse.move(split.x + split.width / 2, split.y + 200); await reader.mouse.down(); await reader.mouse.move(split.x + 90, split.y + 200, { steps: 5 }); await reader.mouse.up(); await frames(reader);
      assert.deepEqual(await geometry(reader), acceptedGeometry, 'read-only drag cannot alter accepted pane or column geometry');
      assert.deepEqual(await reader.evaluate(() => window.pickerCalls), []);
      assert.equal(control.writes.length, writes); assert.deepEqual(await disk(), before);
      assert.equal(control.requests.filter(r => r.path.startsWith('/api/files/') && r.method !== 'GET').length, 0, 'read-only file commands never reach native server mutations');
      await status(writer, 'saved');
    } finally { await close(context); }
  });

  await scenario('grid delay Cancel/Skip/Record and lost-ack retry preserve one atomic action', async () => {
    const { page, context, control, errors } = await newPage();
    try {
      const before = await disk(), writes = control.writes.length;
      await edit(page, 1, 'dur', '6'); const pop = page.locator('.dly-pop'); await pop.waitFor();
      assert.equal(control.writes.length, writes); assert.deepEqual(await disk(), before);
      await page.waitForFunction(() => document.querySelector('#gbody .r[data-id="1"] [data-col=dur]')?.textContent === '6', null, { polling: 100 });
      assert.equal(await page.locator('#snapshotbtn').isDisabled(), true); assert.equal(await page.locator('#addsheet').isDisabled(), true);
      await page.keyboard.press('Escape'); await pop.waitFor({ state: 'detached' }); await page.locator('.editor').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('#gbody .r[data-id="1"] [data-col=dur]')?.textContent === '4', null, { polling: 100 });
      assert.equal(await cell(page, 1, 'dur').textContent(), '4'); assert.deepEqual(await disk(), before); assert.equal(control.writes.length, writes);
      assert(!/\[object Object\]/.test(await page.locator('#toast').textContent()));

      await edit(page, 1, 'dur', '6'); await pop.waitFor();
      const hold = deferred(); let received = deferred();
      control.handle = async route => { received.release(); await hold.promise; await route.continue(); };
      await pop.locator('[data-skip]').click(); await receipt(received);
      assert.deepEqual(await disk(), before); assert.equal(await pop.locator('[data-record]').isDisabled(), true);
      await page.keyboard.press('Escape'); assert.equal(await pop.count(), 1);
      hold.release(); await status(page, 'saved'); await pop.waitFor({ state: 'detached' }); control.handle = null;
      const skipped = await disk(); assert.equal(stateTask(skipped.state, 1).dur, 6);
      assert.equal(skipped.state.workbook.sheets[0].data.log.filter(e => e.type === 'delay').length, 1);
      assert.equal(control.writes.length, writes + 1);
      await ack(page, () => page.keyboard.press('Control+z')); assert.equal(stateTask((await disk()).state, 1).dur, 4);
      await ack(page, () => page.keyboard.press('Control+y')); assert.equal(stateTask((await disk()).state, 1).dur, 6);
      await ack(page, () => page.keyboard.press('Control+z'));

      await edit(page, 1, 'dur', '7'); await pop.waitFor(); await pop.locator('[data-f=cause]').selectOption({ index: 1 });
      const selectedCause = await pop.locator('[data-f=cause] option:checked').textContent();
      control.handle = async route => { const response = await route.fetch(); assert(response.ok()); await route.abort('failed'); };
      await pop.locator('[data-record]').click(); await status(page, 'error');
      const lost = await disk(); assert.equal(stateTask(lost.state, 1).dur, 7); assert(await pop.isVisible());
      assert.equal(await cell(page, 1, 'dur').textContent(), '4', 'failed acknowledgement never accepts candidate into grid');
      const writesBeforeRetry = control.writes.length; control.handle = null;
      await page.locator('#save-status').click(); await status(page, 'saved'); await pop.waitFor({ state: 'detached' });
      assert.equal(control.writes.length, writesBeforeRetry); assert.deepEqual(await disk(), lost);
      assert.equal(await cell(page, 1, 'dur').textContent(), '7');
      assert.equal(await page.locator('#toast').textContent(), `Delay recorded · +3d ${selectedCause}`);
      assert.deepEqual(errors, []);
    } finally { await close(context); }
  });

  await scenario('HTTP 400 delay rejection retains input; Cancel permits Save As and a corrected action', async () => {
    const { page, context, control } = await newPage();
    try {
      const before = await disk(), writes = control.writes.length;
      await edit(page, 1, 'dur', '8'); const pop = page.locator('.dly-pop'); await pop.waitFor();
      await pop.locator('[data-f=cause]').selectOption({ index: 1 }); await pop.locator('[data-f=note]').fill('Keep rejected explanation');
      const cause = await pop.locator('[data-f=cause]').inputValue();
      control.handle = route => route.fulfill({ status: 400, json: { error: 'Injected invalid delay candidate' } });
      await pop.locator('[data-record]').click(); await status(page, 'error'); await frames(page);
      assert(await pop.isVisible()); assert.equal(await pop.locator('[data-f=note]').inputValue(), 'Keep rejected explanation'); assert.equal(await pop.locator('[data-f=cause]').inputValue(), cause);
      assert.match(await pop.locator('.set-err').textContent(), /Injected invalid delay candidate/);
      assert.deepEqual(await disk(), before); assert.equal(control.writes.length, writes + 1);
      assert.equal(await cell(page, 1, 'dur').evaluate(el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('')), '4');
      assert.equal((await page.evaluate(() => window.PlanDiagnostics.snapshot().entries.filter(e => e.event === 'delay.record'))).length, 0);
      assert(!/Delay recorded|Revision recorded/.test(await page.locator('#toast').textContent()));
      await pop.locator('[data-cancel]').first().click(); await pop.waitFor({ state: 'detached' });
      if (await page.locator('.editor').count()) await page.keyboard.press('Escape');
      control.handle = null;
      // After discarding the rejected editor, normal Save As must pass its real
      // storage barrier without an intervening successful Store command.
      await page.evaluate(() => { window.showSaveFilePicker = undefined; });
      const downloading = page.waitForEvent('download');
      await page.locator('#saveprojectbtn').click();
      // Complete the download before the context closes; Windows Edge exits otherwise.
      await (await downloading).path();
      assert.deepEqual(await disk(), before); assert.equal(control.writes.length, writes + 1);
      await edit(page, 1, 'dur', '9');
      await pop.waitFor(); await pop.locator('[data-f=cause]').selectOption(cause); await pop.locator('[data-f=note]').fill('Corrected accepted explanation');
      await ack(page, () => pop.locator('[data-record]').click()); await pop.waitFor({ state: 'detached' });
      const accepted = await disk(); assert.equal(stateTask(accepted.state, 1).dur, 9); assert.equal(control.writes.length, writes + 2);
      assert(accepted.state.workbook.sheets[0].data.log.some(e => e.type === 'delay' && e.note === 'Corrected accepted explanation'));
    } finally { await close(context); }
  });

  await scenario('typing back to the committed text keeps the inline editor and focus (no retire mid-edit)', async () => {
    const { page, context, control } = await newPage();
    try {
      const before = await disk(), original = stateTask(before.state, 1).name, writes = control.writes.length;
      await cell(page, 1, 'name').dblclick();
      const editor = page.locator('.editor'); await editor.waitFor();
      await page.keyboard.press('End'); await page.keyboard.type('x'); await page.keyboard.press('Backspace');
      assert.equal(await editor.inputValue(), original);
      assert.equal(await page.locator('.editor').count(), 1, 'editor survives text equal to committed value');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'editor', 'focus stays in the editor');
      await page.keyboard.type(' review');
      assert.equal(await editor.inputValue(), original + ' review');
      await page.keyboard.press('Escape'); await page.locator('.editor').waitFor({ state: 'detached' });
      assert.equal(control.writes.length, writes); assert.deepEqual(await disk(), before);
      // The formula bar behaves the same way.
      await cell(page, 1, 'name').click(); await page.locator('#fxin').click();
      await page.keyboard.press('End'); await page.keyboard.type('y'); await page.keyboard.press('Backspace');
      await page.keyboard.type('z');
      assert.equal(await page.locator('#fxin').inputValue(), original + 'z');
      await page.keyboard.press('Escape'); assert.equal(control.writes.length, writes);
    } finally { await close(context); }
  });

  await scenario('rejected inline edit is sent once, keeps focus, and its status clears on discard', async () => {
    const { page, context, control } = await newPage();
    try {
      const before = await disk(), writes = control.writes.length;
      control.handle = route => route.fulfill({ status: 400, json: { error: 'Injected inline rejection' } });
      await edit(page, 1, 'name', 'Rejected text'); await status(page, 'error'); await frames(page); await frames(page);
      assert.equal(control.writes.length, writes + 1, 'blur from re-rendering the rejected editor must not resubmit');
      assert.equal(await page.locator('.editor').count(), 1); assert.equal(await page.locator('.editor').inputValue(), 'Rejected text');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'editor', 'focus stays in the rejected editor');
      assert.deepEqual(await disk(), before);
      control.handle = null;
      await page.keyboard.press('Escape'); await page.locator('.editor').waitFor({ state: 'detached' });
      await status(page, 'saved');
      assert(!/rejected/i.test(await page.locator('#save-status').textContent()), 'no stale rejection after discarding the input');
      assert.equal(control.writes.length, writes + 1); assert.deepEqual(await disk(), before);
    } finally { await close(context); }
  });

  await scenario('rejected inline edit stays bound to its original project across navigation', async () => {
    const { page, context, control } = await newPage();
    try {
      await ack(page, () => page.locator('#addsheet').click());
      const tabs = page.locator('#tabs .tab'); await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 2);
      await tabs.first().click(); await cell(page, 2, 'name').waitFor();
      const second = state => state.workbook.sheets.find(s => s.id !== 's1').data.tasks.find(t => t.id === 2).name;
      const before = await disk(), original = stateTask(before.state, 2).name, otherOriginal = second(before.state);
      control.handle = route => route.fulfill({ status: 400, json: { error: 'Injected inline rejection' } });
      await edit(page, 2, 'name', 'Correction for first project'); await status(page, 'error'); await frames(page);
      assert.equal(await page.locator('.editor').inputValue(), 'Correction for first project');
      // Clicking away blurs the focused rejected editor, which legitimately retries the
      // still-invalid text once on its own project; it is rejected again and retained.
      if (engine === 'firefox') {
        // Known Firefox gap (see docs/durability-verification.md): the first click on another tab
        // only blurs the rejected editor and does not switch projects. Blur explicitly, let the
        // retry settle, then switch, so the project-binding invariant below is still exercised.
        await page.locator('.editor').evaluate(editor => editor.blur()); await frames(page);
        await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 2 && ![...document.querySelectorAll('#tabs .tab')].some(tab => tab.draggable === false));
        await status(page, 'error');
        await tabs.last().click(); await page.waitForFunction(() => document.querySelector('#tabs .tab.on')?.textContent.includes('Project 2'));
      } else await tabs.last().click();
      await frames(page); await status(page, 'error'); control.handle = null;
      const writes = control.writes.length;
      assert.equal(await page.locator('.editor').count(), 0, 'rejected editor is not shown on another project');
      assert.equal(await cell(page, 2, 'name').locator('.t').textContent(), otherOriginal);
      await page.keyboard.press('Enter'); await frames(page);
      assert.equal(control.writes.length, writes, 'navigation and Enter cannot submit the retained text elsewhere');
      assert.deepEqual(await disk(), before);
      await tabs.first().click(); await page.locator('.editor').waitFor();
      assert.equal(await page.locator('.editor').inputValue(), 'Correction for first project');
      await ack(page, () => page.keyboard.press('Enter'));
      const accepted = await disk();
      assert.equal(stateTask(accepted.state, 2).name, 'Correction for first project');
      assert.notEqual(stateTask(accepted.state, 2).name, original);
      assert.equal(second(accepted.state), otherOriginal, 'the other project is never written');
    } finally { await close(context); }
  });

  await scenario('formula blur retains rejected text through renders and correction keeps its original task', async () => {
    const { page, context, control } = await newPage();
    const hold = deferred(), received = deferred();
    try {
      const before = await disk();
      await cell(page, 1, 'name').click();
      const formula = page.locator('#fxin');
      await formula.fill('Retain rejected formula input');
      control.handle = async route => { received.release(); await hold.promise; await route.fulfill({ status: 400, json: { error: 'Injected formula rejection' } }); };
      await page.locator('#gx').focus(); await receipt(received); await frames(page);
      assert.equal(await formula.inputValue(), 'Retain rejected formula input');
      assert.equal(await formula.evaluate(input => input.readOnly), true);
      hold.release(); await status(page, 'error'); await frames(page);
      assert.equal(await formula.inputValue(), 'Retain rejected formula input');
      assert.deepEqual(await disk(), before);
      await cell(page, 2, 'name').click(); await frames(page);
      assert.equal(await formula.inputValue(), 'Retain rejected formula input');
      control.handle = null;
      await formula.fill('Corrected original formula task');
      await ack(page, () => formula.press('Enter'));
      const accepted = await disk();
      assert.equal(stateTask(accepted.state, 1).name, 'Corrected original formula task');
      assert.equal(stateTask(accepted.state, 2).name, stateTask(before.state, 2).name);
    } finally { hold.release(); await close(context); }
  });

  for (const outcome of ['skip', 'revision']) await scenario(`lost-ack ${outcome} adoption closes decision with accurate toast and diagnostics`, async () => {
    const { page, context, control } = await newPage();
    try {
      await edit(page, 1, 'dur', '8'); const pop = page.locator('.dly-pop'); await pop.waitFor();
      if (outcome === 'revision') {
        await pop.locator('[data-mode=revision] > label').click();
        await pop.locator('[data-f=reason]').fill('Accepted scope revision'); await pop.locator('[data-f=approved]').fill('Reviewer');
      }
      control.handle = async route => { assert((await route.fetch()).ok()); await route.abort('failed'); };
      await pop.locator(outcome === 'skip' ? '[data-skip]' : '[data-record]').click(); await status(page, 'error');
      const acceptedDisk = await disk(), writes = control.writes.length;
      assert(await pop.isVisible()); assert.equal(await pop.locator('[data-skip]').isDisabled(), true);
      assert.equal(await cell(page, 1, 'dur').textContent(), '4');
      assert.equal((await page.evaluate(() => window.PlanDiagnostics.snapshot().entries.filter(e => e.event === 'delay.record'))).length, 0);
      control.handle = null; await page.locator('#save-status').click(); await status(page, 'saved'); await pop.waitFor({ state: 'detached' });
      assert.equal(control.writes.length, writes); assert.deepEqual(await disk(), acceptedDisk);
      // Adoption renders on the next frame; wait for it rather than racing the status badge.
      await page.waitForFunction(() => document.querySelector('#gbody .r[data-id="1"] [data-col=dur]')?.textContent === '8', null, { polling: 100 });
      assert.equal(await cell(page, 1, 'dur').textContent(), '8');
      if (outcome === 'skip') assert.equal(await page.locator('#toast').textContent(), 'Delay recorded without a cause · classify it from the task menu');
      else {
        const day = stateTask(acceptedDisk.state, 1).agr.f;
        const formatted = await page.evaluate(async day => (await import('/js/model.js')).fmtDate(day), day);
        assert.equal(await page.locator('#toast').textContent(), `Revision recorded · agreed ${formatted}`);
      }
      const entries = await page.evaluate(() => window.PlanDiagnostics.snapshot().entries.filter(e => e.event === 'delay.record'));
      assert.equal(entries.length, 1); assert.equal(entries[0].detail.type, outcome === 'skip' ? 'delay' : 'revision');
    } finally { await close(context); }
  });

  await scenario('overdue invalid revision reason writes nothing; valid date and reason commit once', async () => {
    const { page, context, control } = await newPage();
    try {
      const before = await disk(), writes = control.writes.length;
      const chip = page.locator('.dly-od-g[data-dly-overdue="4"]'); await chip.scrollIntoViewIfNeeded(); await chip.click({ force: true });
      const pop = page.locator('.dly-pop'); await pop.waitFor(); await pop.locator('[data-mode=revision] > label').click(); await pop.locator('[data-record]').click();
      assert.match(await pop.locator('.set-err').textContent(), /why|reason/); assert.deepEqual(await disk(), before); assert.equal(control.writes.length, writes);
      await pop.locator('[data-f=reason]').fill('Approved finish change'); await pop.locator('[data-record]').click();
      assert.match(await pop.locator('.set-err').textContent(), /approved/); assert.deepEqual(await disk(), before); assert.equal(control.writes.length, writes);
      await pop.locator('[data-f=approved]').fill('Reviewer'); await ack(page, () => pop.locator('[data-record]').click());
      const after = await disk(); assert.equal(control.writes.length, writes + 1); assert.notEqual(stateTask(after.state, 4).dur, stateTask(before.state, 4).dur);
      assert(after.state.workbook.sheets[0].data.log.some(e => e.type === 'revision' && e.taskId === 4 && e.reason === 'Approved finish change'));
      await ack(page, () => page.keyboard.press('Control+z')); assert.equal(stateTask((await disk()).state, 4).dur, 3);
    } finally { await close(context); }
  });

  await scenario('Gantt resize preview/cancel makes no write and release waits for delay decision', async () => {
    const { page, context, control } = await newPage();
    try {
      await page.locator('[data-fit]').click(); await frames(page);
      const before = await disk(), writes = control.writes.length;
      let handle = await page.locator('.bar[data-id="2"] .resize-end').boundingBox(); assert(handle);
      const originalHandleX = handle.x;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + 70, handle.y + handle.height / 2, { steps: 6 });
      assert.deepEqual(await disk(), before); assert.equal(control.writes.length, writes); await page.keyboard.press('Escape'); await page.mouse.up();
      assert.deepEqual(await disk(), before);
      // Cancel schedules a render. Wait for the original geometry before grabbing
      // again; otherwise Firefox can hit the canvas where the preview used to be.
      await page.waitForFunction(x => Math.abs(document.querySelector('.bar[data-id="2"] .resize-end').getBoundingClientRect().x - x) < 1, originalHandleX);
      handle = await page.locator('.bar[data-id="2"] .resize-end').boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + 70, handle.y + handle.height / 2, { steps: 6 }); await page.mouse.up();
      const pop = page.locator('.dly-pop'); await pop.waitFor(); assert.deepEqual(await disk(), before); await ack(page, () => pop.locator('[data-skip]').click()); assert.equal(control.writes.length, writes + 1);
    } finally { await close(context); }
  });

  await scenario('version preview never writes; restore save-current/critical target/undo are atomic', async () => {
    const { page, context, control } = await newPage();
    try {
      // A name change avoids an interactive scheduling decision.
      await ack(page, () => edit(page, 1, 'name', 'Current first'));
      await ack(page, async () => { await cell(page, 3, 'name').click({ button: 'right' }); await page.locator('[data-task-action=critical-milestone]').click(); });
      const before = await disk(), writes = control.writes.length;
      await page.locator('#versionbtn').click(); await page.locator('[data-v="v1"]').click(); await frames(page);
      assert.equal(await cell(page, 1, 'name').locator('.t').textContent(), 'First'); assert.deepEqual(await disk(), before); assert.equal(control.writes.length, writes);
      await page.locator('#verbanner [data-vb=restore]').click(); const restore = page.getByRole('dialog', { name: /Restore v1/ }); await restore.locator('#vkeep').check();
      const hold = deferred(), received = deferred(); control.handle = async route => { received.release(); await hold.promise; await route.continue(); };
      await restore.locator('[data-restore]').click(); await receipt(received); assert.deepEqual(await disk(), before); assert(await restore.isVisible());
      const attempted = control.writes.at(-1); assert(attempted.changes.length > 0);
      hold.release(); await status(page, 'saved'); await restore.waitFor({ state: 'detached' }); control.handle = null;
      const after = await disk(), sheet = after.state.workbook.sheets[0];
      assert.equal(control.writes.length, writes + 1); assert.equal(stateTask(after.state, 1).name, 'First'); assert.equal(sheet.versions.length, 2);
      assert.equal(JSON.parse(sheet.versions[1].data).tasks.find(t => t.id === 1).name, 'Current first'); assert.equal(after.state.preferences.criticalTargets.s1, undefined);
      await ack(page, () => page.keyboard.press('Control+z')); assert.equal(stateTask((await disk()).state, 1).name, 'Current first');
      await ack(page, () => page.keyboard.press('Control+y')); assert.equal(stateTask((await disk()).state, 1).name, 'First');
    } finally { await close(context); }
  });

  await scenario('template acceptance, inline insertion focus and rejected cause add keep honest controls', async () => {
    const { page, context, control } = await newPage();
    try {
      await cell(page, 1, 'name').click({ button: 'right' }); await page.locator('[data-task-action=task-before]').click(); await page.locator('.editor').waitFor();
      assert.equal(await page.locator('.editor').evaluate(e => e === document.activeElement), true, 'task menu must not steal new inline editor focus');
      await page.keyboard.press('Escape');
      const before = await disk(), writes = control.writes.length;
      await page.locator('#tplbtn').click(); const firstTemplate = page.locator('.tcard').first();
      const hold = deferred(), received = deferred(); control.handle = async route => { received.release(); await hold.promise; await route.continue(); };
      await firstTemplate.click(); await receipt(received); assert.deepEqual(await disk(), before); assert(await page.locator('#tplpop').isVisible());
      // The request is observed on the network before the pending state is necessarily painted.
      await page.waitForFunction(() => document.querySelector('#snapshotbtn')?.disabled && document.querySelector('#addsheet')?.disabled);
      hold.release(); await status(page, 'saved'); control.handle = null; const after = await disk(); assert.equal(after.state.workbook.sheets.length, before.state.workbook.sheets.length + 1); assert.equal(control.writes.length, writes + 1);
      await page.locator('#settingsbtn').click(); const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.locator('#dly-new').fill('Unaccepted cause');
      control.handle = route => route.fulfill({ status: 503, json: { error: 'Injected cause rejection' } });
      await settings.locator('#dly-add').click(); await status(page, 'error');
      assert.equal(await settings.locator('#dly-new').inputValue(), 'Unaccepted cause'); assert.equal(await settings.locator('.dly-cname', { hasText: 'Unaccepted cause' }).count(), 0); assert.deepEqual(await disk(), after);
      await settings.locator('#dly-new').evaluate(e => { e.focus(); e.select(); }); assert.equal(await settings.locator('#dly-new').evaluate(e => e.selectionEnd - e.selectionStart), 'Unaccepted cause'.length);
    } finally { await close(context); }
  });

  await scenario('reset replaces workbook with clean undo history', async () => {
    const { page, context } = await newPage();
    try {
      await ack(page, () => edit(page, 1, 'name', 'History must disappear'));
      assert((await disk()).state.history.s1.u.length > 0);
      await ack(page, () => page.locator('[data-act=reset]').click());
      const after = await disk(); assert.equal(after.state.history.s1?.u.length || 0, 0); assert.equal(after.state.history.s1?.r.length || 0, 0);
      assert(!JSON.stringify(after.state.history).includes('History must disappear'));
      assert(await page.locator('[data-act=undo]').isDisabled());
    } finally { await close(context); }
  });

  await scenario('spreadsheet multi-sheet import sends one acknowledged candidate', async () => {
    const { page, context, control } = await newPage();
    try {
      const xlsx = await page.evaluate(async () => {
        const { Store } = await import('/js/model.js'), { buildXlsx } = await import('/js/xlsx.js');
        const current = await (await fetch('/api/projects')).json(), sample = new Store(current.state, { disk: true });
        const blob = await buildXlsx([{ name: 'Imported A', store: sample }, { name: 'Imported B', store: sample }]);
        return [...new Uint8Array(await blob.arrayBuffer())];
      });
      const before = await disk(), writes = control.writes.length;
      await page.locator('#impbtn').click(); const dialog = page.getByRole('dialog', { name: 'Import from Excel' });
      const choosing = page.waitForEvent('filechooser');
      await dialog.locator('[data-im=pick]').click();
      await (await choosing).setFiles({ name: 'multi.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(xlsx) });
      await dialog.locator('[data-im=go]').waitFor();
      const hold = deferred(), received = deferred(); control.handle = async route => { received.release(); await hold.promise; await route.continue(); };
      await dialog.locator('[data-im=go]').click(); await receipt(received); assert.deepEqual(await disk(), before); assert(await dialog.isVisible());
      hold.release(); await status(page, 'saved'); await dialog.waitFor({ state: 'detached' });
      assert.equal(control.writes.length, writes + 1); assert.equal((await disk()).state.workbook.sheets.length, before.state.workbook.sheets.length + 2);
    } finally { await close(context); }
  });
  assert.deepEqual(pageErrors, [], 'all action scenarios remain free of JavaScript errors');
  console.log('DURABILITY_ACTIONS_PASS');
} catch (error) {
  console.error(log);
  throw error;
} finally {
  for (const release of routeReleases) release();
  await browser?.close(); server.kill();
  await new Promise(done => server.exitCode !== null || server.signalCode !== null ? done() : server.once('exit', done));
  await rm(temp, { recursive: true, force: true });
}
