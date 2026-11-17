// Local-only regression checks with a temporary database and isolated browser profiles.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'plan-local-only-'));
const server = spawn(process.env.PYTHON || 'python3', ['-B', 'start.py', '--port', '0', '--data-dir', temp, '--no-open'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stderr.on('data', (chunk) => { log += chunk; });
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(log)), 10000);
    server.once('exit', (code) => { clearTimeout(timer); no(new Error(`Server ${code}: ${log}`)); });
    server.stdout.on('data', (chunk) => { log += chunk; const match = log.match(/Plan is running: (http:\/\/127\.0\.0\.1:\d+\/)/); if (match) { clearTimeout(timer); yes(match[1]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  const requests = [], errors = [], external = [];
  async function fresh() {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
    context.on('request', (request) => requests.push(request.url()));
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
    return { context, page };
  }
  const { context, page } = await fresh();
  await page.addInitScript(() => {
    if (localStorage.getItem('pm-workbook-v1')) return;
    const task = (id, name, owner = '', email = '') => ({ id, name, owner, email, start: 20760, dur: 3, level: 0, progress: 0, ms: false });
    const data = (tasks) => ({ tasks, links: [], collapsed: [], nextId: 3, nextLink: 1 });
    localStorage.setItem('pm-workbook-v1', JSON.stringify({ active: 's1', nextSheet: 3, sheets: [
      { id: 's1', name: 'Local project', data: data([task(1, 'Existing contact', 'Alice Local', 'alice@example.com'), task(2, 'Assign locally')]), rem: { on: true, auto: true }, share: { driveId: 'legacy', itemId: 'legacy', auto: true } },
      { id: 's2', name: 'Older snapshot', data: data([task(1, 'Snapshot task', 'Bob Local', 'bob@example.com')]), readOnly: true, source: { driveId: 'legacy', itemId: 'other', by: 'Earlier version', fetchedAt: 0 } },
    ] }));
    localStorage.setItem('pm-proto-v2:prefs', JSON.stringify({ auto: false, critical: true }));
    localStorage.setItem('pm-reminder-owner-v2', 'native-v1');
  });
  async function saved(p = page) {
    await p.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
    return p.evaluate(async () => (await (await fetch('/api/projects')).json()).state);
  }
  await page.goto(url); await page.locator('#gbody .r[data-id="2"]').waitFor();
  await saved();
  assert.equal(await page.locator('#m365btn, #m365menu, #rembtn, #sharebtn').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Microsoft|Remind|Share/i }).count(), 0);
  await page.waitForFunction(() => document.querySelector('#save-status').textContent.includes('Saved to this computer'));
  const owner = page.locator('#gbody .r[data-id="2"] [data-col="owner"]');
  await owner.dblclick();
  const input = page.locator('#gbody input[role="combobox"]');
  await input.fill('Bob');
  await page.getByRole('option').filter({ hasText: 'Bob Local' }).click();
  await page.waitForFunction(() => document.querySelector('#gbody .r[data-id="2"] [data-col="owner"]').textContent.includes('Bob Local'));
  let state = await saved();
  let active = state.workbook.sheets.find((sheet) => sheet.id === state.workbook.active);
  assert.equal(active.data.tasks[1].owner, 'Bob Local');
  assert.equal(active.data.tasks[1].email, 'bob@example.com');
  await owner.dblclick();
  await input.fill('New manual owner'); await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('#gbody .r[data-id="2"] [data-col="owner"]').textContent.includes('New manual owner'));
  state = await saved(); active = state.workbook.sheets.find((sheet) => sheet.id === state.workbook.active);
  assert.equal(active.data.tasks[1].owner, 'New manual owner');
  assert.equal(active.data.tasks[1].email, '');
  assert.equal(active.rem.on, true, 'old active settings retained as inert metadata');
  assert.equal(active.share.auto, true, 'old sharing metadata cannot cause publishing');
  assert.equal(state.browser['pm-reminder-owner-v2'], 'native-v1');
  await page.locator('#tabs .tab[data-id="s2"]').click();
  await page.locator('#robanner').waitFor({ state: 'visible' });
  assert.match(await page.locator('#robanner').textContent(), /Read-only local snapshot/);
  assert.equal(await page.locator('.row-handle').count(), 0);
  await page.getByRole('button', { name: 'Make editable copy', exact: true }).click();
  await page.locator('#robanner').waitFor({ state: 'hidden' });
  state = await saved(); active = state.workbook.sheets.find((sheet) => sheet.id === state.workbook.active);
  assert.equal(active.name, 'Older snapshot copy'); assert(!active.readOnly); assert(!active.source); assert(!active.share);
  assert.equal(active.data.tasks[0].name, 'Snapshot task');
  assert(state.workbook.sheets.find((sheet) => sheet.id === 's2').readOnly, 'original remains intact');
  await context.close();
  const { page: restored } = await fresh();
  await restored.goto(url); await restored.locator('#gbody .r[data-id="1"]').waitFor();
  state = await saved(restored);
  assert.equal(state.workbook.sheets.find((sheet) => sheet.id === state.workbook.active).name, 'Older snapshot copy');
  assert.equal(await restored.locator('#robanner').isVisible(), false);
  assert(requests.some((request) => request.endsWith('/api/projects')), 'request capture positive control');
  assert(!requests.some((request) => /m365|msal|native\/|reminder-feasibility|graph\.microsoft|login\.microsoft/i.test(request)), 'no integration paths requested');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  console.log('PASS local-only browser checks');
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await new Promise((done) => server.exitCode != null || server.signalCode != null ? done() : server.once('exit', done));
  await rm(temp, { recursive: true, force: true });
}
