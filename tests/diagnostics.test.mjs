import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/project_management_tool/web/js/diagnostics.js', import.meta.url), 'utf8');
function storage() { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; }
async function harness(options = {}) {
  const events = new Map(), timers = new Map(), output = [], memory = options.storage || storage();
  const document = { baseURI: 'http://localhost:5173/', cookie: '', visibilityState: 'visible', readyState: 'complete', querySelector: () => null, addEventListener: () => {} };
  const window = { document, location: { href: 'http://localhost:5173/?token=URL_SECRET#SECRET', origin: 'http://localhost:5173' },
    navigator: { userAgent: 'Edg/151.0.0.1', platform: 'Win32', cookieEnabled: true, language: 'en', onLine: true },
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, (...args) => output.push(args)])),
    sessionStorage: memory, localStorage: options.blockStorage ? { setItem() { throw new Error('Storage blocked'); } } : storage(),
    fetch: options.fetch || (async () => ({ ok: true, status: 200, json: async () => ({ sourceFingerprint: 'fingerprint' }) })),
    setTimeout: (fn, delay) => { const id = {}; timers.set(id, { fn, delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, fn) => { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
    AbortSignal, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, isSecureContext: true,
  };
  window.self = window; window.top = window;
  const context = vm.createContext({ window, URL, Blob, Date, Intl }); vm.runInContext(source, context);
  // Let bounded setup checks finish without firing their synthetic timeout timers.
  for (let i = 0; i < 12; i++) await Promise.resolve();
  return { api: window.PlanDiagnostics, window, context, memory, timers, output,
    emit: (name, e) => (events.get(name) || []).forEach((fn) => fn(e)),
    fire: (delay) => { for (const [id, t] of [...timers]) if (t.delay === delay) { timers.delete(id); t.fn(); } } };
}

test('setup captures browser/cookie/storage support and removes URL queries, fragments and secret values', async () => {
  const h = await harness({ blockStorage: true }), report = h.api.snapshot();
  assert.equal(report.setup.browser.userAgent, 'Edg/151.0.0.1');
  assert.equal(report.setup.storage.localStorage.available, false);
  assert.equal(typeof report.setup.cookieSupport.enabled, 'boolean');
  h.api.record('redaction', { accessToken: 'TOKEN_SECRET', password: 'PASSWORD_SECRET', tasks: ['TASK_SECRET'], error: { name: 'Error', message: 'Bearer BEARER_SECRET password=PASSWORD_SECRET email user@example.com C:\\Users\\Name\\file.plan https://example.com/file?code=QUERY_SECRET' } });
  const raw = JSON.stringify(h.api.snapshot());
  for (const secret of ['TOKEN_SECRET', 'PASSWORD_SECRET', 'TASK_SECRET', 'BEARER_SECRET', 'user@example.com', 'QUERY_SECRET', 'URL_SECRET', 'C:\\\\Users']) assert(!raw.includes(secret), secret);
  assert.equal(h.api.urlLabel('http://localhost:5173/js/projectfiles.js:188:23'), 'http://localhost:5173/js/projectfiles.js:188:23');
  assert.equal(h.api.urlLabel('http://localhost:5173/js/main.js?token=secret'), 'http://localhost:5173/js/main.js');
  assert.equal(h.api.urlLabel('https://graph.microsoft.com/users/person@example.com?access_token=secret'), 'https://graph.microsoft.com');
});

test('uncaught errors, rejected promises, resource failures and console errors retain useful evidence', async () => {
  const h = await harness();
  h.emit('error', { target: h.window, message: 'Example failure', filename: 'http://localhost:5173/js/main.js?token=secret', lineno: 45, colno: 2 });
  h.emit('error', { target: { tagName: 'SCRIPT', src: 'http://localhost:5173/js/missing.js' } });
  h.emit('unhandledrejection', { reason: 'Promise failed' });
  vm.runInContext('window.console.error(new Error("Read failed"), { accessToken: "OBJECT_SECRET" }, \'{"tasks":["PROJECT_SECRET"]}\')', h.context);
  assert.equal(h.output.length, 1, 'original console still receives the original arguments');
  const report = h.api.snapshot(), names = report.entries.map((e) => e.event);
  for (const event of ['javascript.error', 'javascript.unhandledrejection', 'resource.error', 'console.error']) assert(names.includes(event));
  assert(report.entries.find((e) => e.event === 'console.error').detail.arguments[0].stack.includes('Read failed'));
  const raw = JSON.stringify(report); assert(!raw.includes('OBJECT_SECRET')); assert(!raw.includes('PROJECT_SECRET'));
});

test('pending operations identify a hang, warn after 15 seconds and finish exactly once', async () => {
  const h = await harness(), op = h.api.begin('file.open.readText');
  assert(h.api.snapshot().pendingOperations.some((e) => e.event === 'file.open.readText'));
  h.fire(15000);
  assert(h.api.snapshot().entries.some((e) => e.event === 'file.open.readText.waiting'));
  op.fail({ name: 'AbortError', message: 'Read aborted' }); op.end();
  const report = h.api.snapshot();
  assert(!report.pendingOperations.some((e) => e.event === 'file.open.readText'));
  assert.equal(report.entries.filter((e) => e.event === 'file.open.readText.error').length, 1);
  assert.equal(report.entries.filter((e) => e.event === 'file.open.readText.end').length, 0);
});

test('log is bounded and recent evidence survives a reload without reading credential storage', async () => {
  const h = await harness();
  h.memory.setItem('msal-token', 'CREDENTIAL_SECRET');
  for (let i = 0; i < 2500; i++) h.api.record('test.activity', { index: i, message: 'x'.repeat(1000) });
  h.fire(400);
  const report = h.api.snapshot();
  assert(report.entries.length <= report.limits.maxEntries);
  assert(report.limits.droppedEntries > 0);
  assert(JSON.stringify(report.entries).length * 2 <= report.limits.maxBytes + 3000);
  const next = await harness({ storage: h.memory });
  assert(next.api.snapshot().entries.some((e) => e.detail.index === 2499));
  assert(!JSON.stringify(next.api.snapshot()).includes('CREDENTIAL_SECRET'));
});

test('fetch records metadata and failures while preserving responses and excluding headers/bodies', async () => {
  const response = { ok: false, status: 503, json: async () => ({}) };
  const h = await harness({ fetch: async () => response });
  const actual = await h.window.fetch('http://localhost:5173/api/projects?token=QUERY_SECRET', { method: 'POST', headers: { Authorization: 'HEADER_SECRET' }, body: 'BODY_SECRET' });
  assert.equal(actual, response);
  const report = h.api.snapshot(), raw = JSON.stringify(report);
  assert(report.entries.some((e) => e.event === 'network.fetch.end' && e.detail.status === 503));
  for (const secret of ['QUERY_SECRET', 'HEADER_SECRET', 'BODY_SECRET']) assert(!raw.includes(secret));
  const failing = await harness({ fetch: () => Promise.reject(new Error('Network unavailable')) });
  await assert.rejects(failing.window.fetch('/api/projects'), /Network unavailable/);
  assert(failing.api.snapshot().entries.some((e) => e.event === 'network.fetch.error'));
});
