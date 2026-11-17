// Browser integration with a test-only injected chooser and isolated local data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-local-file-browser-'));
let server, browser, log = '';
function launchServer(port = 0) {
  server = spawn(process.env.PYTHON || 'python3', ['-B', 'tests/file_api_browser_server.py', temp, String(port)], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', chunk => { log += chunk; });
  return new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(log || 'Server startup timed out')), 10000);
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server ${code}: ${log}`)); });
    server.stdout.once('data', chunk => { clearTimeout(timer); resolveUrl(String(chunk).trim()); });
  });
}
async function stopServer() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolveExit => server.once('exit', resolveExit));
    server.kill('SIGTERM');
    await exited;
  }
}
try {
  const url = await launchServer();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const context = await browser.newContext();
  const lost = { startBefore: true, startAfter: true, attach: true, write: true, startup: true };
  await context.route('**/*', async route => {
    const request = route.request(), target = new URL(request.url());
    if (target.origin !== new URL(url).origin) return route.abort();
    if (target.pathname === '/api/file-access' && lost.startup) {
      lost.startup = false;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, available: false, status: 'failed' }) });
    }
    const key = request.method() === 'POST' && target.pathname === '/api/file-operations' ? 'start'
      : request.method() === 'POST' && target.pathname.endsWith('/attach') ? 'attach'
        : request.method() === 'POST' && target.pathname.endsWith('/commit') ? 'write' : null;
    if (key === 'start' && lost.startBefore) {
      lost.startBefore = false;
      return route.abort('failed'); // This request never reached the server.
    }
    const flag = key === 'start' ? 'startAfter' : key;
    if (flag && lost[flag]) {
      lost[flag] = false;
      await route.fetch(); // The server completes the mutation; discard the acknowledgement.
      return route.abort('failed');
    }
    return route.continue();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.showOpenFilePicker = () => { throw new Error('Browser picker must not run'); };
    window.showSaveFilePicker = () => { throw new Error('Browser picker must not run'); };
    indexedDB.open = () => { throw new Error('IndexedDB must not run'); };
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const fixture = await page.evaluate(async () => {
    const { Store } = await import('./js/model.js');
    const { encodeProjectFile } = await import('./js/projectfiles.js');
    return encodeProjectFile(new Store());
  });
  await writeFile(join(temp, 'opened.plan'), fixture);
  await page.locator('#openprojectbtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Could not open'));
  await page.locator('#openprojectbtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Could not open'));
  await page.locator('#openprojectbtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Confirmed the previous project connection'));
  const before = await page.evaluate(async () => (await (await fetch('/api/projects')).json()).state.workbook.sheets.length);
  assert.equal(before, 2);
  await page.locator('#saveprojectbtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved project file'));
  const saved = JSON.parse(await readFile(join(temp, 'saved.plan'), 'utf8'));
  assert.equal(saved.format, 'plan-project');
  const originalSheet = await page.locator('#tabs .tab.on').getAttribute('data-id');
  const snapshotWhileSwitching = page.waitForResponse(response => response.url().endsWith('/snapshot') && response.ok());
  await page.locator('#saveprojectbtn').click();
  const snapshotResponse = await snapshotWhileSwitching;
  await page.locator('#addsheet').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Saved project file');
  assert.equal(await readFile(join(temp, 'saved.plan'), 'utf8'), snapshotResponse.request().postData());
  assert.notEqual(await page.locator('#tabs .tab.on').getAttribute('data-id'), originalSheet);
  await page.locator(`#tabs .tab[data-id="${originalSheet}"]`).click();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const staged = page.waitForResponse(response => response.url().endsWith('/snapshot') && response.request().method() === 'PUT' && response.ok());
  await page.locator('#saveprojectbtn').click();
  const stagedResponse = await staged;
  const captured = stagedResponse.request().postData();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await page.locator('#savefilebtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved project file and restored its connection'));
  assert.equal(await readFile(join(temp, 'saved.plan'), 'utf8'), captured);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await page.locator('#savefilebtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved project file'));
  assert.equal(JSON.parse(await readFile(join(temp, 'saved.plan'), 'utf8')).format, 'plan-project');
  // Real server-side conflict: Save to the connected file after an outside edit. The service records
  // the external change and returns stage "conflict" with no write.
  await writeFile(join(temp, 'saved.plan'), 'external change');
  const connectedCommit = page.waitForResponse(response => response.url().endsWith('/commit'));
  await page.locator('#savefilebtn').click();
  const connectedResult = await connectedCommit;
  assert.equal(connectedResult.status(), 200);
  assert.equal((await connectedResult.json()).stage, 'conflict');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('The file changed outside Plan'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  assert.equal(await readFile(join(temp, 'saved.plan'), 'utf8'), 'external change');
  // Real authorization conflict: Save As onto the same connected file after the outside edit. The
  // service rejects with HTTP 409 before any write while the operation row remains "ready".
  const sameFileCommit = page.waitForResponse(response => response.url().endsWith('/commit'));
  await page.locator('#saveprojectbtn').click();
  assert.equal((await sameFileCommit).status(), 409);
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  assert.equal(await readFile(join(temp, 'saved.plan'), 'utf8'), 'external change');
  // Repeated Save As must start a new chooser operation instead of retrying the rejected commit.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = page.waitForResponse(response => response.url().endsWith('/file-operations') && response.request().method() === 'POST');
    await page.locator('#saveprojectbtn').click();
    await started;
    await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  }
  // Restoring identical bytes is not enough: the connection also records file identity (mtime and ctime),
  // so the file must be reopened to reconnect. Afterward, Save writes to the reconnected file.
  await writeFile(join(temp, 'opened.plan'), fixture);
  await page.locator('#openprojectbtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Opened'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  const reconnectedSave = page.waitForResponse(response => response.url().endsWith('/commit') && response.status() === 200);
  await page.locator('#savefilebtn').click();
  await reconnectedSave;
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved project file'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  // A pending Open whose file is invalid when recovered is released, so Open works again.
  await writeFile(join(temp, 'opened.plan'), 'not a project');
  const startedInvalid = page.waitForResponse(response => response.url().endsWith('/file-operations') && response.request().method() === 'POST');
  await page.locator('#openprojectbtn').click();
  await startedInvalid;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await page.locator('#openprojectbtn').click();
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  await writeFile(join(temp, 'opened.plan'), fixture);
  await page.locator('#openprojectbtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Opened'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  // Real permanent attach 409: the file changes after the import is read and before attach.
  // The imported project stays; only its unconfirmed connection is dropped.
  const importedBefore = await page.evaluate(async () => (await (await fetch('/api/projects')).json()).state.workbook.sheets.length);
  await page.route('**/api/file-operations/*/attach', async route => {
    await writeFile(join(temp, 'opened.plan'), 'changed after import');
    return route.continue();
  });
  await writeFile(join(temp, 'opened.plan'), fixture);
  const attach409 = page.waitForResponse(response => response.url().endsWith('/attach') && response.status() === 409);
  await page.locator('#openprojectbtn').click();
  await attach409;
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('could not be confirmed'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  await page.unroute('**/api/file-operations/*/attach');
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/projects')).json()).state.workbook.sheets.length), importedBefore + 1);
  // The unconfirmed import can start a new Save As without an unrelated recovery prompt.
  await writeFile(join(temp, 'saved.plan'), 'changed before new save');
  const newSave = page.waitForResponse(response => response.url().endsWith('/commit') && response.status() === 200);
  await page.locator('#saveprojectbtn').click();
  await newSave;
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved project file'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  // Lost attach response, then a real attach 409 during recovery: recovery releases the pending
  // operation and leaves the imported project in place.
  await writeFile(join(temp, 'opened.plan'), fixture);
  let abortAttach = true;
  await page.route('**/api/file-operations/*/attach', async route => {
    if (abortAttach) { abortAttach = false; return route.abort('failed'); }
    return route.continue();
  });
  const importedBeforeRecovery = await page.evaluate(async () => (await (await fetch('/api/projects')).json()).state.workbook.sheets.length);
  await page.locator('#openprojectbtn').click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('plan-file-pending') || 'null')?.phase === 'attaching');
  await writeFile(join(temp, 'opened.plan'), 'changed after import');
  const recoveryAttach409 = page.waitForResponse(response => response.url().endsWith('/attach') && response.status() === 409);
  await page.locator('#saveprojectbtn').click();
  await recoveryAttach409;
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('could not be confirmed'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  await page.unroute('**/api/file-operations/*/attach');
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/projects')).json()).state.workbook.sheets.length), importedBeforeRecovery + 1);
  await writeFile(join(temp, 'saved.plan'), 'changed before new save');
  const afterRecovery = page.waitForResponse(response => response.url().endsWith('/commit') && response.status() === 200);
  await page.locator('#saveprojectbtn').click();
  await afterRecovery;
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved project file'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  // A successful Save As whose attach response is lost, after its project is deleted, must not block later actions.
  let dropSavedAttach = true;
  await page.route('**/api/file-operations/*/attach', route => {
    if (dropSavedAttach) { dropSavedAttach = false; return route.abort('failed'); }
    return route.continue();
  });
  const attachAttempt = page.waitForRequest(request => request.url().includes('/attach') && request.method() === 'POST');
  await page.locator('#saveprojectbtn').click();
  await attachAttempt;
  await page.waitForFunction(() => !document.querySelector('#saveprojectbtn').disabled);
  const orphanSheet = await page.evaluate(() => JSON.parse(sessionStorage.getItem('plan-file-pending')).sheet);
  assert.ok(orphanSheet);
  await page.evaluate(async sheetId => {
    const current = await (await fetch('/api/projects')).json();
    const workbook = current.state.workbook;
    workbook.sheets = workbook.sheets.filter(sheet => sheet.id !== sheetId);
    workbook.active = workbook.sheets[0].id;
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.revision, state: current.state }) });
    if (!response.ok) throw new Error('Could not remove the project for the test');
  }, orphanSheet);
  await page.unroute('**/api/file-operations/*/attach');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await page.locator('#saveprojectbtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('no longer exists'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  // A new Save As starts a new operation rather than retrying the abandoned one.
  const afterOrphan = page.waitForResponse(response => response.url().endsWith('/file-operations') && response.request().method() === 'POST');
  await page.locator('#saveprojectbtn').click();
  await afterOrphan;
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  // Restart the server: the same page and a fresh profile can still Open a valid file.
  await stopServer();
  assert.equal(await launchServer(Number(new URL(url).port)), url);
  await writeFile(join(temp, 'opened.plan'), fixture);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await page.locator('#openprojectbtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Opened'));
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  // Own-window autosave race. This window's autosave lands while a connected Save's commit (A) or an Open's attach (B)
  // is held, so the server refuses the held request on the revision it was authorized against. That refusal names this
  // window's own write: the operation retries on the newest revision, the connection is kept, and no stale banner appears.
  const editFirstRow = async value => {
    const autosaved = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST' && response.ok());
    await page.locator('#gbody .r').first().locator('[data-col=name]').dblclick();
    await page.locator('.editor').fill(value); await page.keyboard.press('Enter');
    await autosaved;
  };
  const activeToken = () => page.evaluate(async () => {
    const { state } = await (await fetch('/api/projects')).json();
    return state.workbook.sheets.find(sheet => sheet.id === state.workbook.active)?.fileToken ?? null;
  });
  const savedState = async () => {
    await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
    assert.doesNotMatch(await page.locator('#save-status').textContent(), /Changed elsewhere/);
  };
  // A. Connected Save: the commit is held while an edit autosaves.
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  assert.ok(await activeToken());
  let heldCommit = true;
  await page.route('**/api/file-operations/*/commit', async route => {
    if (heldCommit) { heldCommit = false; await editFirstRow('Autosaved during commit'); }
    return route.continue();
  });
  const refusedCommit = page.waitForResponse(response => response.url().endsWith('/commit') && response.status() === 409);
  const succeededCommit = page.waitForResponse(response => response.url().endsWith('/commit') && response.ok());
  const snapshotPut = page.waitForResponse(response => response.url().endsWith('/snapshot') && response.request().method() === 'PUT' && response.ok());
  await page.locator('#savefilebtn').click();
  const refused = await refusedCommit;
  assert.equal((await refused.json()).reason, 'revision');
  assert.equal((await (await succeededCommit).json()).stage, 'succeeded');
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  await page.unroute('**/api/file-operations/*/commit');
  await savedState();
  // The file holds the click-time snapshot the commit was staged with; the autosaved edit is in app storage.
  assert.equal(await readFile(join(temp, 'opened.plan'), 'utf8'), (await snapshotPut).request().postData());
  assert.ok(await activeToken());
  assert.match(JSON.stringify((await (await fetch(new URL('/api/projects', url))).json()).state), /Autosaved during commit/);
  // B. Open: the attach is held while an edit autosaves; the refused attach retries on the newest revision.
  await writeFile(join(temp, 'opened.plan'), fixture);
  let heldAttach = true;
  await page.route('**/api/file-operations/*/attach', async route => {
    if (heldAttach) { heldAttach = false; await editFirstRow('Autosaved during attach'); }
    return route.continue();
  });
  const refusedAttach = page.waitForResponse(response => response.url().endsWith('/attach') && response.status() === 409);
  const succeededAttach = page.waitForResponse(response => response.url().endsWith('/attach') && response.ok());
  await page.locator('#openprojectbtn').click();
  assert.equal((await (await refusedAttach).json()).reason, 'revision');
  await succeededAttach;
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  await page.unroute('**/api/file-operations/*/attach');
  await savedState();
  assert.ok(await activeToken());
  // The reopened connection saves without a dialog or a stale banner.
  const afterAttach = page.waitForResponse(response => response.url().endsWith('/commit') && response.ok());
  await page.locator('#savefilebtn').click();
  assert.equal((await (await afterAttach).json()).stage, 'succeeded');
  await page.waitForFunction(() => !sessionStorage.getItem('plan-file-pending'));
  await savedState();
  const secondContext = await browser.newContext();
  await secondContext.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  const secondPage = await secondContext.newPage();
  await secondPage.addInitScript(() => {
    window.showSaveFilePicker = () => { throw new Error('Browser picker must not run'); };
    indexedDB.open = () => { throw new Error('IndexedDB must not run'); };
  });
  await secondPage.goto(url);
  await secondPage.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  await secondPage.locator('#openprojectbtn').click();
  await secondPage.waitForFunction(() => document.querySelector('#toast').textContent.includes('Opened'));
  await secondContext.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(lost, { startBefore: false, startAfter: false, attach: false, write: false, startup: false });
  console.log('PASS local API browser Open, Save As, refresh/reconnect and Save without browser picker or IndexedDB; lost start, attach and write responses reconciled');
} finally {
  if (browser) await browser.close();
  await stopServer();
  await rm(temp, { recursive: true, force: true });
}
