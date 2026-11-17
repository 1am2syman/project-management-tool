// Isolated diagnostics UI/export checks. Uses temporary SQLite and fresh browser profiles.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-diagnostics-ui-'));
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', temp, '--no-open', '--file-access', 'off'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stderr.on('data', (b) => { log += b; });
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(log)), 10000);
    server.once('exit', (code) => { clearTimeout(timer); no(new Error(`Server ${code}: ${log}`)); });
    server.stdout.on('data', (b) => { log += b; const m = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (m) { clearTimeout(timer); yes(m[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  async function fresh() {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true });
    await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    return { context, page: await context.newPage() };
  }
  const { context, page } = await fresh(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.addCookies([{ name: 'private_session', value: 'COOKIE_SECRET_SENTINEL', url }]);
  await page.goto(url); await page.waitForFunction(() => window.PlanDiagnostics?.snapshot().entries.some((e) => e.event === 'app.ready'));
  await page.waitForFunction(() => window.PlanDiagnostics.snapshot().entries.some((e) => e.event === 'setup.complete'));
  const logButton = page.getByRole('button', { name: 'Log', exact: true });
  const position = await logButton.boundingBox(), footer = await page.locator('#sheetbar').boundingBox();
  assert(position.y >= footer.y && position.y + position.height <= footer.y + footer.height + 1);
  await page.locator('#gbody .r[data-id="3"] [data-col=name]').dblclick();
  await page.locator('.editor').fill('PRIVATE_TASK_SENTINEL'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  // Synthetic errors and secrets exercise capture/redaction, without importing project data.
  await page.evaluate(async () => {
    sessionStorage.setItem('msal-test-token', 'CREDENTIAL_SECRET_SENTINEL');
    console.warn('diagnostic positive control');
    console.error(new Error('password=PASSWORD_SECRET_SENTINEL https://example.com/callback?token=QUERY_SECRET_SENTINEL'));
    console.log({ tasks: ['CONSOLE_PROJECT_SECRET_SENTINEL'] });
    setTimeout(() => { throw new Error('diagnostic uncaught control'); }, 0);
    Promise.reject(new Error('diagnostic rejection control'));
    await fetch('api/health?token=NETWORK_SECRET_SENTINEL');
    const xhr = new XMLHttpRequest(); xhr.open('GET', 'api/health?token=XHR_SECRET_SENTINEL'); xhr.send();
  });
  await page.waitForFunction(() => window.PlanDiagnostics.snapshot().entries.some((e) => e.event === 'javascript.unhandledrejection'));
  await page.waitForFunction(() => window.PlanDiagnostics.snapshot().entries.some((e) => e.event === 'network.xhr.end'));
  await logButton.click();
  const dialog = page.getByRole('dialog', { name: 'Diagnostic log' }); await dialog.waitFor();
  const downloadPromise = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download log' }).click();
  const download = await downloadPromise, raw = await readFile(await download.path(), 'utf8'), report = JSON.parse(raw);
  assert.match(download.suggestedFilename(), /^plan-diagnostics-.*\.json$/);
  assert.equal(report.format, 'plan-diagnostics'); assert.match(report.setup.browser.userAgent, /Chrom/);
  assert(report.setup.browserVersion.fullVersionList.some((v) => /^\d+\./.test(v.version)));
  assert.match(report.setup.server.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert(report.setup.server.python.version); assert(report.setup.server.operatingSystem.system);
  assert.equal(report.setup.indexedDB.available, true); assert.equal(report.setup.cookieSupport.writable, true);
  assert.equal(report.app.sheetCount, 1); assert.equal(report.app.taskCount, 21);
  for (const event of ['app.ready', 'storage.save.end', 'javascript.error', 'javascript.unhandledrejection', 'console.warn', 'console.error', 'network.xhr.end', 'network.fetch.end', 'diagnostics.download']) assert(report.entries.some((e) => e.event === event), event);
  for (const secret of ['COOKIE_SECRET_SENTINEL', 'CREDENTIAL_SECRET_SENTINEL', 'PASSWORD_SECRET_SENTINEL', 'QUERY_SECRET_SENTINEL', 'PRIVATE_TASK_SENTINEL', 'CONSOLE_PROJECT_SECRET_SENTINEL', 'NETWORK_SECRET_SENTINEL', 'XHR_SECRET_SENTINEL']) assert(!raw.includes(secret), secret);
  assert(raw.includes('diagnostic uncaught control'), 'positive control proves errors are actually exported');
  const dataBefore = (await (await page.request.get(url + 'api/projects')).json()).state;
  await page.keyboard.press('Delete'); await page.keyboard.press('Control+Enter');
  assert.equal((await (await page.request.get(url + 'api/projects')).json()).state.workbook.sheets[0].data.tasks.length, 21, 'log keyboard shortcuts cannot edit the sheet behind the dialog');
  await page.keyboard.press('Escape'); await page.reload();
  await page.waitForFunction(() => window.PlanDiagnostics?.snapshot().entries.some((e) => e.event === 'app.ready'));
  assert((await page.evaluate(() => window.PlanDiagnostics.snapshot())).entries.some((e) => e.event === 'diagnostics.download'));
  assert.deepEqual((await (await page.request.get(url + 'api/projects')).json()).state.workbook, dataBefore.workbook);
  await page.setViewportSize({ width: 700, height: 700 });
  assert(await logButton.isVisible()); await logButton.click(); await dialog.getByRole('button', { name: 'Clear log' }).click();
  assert((await page.evaluate(() => window.PlanDiagnostics.snapshot())).entries.length < 5);
  await context.close();

  // Main-module load failure: the early recorder and its Log button still work.
  const failed = await fresh();
  await failed.context.route('**/js/main.js', (route) => route.abort());
  await failed.page.goto(url); await failed.page.getByRole('button', { name: 'Log', exact: true }).click();
  const failedDialog = failed.page.getByRole('dialog', { name: 'Diagnostic log' }); await failedDialog.waitFor();
  const failedDownload = failed.page.waitForEvent('download'); await failedDialog.getByRole('button', { name: 'Download log' }).click();
  const failure = JSON.parse(await readFile(await (await failedDownload).path(), 'utf8'));
  assert(failure.entries.some((e) => e.event === 'resource.error' && e.detail.url.endsWith('/js/main.js')));
  assert(!failure.entries.some((e) => e.event === 'app.ready'));
  await failed.context.close();
  assert.deepEqual(errors.sort(), ['diagnostic rejection control', 'diagnostic uncaught control'].sort());
  if (process.env.PLAN_TEST_ARTIFACTS) {
    await mkdir(process.env.PLAN_TEST_ARTIFACTS, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(process.env.PLAN_TEST_ARTIFACTS, 'diagnostics-report.json'), raw);
  }
  console.log('PASS diagnostics browser checks: real Log clicks/download; startup-failure capture; secret exclusion; reload retention; keyboard isolation; narrow footer');
} finally {
  await browser?.close(); server.kill();
  await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done));
  await rm(temp, { recursive: true, force: true });
}
