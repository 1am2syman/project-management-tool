// Real-browser commit ordering and outage checks. Every run owns a temporary
// SQLite database and browser contexts; no installed projects/profiles are used.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.PLAYWRIGHT_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw Error('Unknown PLAYWRIGHT_BROWSER: ' + engine);
const browserType = playwright[engine];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-durability-browser-'));
const dataDir = join(temp, 'data');
const artifacts = process.env.PLAN_TEST_ARTIFACTS && resolve(process.env.PLAN_TEST_ARTIFACTS, 'durability');
const python = process.env.PYTHON || 'python3';
let browser, server, serverLog = '', origin, url;
const evidence = [], failures = [], routeReleases = new Set();
const deferred = () => { let resolvePromise; const promise = new Promise(resolve => { resolvePromise = resolve; }); return { promise, resolve: resolvePromise }; };
const isWrite = request => new URL(request.url()).pathname.startsWith('/api/projects') && request.method() === 'POST';
const readDisk = async () => {
  const response = await fetch(`${url}api/projects`);
  assert(response.ok, `read workspace: ${response.status}`);
  return response.json();
};
const diskTask = state => state.workbook.sheets[0].data.tasks.find(task => task.id === 3);
const cell = page => page.locator('#gbody .r[data-id="3"] [data-col="name"]');
const displayedName = page => cell(page).locator('.t').textContent();
const status = async (page, state) => {
  try { await page.waitForFunction(value => document.querySelector('#save-status')?.dataset.state === value, state); }
  catch (error) {
    const detail = await page.evaluate(() => ({ badge: document.querySelector('#save-status')?.outerHTML, toast: document.querySelector('#toast')?.textContent, entries: window.PlanDiagnostics?.snapshot().entries.filter(entry => /storage\.|model\.|javascript\./.test(entry.event)).slice(-12) }));
    throw new Error(`Expected storage status ${state}: ${JSON.stringify(detail)}`, { cause: error });
  }
};
const ready = async page => {
  await page.waitForFunction(() => window.PlanDiagnostics?.snapshot().entries.some(entry => entry.event === 'app.ready'));
  await cell(page).waitFor();
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function edit(page, text) {
  await cell(page).dblclick();
  await page.locator('.editor').fill(text);
  await page.keyboard.press('Enter');
}
async function copy(page) {
  const downloading = page.waitForEvent('download');
  await page.locator('#downloadcopybtn').click();
  const download = await downloading;
  const contents = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(contents.format, 'plan-project');
  assert.match(await page.locator('#toast').textContent(), /Download started.*Check Downloads/);
  return { contents, name: download.suggestedFilename() };
}
async function logDownload(page) {
  await page.locator('#logbtn').click();
  const dialog = page.getByRole('dialog', { name: 'Diagnostic log' });
  await dialog.waitFor();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download log' }).click();
  const raw = await readFile(await (await downloading).path(), 'utf8');
  await page.keyboard.press('Escape');
  return JSON.parse(raw);
}
async function newContext(control = {}) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true });
  control.requests = []; control.writes = [];
  await context.route('**/*', async route => {
    const request = route.request(), target = new URL(request.url());
    if (target.origin !== origin) return route.abort();
    control.requests.push({ path: target.pathname, method: request.method() });
    if (isWrite(request)) control.writes.push(request.postData());
    if (control.handle && await control.handle(route, target)) return;
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, control, errors };
}
function sqlite(sql) {
  // A failure at history insertion occurs after node changes but inside their
  // transaction, so this proves state/history rollback together on real SQLite.
  execFileSync(python, ['-B', '-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()', join(dataDir, 'plan.db'), sql]);
}
async function scenario(name, run) {
  try {
    await run(); evidence.push({ scenario: name, result: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(error); evidence.push({ scenario: name, result: 'failed', error: error.stack });
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolveExit => server.once('exit', resolveExit));
  server.kill('SIGTERM'); await exited;
}
try {
  server = spawn(python, ['-B', 'start.py', '--port', '0', '--data-dir', dataDir, '--no-open', '--file-access', 'off'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${serverLog}`)), 10000);
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server ${code}: ${serverLog}`)); });
    server.stdout.on('data', chunk => {
      serverLog += chunk;
      const match = serverLog.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) { clearTimeout(timer); resolveUrl(match[1]); }
    });
  });
  origin = new URL(url).origin;
  browser = await browserType.launch({ headless: process.env.PLAN_TEST_HEADED !== '1', executablePath: engine === 'chromium' ? process.env.PLAYWRIGHT_CHROMIUM : undefined });

  await scenario('startup failures never mount an editable browser fallback', async () => {
    for (const failure of ['health unavailable', 'project load unavailable', 'wrong database identity']) {
      const state = { handle: async (route, target) => {
        if (failure === 'health unavailable' && target.pathname === '/api/health') {
          await route.fulfill({ status: 503, json: { error: 'Injected unavailable storage' } }); return true;
        }
        if (failure !== 'health unavailable' && target.pathname === '/api/projects' && route.request().method() === 'GET') {
          if (failure === 'project load unavailable') await route.fulfill({ status: 404, json: { error: 'Injected missing project API' } });
          else await route.fulfill({ json: { revision: null, state: null, dataFile: 'different-database' } });
          return true;
        }
        return false;
      } };
      const { context, page } = await newContext(state);
      try {
        await page.addInitScript(() => localStorage.setItem('pm-proto-v2', 'LEGACY_BYTES_MUST_SURVIVE'));
        await page.goto(url);
        await page.locator('#startup-error').waitFor();
        assert.equal(await page.locator('#gbody .r').count(), 0, failure);
        assert.equal(state.writes.length, 0, `${failure}: no bootstrap`);
        await page.keyboard.press('Control+Enter');
        await page.locator('[data-act="add"]').click({ force: true });
        await frames(page);
        assert.equal(state.writes.length, 0, `${failure}: no editing fallback`);
        assert.equal(await page.evaluate(() => localStorage.getItem('pm-proto-v2')), 'LEGACY_BYTES_MUST_SURVIVE');
        const report = await logDownload(page);
        assert(report.entries.some(entry => entry.event === 'storage.startup.failure'));
      } finally { await context.close(); }
    }
    assert.equal((await readDisk()).state, null, 'failed startup leaves the empty database empty');
  });

  await scenario('held edit is invisible in committed grid and database until acknowledgement', async () => {
    const state = {}, { context, page, errors } = await newContext(state);
    const release = deferred(); routeReleases.add(release);
    try {
      await page.goto(url); await ready(page); await status(page, 'saved');
      const before = await readDisk(), original = diskTask(before.state).name;
      state.handle = async route => {
        if (!isWrite(route.request())) return false;
        await release.promise; await route.continue(); return true;
      };
      const writes = state.writes.length;
      const received = page.waitForRequest(isWrite);
      await edit(page, 'Held before acknowledgement'); await received;
      await status(page, 'saving');
      assert.equal(await displayedName(page), original);
      assert.deepEqual(await readDisk(), before);
      assert.equal(state.writes.length, writes + 1);
      assert.equal(await page.locator('.editor').getAttribute('aria-busy'), 'true');
      assert.equal(await page.locator('.editor').evaluate(input => input.readOnly), true);
      release.resolve(); await status(page, 'saved'); await frames(page);
      assert.equal(await displayedName(page), 'Held before acknowledgement');
      assert.equal(diskTask((await readDisk()).state).name, 'Held before acknowledgement');
      assert.deepEqual(errors, []);
    } finally { release.resolve(); routeReleases.delete(release); await context.close(); }
  });

  await scenario('SQLite failure rolls back state/history while staged copy and diagnostics remain available', async () => {
    const state = {}, { context, page } = await newContext(state);
    try {
      await page.goto(url); await ready(page);
      const before = await readDisk();
      const historyBefore = await (await fetch(`${url}api/history`)).json();
      sqlite("CREATE TRIGGER durability_browser_failure BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT, 'durability browser injected SQLite failure'); END;");
      await edit(page, 'SQLite failed staged project'); await status(page, 'error');
      assert.deepEqual(await readDisk(), before);
      assert.deepEqual(await (await fetch(`${url}api/history`)).json(), historyBefore);
      assert.equal(await displayedName(page), diskTask(before.state).name);
      const writes = state.writes.length;
      const copied = await copy(page);
      assert.match(copied.name, /unsaved copy/);
      assert.equal(copied.contents.project.data.tasks.find(task => task.id === 3).name, 'SQLite failed staged project');
      const report = await logDownload(page);
      assert(report.entries.some(entry => entry.event === 'storage.commit.error'));
      assert.equal(state.writes.length, writes, 'copy and diagnostics do not retry SQLite');
      assert.equal(await page.locator('[data-act="add"]').isDisabled(), true);
    } finally { sqlite('DROP TRIGGER IF EXISTS durability_browser_failure;'); await context.close(); }
  });

  await scenario('lost acknowledgement adopts exact disk result on retry without a second write', async () => {
    const state = {}, { context, page } = await newContext(state);
    try {
      await page.goto(url); await ready(page);
      const before = await readDisk();
      let lost = false;
      state.handle = async route => {
        if (!isWrite(route.request()) || lost) return false;
        lost = true;
        const response = await route.fetch(); assert(response.ok());
        await route.abort('failed'); return true;
      };
      await edit(page, 'Committed but lost acknowledgement'); await status(page, 'error');
      const onDisk = await readDisk(), writes = state.writes.length;
      assert.equal(diskTask(onDisk.state).name, 'Committed but lost acknowledgement');
      assert.equal(await displayedName(page), diskTask(before.state).name);
      const copied = await copy(page); assert.match(copied.name, /unsaved copy/);
      await page.locator('#save-status').click(); await status(page, 'saved'); await frames(page);
      assert.equal(state.writes.length, writes, 'read-before-retry recognizes the exact candidate');
      assert.equal(await displayedName(page), 'Committed but lost acknowledgement');
      assert.deepEqual(await readDisk(), onDisk);
      await page.reload(); await ready(page);
      assert.equal(await displayedName(page), 'Committed but lost acknowledgement');
    } finally { await context.close(); }
  });

  await scenario('delayed original wins retry race; 409 reconciles without a third write', async () => {
    const state = {}, { context, page, errors } = await newContext(state);
    const release = deferred(), retryReceived = deferred(); routeReleases.add(release);
    try {
      await page.goto(url); await ready(page); await status(page, 'saved');
      const before = await readDisk(), writes = state.writes.length;
      let originalBody;
      // Model a proxy losing the browser response while its original request is
      // still waiting to reach Python. Keep the exact original wire body.
      state.handle = async route => {
        if (!isWrite(route.request())) return false;
        originalBody = route.request().postData();
        await route.abort('failed'); return true;
      };
      await edit(page, 'Delayed original accepted exactly once'); await status(page, 'error');
      assert.deepEqual(await readDisk(), before);
      state.handle = async route => {
        if (!isWrite(route.request())) return false;
        assert.equal(route.request().postData(), originalBody, 'retry retains exact immutable patch');
        retryReceived.resolve(); await release.promise; await route.continue(); return true;
      };
      const received = page.waitForRequest(isWrite);
      await page.locator('#save-status').click(); await received; await retryReceived.promise;
      // Retry has checked the original base and is now in flight. The delayed
      // original reaches the actual SQLite endpoint first at the same revision.
      const original = await fetch(`${url}api/projects/changes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: originalBody,
      });
      assert.equal(original.status, 200, await original.text());
      const accepted = await readDisk();
      assert.equal(BigInt(accepted.revision), BigInt(before.revision) + 1n);
      assert.equal(diskTask(accepted.state).name, 'Delayed original accepted exactly once');
      assert.equal(await displayedName(page), diskTask(before.state).name);
      const conflict = page.waitForResponse(response => isWrite(response.request()) && response.status() === 409);
      release.resolve(); await conflict; await status(page, 'error');
      assert.equal(state.writes.length, writes + 2); assert.deepEqual(await readDisk(), accepted);
      const count = state.writes.length;
      state.handle = null;
      await page.locator('#save-status').click(); await status(page, 'saved'); await frames(page);
      assert.equal(state.writes.length, count, 'reconciliation adopts the exact result without another POST');
      assert.deepEqual(await readDisk(), accepted);
      assert.equal(await displayedName(page), 'Delayed original accepted exactly once');
      assert.deepEqual(errors, []);
    } finally { release.resolve(); routeReleases.delete(release); await context.close(); }
  });

  await scenario('second tab is read-only and cannot initiate workspace writes', async () => {
    const state = {}, { context, page } = await newContext(state);
    try {
      await page.goto(url); await ready(page); await status(page, 'saved');
      const before = await readDisk(), writes = state.writes.length;
      const reader = await context.newPage(); reader.on('dialog', dialog => dialog.accept());
      await reader.goto(url); await ready(reader); await status(reader, 'readonly');
      assert.match(await reader.locator('#robanner').textContent(), /Read-only tab/);
      await cell(reader).dblclick();
      assert.equal(await reader.locator('.editor').count(), 0);
      await reader.keyboard.press('Control+Enter'); await frames(reader);
      assert.equal(await reader.locator('[data-act="add"]').isDisabled(), true);
      await copy(reader);
      assert.equal(state.writes.length, writes); assert.deepEqual(await readDisk(), before);
      await reader.close();
    } finally { await context.close(); }
  });

  await scenario('stale separate-profile write is rejected by the actual server revision', async () => {
    const first = await newContext(), second = await newContext();
    try {
      await first.page.goto(url); await ready(first.page);
      await second.page.goto(url); await ready(second.page);
      await status(first.page, 'saved'); await status(second.page, 'saved');
      const before = await readDisk();
      await edit(first.page, 'First profile accepted revision'); await status(first.page, 'saved');
      const accepted = await readDisk(); assert.notEqual(accepted.revision, before.revision);
      const rejected = second.page.waitForResponse(response => response.url().endsWith('/api/projects/changes') && response.status() === 409);
      await edit(second.page, 'Conflicting profile staged candidate'); await rejected; await status(second.page, 'error');
      assert.deepEqual(await readDisk(), accepted);
      assert.equal(await displayedName(second.page), diskTask(before.state).name);
      const copied = await copy(second.page);
      assert.equal(copied.contents.project.data.tasks.find(task => task.id === 3).name, 'Conflicting profile staged candidate');
      const writes = second.control.writes.length;
      await second.page.locator('#save-status').click();
      await second.page.waitForFunction(() => document.querySelector('#save-status').textContent.includes('Changed elsewhere'));
      assert.equal(second.control.writes.length, writes, 'conflicting disk result cannot be overwritten by Retry');
      assert.deepEqual(await readDisk(), accepted);
    } finally { await first.context.close(); await second.context.close(); }
  });

  await scenario('verified retry adopts accepted layout preferences as well as project data', async () => {
    const state = {}, { context, page, errors } = await newContext(state);
    async function lostThenAdopt(action, accepted, beforeRetry = async () => {}) {
      state.handle = async route => {
        if (!isWrite(route.request())) return false;
        assert((await route.fetch()).ok()); await route.abort('failed'); return true;
      };
      try { await Promise.all([page.waitForRequest(isWrite), action()]); }
      catch (error) {
        const detail = await page.evaluate(() => ({ focus: document.querySelector('#optFocus')?.checked, badge: document.querySelector('#save-status')?.outerHTML, toast: document.querySelector('#toast')?.textContent, entries: window.PlanDiagnostics.snapshot().entries.filter(e => /storage\.|javascript\./.test(e.event)).slice(-8) }));
        throw new Error(`Preference action did not commit: ${JSON.stringify(detail)}`, { cause: error });
      }
      await status(page, 'error');
      const onDisk = await readDisk(), writes = state.writes.length;
      state.handle = null; await beforeRetry();
      await page.locator('#save-status').click(); await status(page, 'saved'); await frames(page);
      await accepted(onDisk.state);
      assert.equal(state.writes.length, writes); assert.deepEqual(await readDisk(), onDisk);
    }
    try {
      await page.goto(url); await ready(page); await status(page, 'saved');
      const focusBefore = await page.locator('#optFocus').isChecked();
      await lostThenAdopt(() => page.locator('label.switch').filter({ has: page.locator('#optFocus') }).click(), async saved => {
        assert.equal(await page.locator('#optFocus').isChecked(), !focusBefore);
        assert.equal(saved.browser['pm-focus'], focusBefore ? '0' : '1');
      });
      const density = await page.locator('#density').inputValue() === 'compact' ? 'auto' : 'compact';
      await lostThenAdopt(() => page.locator('#density').selectOption(density), async saved => {
        assert.equal(await page.locator('#density').inputValue(), density);
        assert.equal(await page.locator('html').getAttribute('data-density'), density);
        assert.equal(saved.browser['pm-density'], density);
      });
      await page.locator('#colbtn').click();
      const owner = page.locator('#colpop input[data-c="owner"]'), shown = await owner.isChecked();
      await lostThenAdopt(() => page.locator('#colpop label').filter({ has: page.locator('input[data-c="owner"]') }).click(), async saved => {
        await page.locator('#colbtn').click();
        assert.equal(await page.locator('#colpop input[data-c="owner"]').isChecked(), !shown, `accepted hidden columns ${saved.browser['pm-hidden-cols']}`);
        assert.equal(JSON.parse(saved.browser['pm-hidden-cols']).includes('owner'), shown);
      });
      await page.locator('#colbtn').click();
      const resize = page.locator('#gletters .rs').first(), box = await resize.boundingBox(); assert(box);
      await lostThenAdopt(async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2, { steps: 3 }); await page.mouse.up();
      }, async saved => {
        const nameWidth = JSON.parse(saved.browser['pm-column-widths']).name;
        const actual = await page.locator('#gletters .c').filter({ has: page.locator('.rs') }).first().boundingBox();
        assert(actual); assert(Math.abs(actual.width - nameWidth) < 2, `accepted column width ${actual.width} vs ${nameWidth}`);
      });
      const splitter = await page.locator('#split').boundingBox(); assert(splitter);
      await lostThenAdopt(async () => {
        await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2); await page.mouse.down();
        await page.mouse.move(splitter.x + splitter.width / 2 - 30, splitter.y + splitter.height / 2, { steps: 3 }); await page.mouse.up();
      }, async saved => {
        const actual = await page.locator('#left').boundingBox(); assert(actual);
        assert(Math.abs(actual.width - Number(saved.browser['pm-gridw'])) < 2);
      });
      await cell(page).click(); await page.locator('#slackbtn').click();
      const slack = page.locator('#slack-mode'), mode = await slack.inputValue() === 'all' ? 'off' : 'all';
      await lostThenAdopt(() => slack.selectOption(mode), async saved => {
        await page.locator('#slackbtn').click();
        assert.equal(await slack.inputValue(), mode);
        assert.equal(saved.browser['pm-slack-mode'], mode);
        assert.match(await page.locator('#slackbtn').getAttribute('title'), mode === 'all' ? /all tasks/ : /off/);
      }, () => page.keyboard.press('Escape'));
      await page.keyboard.press('Escape');
      await page.locator('#expbtn').click();
      const pdfBefore = await page.locator('#pdf-slack').isChecked();
      await lostThenAdopt(() => page.locator('#pdf-slack').click(), async saved => {
        assert.equal(await page.locator('#pdf-slack').isChecked(), !pdfBefore, 'open menu adopts the verified preference');
        assert.equal(saved.browser['pm-pdf-slack'], pdfBefore ? '0' : '1');
        await page.keyboard.press('Escape'); await page.locator('#expbtn').click();
        assert.equal(await page.locator('#pdf-slack').isChecked(), !pdfBefore, 'reopened menu keeps the adopted preference');
        const downloading = page.waitForEvent('download');
        await page.locator('#expmenu button[data-k="pdf"][data-all="0"]').click();
        // Wait for the saved file: closing a context mid-download exits Windows Edge.
        await (await downloading).path();
        const exported = await page.evaluate(() => window.PlanDiagnostics.snapshot().entries.filter(e => e.event === 'export.run.start').at(-1));
        assert.equal(exported.detail.pdfSlack, !pdfBefore, 'subsequent PDF uses the adopted preference');
      });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await scenario('selection scrolling folding and active-project navigation never write the workspace', async () => {
    const state = {}, { context, page } = await newContext(state);
    try {
      await page.goto(url); await ready(page);
      await page.locator('#addsheet').click(); await status(page, 'saved');
      await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 2);
      const before = await readDisk(), writes = state.writes.length;
      const tabs = page.locator('#tabs .tab');
      await tabs.first().click(); await cell(page).waitFor();
      await cell(page).click(); await page.keyboard.press('ArrowDown');
      await page.locator('#gbody .r.sum .tog').first().click();
      await page.locator('#gx').evaluate(element => { element.scrollTop = 150; element.scrollLeft = 200; element.dispatchEvent(new Event('scroll')); });
      await tabs.last().click(); await tabs.first().click();
      // Flush scheduled cosmetic selection work without a wall-clock sleep.
      await page.evaluate(() => dispatchEvent(new Event('pm-flush-view'))); await frames(page);
      assert.equal(state.writes.length, writes); assert.deepEqual(await readDisk(), before);
    } finally { await context.close(); }
  });

  await scenario('server stopped: Download copy and Log use loaded browser data without native calls', async () => {
    const state = {}, { context, page } = await newContext(state);
    try {
      await page.goto(url); await ready(page);
      await page.evaluate(() => {
        sessionStorage.setItem('plan-file-pending', JSON.stringify({ id: 'unknown-native', phase: 'writing' }));
        window.showSaveFilePicker = () => { throw new Error('outage copy must not invoke native picker'); };
      });
      const before = await readDisk();
      await stopServer();
      await edit(page, 'Server stopped staged edit'); await status(page, 'error');
      const journal = await page.evaluate(() => sessionStorage.getItem('plan-file-pending'));
      const requestCount = state.requests.length, writes = state.writes.length;
      const copied = await copy(page);
      assert.equal(copied.contents.project.data.tasks.find(task => task.id === 3).name, 'Server stopped staged edit');
      assert.match(copied.name, /unsaved copy/);
      assert.equal(await displayedName(page), diskTask(before.state).name);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('plan-file-pending')), journal);
      assert.equal(state.requests.length, requestCount, 'copy initiates zero network requests');
      assert.equal(state.writes.length, writes);
      const report = await logDownload(page); assert.equal(report.format, 'plan-diagnostics');
    } finally { await context.close(); }
  });

  if (artifacts) { await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, 'results.json'), JSON.stringify(evidence, null, 2)); }
  if (failures.length) throw new AggregateError(failures, `${failures.length} durability browser scenario(s) failed`);
  console.log(`DURABILITY_BROWSER_PASS (${evidence.length} scenarios)`);
} catch (error) {
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ evidence, error: error.stack, serverLog }, null, 2));
    for (const [index, context] of (browser?.contexts() || []).entries()) {
      for (const [pageIndex, page] of context.pages().entries()) await page.screenshot({ path: join(artifacts, `failure-${index}-${pageIndex}.png`) }).catch(() => {});
    }
  }
  throw error;
} finally {
  for (const release of routeReleases) release.resolve();
  await browser?.close(); await stopServer();
  await rm(temp, { recursive: true, force: true });
}
