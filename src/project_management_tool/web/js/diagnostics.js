// Loaded before the module graph so Log remains available when startup/imports fail.
// Local, bounded diagnostics only: never record request bodies, headers, cookies or project data.
(() => {
  'use strict';
  const w = window, d = w.document, KEY = 'plan-diagnostics-v1';
  const LIMIT = 1500, BYTE_LIMIT = 384 * 1024, started = Date.now();
  let entries = [], bytes = 0, dropped = 0, sequence = 0, persistTimer, renderTimer, storeSummary;
  const pending = new Map(), setup = {}, nativeFetch = w.fetch?.bind(w);
  const clock = () => Date.now();
  const sensitive = /^(authorization|password|passwd|secret|clientSecret|accessToken|idToken|refreshToken|token|cookie|cookies|headers|body|contents|content|tasks|links|workbook|project|email|owner|value|notes|note|reason|party|approvedBy|taskName|holidays|versions|templates|causes)$/i;
  function urlLabel(value) {
    try {
      const u = new URL(String(value), w.location.href);
      if (u.origin !== w.location.origin) return u.origin;
      const position = u.pathname.match(/:\d+(?::\d+)?$/)?.[0] || '';
      const pathname = position ? u.pathname.slice(0, -position.length) : u.pathname;
      let path = '/[path]';
      if (/^\/(?:api\/(?:projects|health|diagnostics|history(?:\/\d+)?|file-access|file-connections\/check|file-operations)|js\/[\w.-]+\.js|fonts\/[\w.-]+\.woff2|(?:styles|motion)\.css|index\.html|favicon\.svg)?$/.test(pathname)) {
        path = pathname;
      } else {
        const fileOp = pathname.match(/^\/api\/file-operations\/[A-Za-z0-9_-]{1,100}(?:\/(content|snapshot|commit|attach|cancel|raise|release))?$/);
        if (fileOp) path = `/api/file-operations/[id]${fileOp[1] ? `/${fileOp[1]}` : ''}`;
      }
      return u.origin + path + position;
    } catch { return '[url]'; }
  }
  function cleanText(value, limit = 1200) {
    const text = String(value);
    if (/^\s*[\[{]/.test(text)) return '[structured message omitted]';
    return text.slice(0, 6000)
      .replace(/https?:\/\/[^\s<>"')]+/gi, (url) => urlLabel(url))
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, '[token]')
      .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|client[_-]?secret|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/\b[A-Z]:[\\/][^\r\n"<>]*/gi, '[local path]')
      .replace(/\/(?:home|Users|tmp)\/[^\s"<>)]*/g, '[local path]')
      .slice(0, limit);
  }
  function scrub(value, depth = 0) {
    if (depth > 4) return '[omitted]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return cleanText(value);
    if (value instanceof Error || (typeof value === 'object' && typeof value.message === 'string' && typeof value.name === 'string')) return { name: cleanText(value.name, 80), message: cleanText(value.message), stack: cleanText(value.stack || '', 2400) };
    if (Array.isArray(value)) return value.slice(0, 25).map((v) => scrub(v, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [cleanText(k, 80), sensitive.test(k) ? '[redacted]' : scrub(v, depth + 1)]));
    return `[${typeof value}]`;
  }
  const later = (fn, ms) => { const timer = w.setTimeout(fn, ms); timer?.unref?.(); return timer; };
  function persist() {
    persistTimer = null;
    try { w.sessionStorage.setItem(KEY, JSON.stringify({ entries, dropped })); } catch { /* memory log remains available */ }
  }
  function record(event, detail = {}, level = 'info') {
    try {
      const entry = { time: new Date().toISOString(), elapsedMs: clock() - started, level, event: cleanText(event, 120), detail: scrub(detail) };
      const size = JSON.stringify(entry).length * 2;
      entries.push(entry); bytes += size;
      while (entries.length > LIMIT || bytes > BYTE_LIMIT) { bytes -= JSON.stringify(entries.shift()).length * 2; dropped++; }
      if (!persistTimer) persistTimer = later(persist, 400);
      if (!renderTimer && d.querySelector('#diagnostics-dialog')?.open) renderTimer = later(() => { renderTimer = null; render(); }, 250);
    } catch { /* diagnostics must never interrupt application behavior */ }
  }
  function begin(event, detail) {
    const id = `${started.toString(36)}-${++sequence}`, start = clock();
    pending.set(id, { event, startedAt: new Date().toISOString(), start });
    record(`${event}.start`, { operation: id, ...detail });
    const timer = later(() => record(`${event}.waiting`, { operation: id, durationMs: clock() - start }, 'warn'), 15000);
    let done = false;
    const finish = (level, detail) => {
      if (done) return; done = true; w.clearTimeout(timer); pending.delete(id);
      record(event + (level === 'error' ? '.error' : '.end'), { operation: id, durationMs: clock() - start, ...detail }, level);
    };
    return { end: (detail) => finish('info', detail), fail: (error) => finish('error', { error }) };
  }
  function resources() {
    // The report keeps at most 25 rows (scrub), so failed requests come first: a 404 must not be crowded out by the fonts and
    // stylesheets that load around it. Everything else follows in request order.
    const rows = (w.performance?.getEntriesByType('resource') || []).slice(-80).map((entry) => ({
      url: urlLabel(entry.name), initiator: entry.initiatorType, durationMs: Math.round(entry.duration),
      transferBytes: entry.transferSize, status: entry.responseStatus,
    }));
    const failed = (row) => row.status >= 400 || row.status === 0;
    return [...rows.filter(failed), ...rows.filter((row) => !failed(row))];
  }
  function snapshot() {
    // Module dependencies finish after the initial setup check. Export their final load status too.
    setup.resources = resources();
    let app = {};
    try { app = storeSummary?.() || {}; } catch (error) { app = { summaryError: scrub(error) }; }
    return { format: 'plan-diagnostics', version: 1, exportedAt: new Date().toISOString(), captureStartedAt: new Date(started).toISOString(),
      privacy: 'Local diagnostics. No project contents, typed input, cookie values, request/response bodies, authentication headers or credential storage are collected. URLs omit queries and fragments. Error text is redacted on a best-effort basis; review before sharing.',
      limits: { maxEntries: LIMIT, maxBytes: BYTE_LIMIT, droppedEntries: dropped }, setup: scrub(setup), app: scrub(app),
      pendingOperations: [...pending].map(([id, p]) => ({ id, event: p.event, startedAt: p.startedAt, durationMs: clock() - p.start })), entries: [...entries] };
  }
  function consoleArgs(args) {
    // Preserve error stacks, but never serialize arbitrary console objects (which may be projects/tokens).
    return args.slice(0, 6).map((v) => {
      if (v instanceof Error) return scrub(v);
      if (typeof v === 'string') return cleanText(v);
      return v == null || typeof v !== 'object' ? scrub(v) : '[object omitted]';
    });
  }
  try {
    const saved = w.sessionStorage.getItem(KEY);
    if (saved && saved.length <= BYTE_LIMIT) {
      const previous = JSON.parse(saved);
      if (Array.isArray(previous.entries)) for (const e of previous.entries.slice(-LIMIT)) {
        const entry = scrub(e); entries.push(entry); bytes += JSON.stringify(entry).length * 2;
      }
      dropped = Number(previous.dropped) || 0;
    }
  } catch { /* inaccessible or corrupt log storage */ }
  w.PlanDiagnostics = { record, begin, snapshot, setStoreSummary: (fn) => { storeSummary = fn; }, scrub, urlLabel };
  record('page.start', { url: urlLabel(w.location.href), restoredEntries: entries.length });
  w.addEventListener('error', (e) => {
    if (e.target && e.target !== w) record('resource.error', { tag: e.target.tagName, url: urlLabel(e.target.src || e.target.href || '') }, 'error');
    else record('javascript.error', { error: e.error || { name: 'Error', message: e.message }, source: urlLabel(e.filename || ''), line: e.lineno, column: e.colno }, 'error');
  }, true);
  w.addEventListener('unhandledrejection', (e) => {
    let error = '[non-Error rejection]';
    if (e.reason instanceof Error) error = e.reason;
    else if (typeof e.reason === 'string') error = cleanText(e.reason);
    record('javascript.unhandledrejection', { error }, 'error');
  });
  for (const type of ['online', 'offline', 'focus', 'blur', 'pageshow', 'pagehide']) w.addEventListener(type, () => { record(`page.${type}`); if (type === 'pagehide') persist(); });
  d.addEventListener('visibilitychange', () => record('page.visibility', { visibility: d.visibilityState }));
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = w.console?.[method];
    const level = { error: 'error', warn: 'warn' }[method] || 'info';
    if (typeof original === 'function') w.console[method] = function (...args) { record(`console.${method}`, { arguments: consoleArgs(args) }, level); return original.apply(w.console, args); };
  }
  if (nativeFetch) w.fetch = function (input, init) {
    const operation = begin('network.fetch', { url: urlLabel(typeof input === 'string' || input instanceof URL ? input : input.url), method: cleanText(init?.method || input?.method || 'GET', 12) });
    try {
      return nativeFetch(input, init).then((response) => { operation.end({ status: response.status, ok: response.ok, type: response.type }); return response; }, (error) => { operation.fail(error); throw error; });
    } catch (error) { operation.fail(error); throw error; }
  };
  const XHR = w.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open, send = XHR.prototype.send, requests = new WeakMap();
    XHR.prototype.open = function (method, url, ...rest) {
      const result = open.call(this, method, url, ...rest);
      requests.set(this, { method: cleanText(method, 12), url: urlLabel(url) }); return result;
    };
    XHR.prototype.send = function (...args) {
      const span = begin('network.xhr', requests.get(this));
      const end = () => span.end({ status: this.status });
      this.addEventListener('loadend', end, { once: true });
      try { return send.apply(this, args); }
      catch (error) { this.removeEventListener('loadend', end); span.fail(error); throw error; }
    };
  }
  function controlLabel(el) {
    if (!el) return 'unnamed';
    if (el.id) return el.id;
    const ds = el.dataset;
    if (ds) {
      if (ds.act) return ds.act;
      if (ds.crit) return `crit:${ds.crit}`;
      if (ds.fit) return 'zoom:fit';
      if (ds.zoom) return `zoom:${ds.zoom}`;
      if (ds.taskAction) return `task:${ds.taskAction}`;
      if (ds.tdTab) return `td-tab:${ds.tdTab}`;
      if (ds.tdDly) return `td-dly:${ds.tdDly}`;
      if (ds.an) return `analysis:${ds.an}`;
      if (ds.go) return `analysis-go:${ds.go}`;
      if (ds.filter) return `analysis-filter:${ds.filter}`;
      if (ds.vb) return `version-banner:${ds.vb}`;
      if (ds.vm) return `version-menu:${ds.vm}`;
      if (ds.calendarTab) return `calendar-tab:${ds.calendarTab}`;
      if (ds.im) return `import:${ds.im}`;
      if (ds.k) return `export:${ds.k}${ds.all === '1' ? ':all' : ''}`;
      if (ds.f) return `field:${ds.f}`;
      if (ds.c) return `col:${ds.c}`;
      for (const attr of el.getAttributeNames?.() || []) {
        if (/^data-(?:log|td|dly|calendar|link|add|chooser|startup|wf|dwf|save|cancel|ok|restore|skip|record|more|list)-?[a-z0-9-]*$/i.test(attr)) return attr.slice(5);
      }
    }
    return el.name || el.getAttribute?.('role') || 'unnamed';
  }
  d.addEventListener('click', (e) => {
    const control = e.target.closest?.('button,input[type=checkbox],input[type=radio],select,[role=tab],[role=radio],[role=switch],[role=menuitem],[role=menuitemradio]');
    if (control) record('ui.click', { tag: control.tagName, control: controlLabel(control), disabled: !!control.disabled });
  }, true);
  d.addEventListener('change', (e) => { const el = e.target; record('ui.change', { tag: el.tagName, control: controlLabel(el), type: el.type, ...(el.type === 'file' ? { fileCount: el.files?.length } : {}) }); }, true);
  d.addEventListener('keydown', (e) => {
    const key = typeof e.key === 'string' && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if ((e.ctrlKey || e.metaKey) && ['o', 's', 'z', 'y', 'Enter', 'Delete', 'Backspace'].includes(key)) {
      record('ui.shortcut', { key, shift: !!e.shiftKey, alt: !!e.altKey });
    } else if (e.altKey && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(key)) {
      record('ui.shortcut', { key, alt: true, shift: !!e.shiftKey });
    } else if (key === 'ContextMenu' || (e.shiftKey && key === 'F10')) {
      record('ui.shortcut', { key, shift: !!e.shiftKey });
    }
  }, true);
  try {
    new w.PerformanceObserver((list) => { for (const e of list.getEntries()) record('performance.longtask', { durationMs: Math.round(e.duration) }, 'warn'); }).observe({ type: 'longtask', buffered: true });
  } catch { /* unsupported */ }

  function probeStorage(storage) {
    const key = `plan-diagnostic-probe-${started}`;
    try { storage.setItem(key, '1'); const readable = storage.getItem(key) === '1'; storage.removeItem(key); return { available: readable }; }
    catch (error) { return { available: false, error: scrub(error) }; }
  }
  async function collect() {
    const n = w.navigator;
    setup.browser = { userAgent: n.userAgent, platform: n.platform, vendor: n.vendor, language: n.language, languages: n.languages, online: n.onLine, cookieEnabled: n.cookieEnabled, hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory, webdriver: n.webdriver };
    setup.page = { url: urlLabel(w.location.href), secureContext: w.isSecureContext, topLevel: w.top === w.self, visibility: d.visibilityState, readyState: d.readyState, viewport: { width: w.innerWidth, height: w.innerHeight, devicePixelRatio: w.devicePixelRatio }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    setup.fileSupport = { fileText: typeof w.File?.prototype?.text === 'function', userActivation: n.userActivation ? { active: n.userActivation.isActive, hasBeenActive: n.userActivation.hasBeenActive } : null };
    setup.resources = resources();
    setup.features = Object.fromEntries(['showOpenFilePicker', 'showSaveFilePicker', 'indexedDB', 'FileReader', 'File', 'TextEncoder', 'AbortSignal'].map((k) => [k, typeof w[k] !== 'undefined']));
    setup.storage = {};
    for (const type of ['localStorage', 'sessionStorage']) { try { setup.storage[type] = probeStorage(w[type]); } catch (error) { setup.storage[type] = { available: false, error: scrub(error) }; } }
    try {
      // A reserved probe name avoids colliding with app storage or other tabs.
      const name = `plan_diagnostic_probe_${started}`; d.cookie = `${name}=1; SameSite=Strict; path=/`;
      const writable = d.cookie.split(';').some((c) => c.trim() === `${name}=1`);
      d.cookie = `${name}=; Max-Age=0; SameSite=Strict; path=/`;
      setup.cookieSupport = { enabled: n.cookieEnabled, writable, visibleCount: d.cookie ? d.cookie.split(';').length : 0 };
    } catch (error) { setup.cookieSupport = { enabled: n.cookieEnabled, error: scrub(error) }; }
    record('setup.browser', { browser: setup.browser, features: setup.features, storage: setup.storage, cookieSupport: setup.cookieSupport });
    const bounded = async (name, fn) => {
      const op = begin(`setup.${name}`); let timer;
      try {
        const value = await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = later(() => reject(new Error('Setup check timed out')), 3000); })]);
        setup[name] = scrub(value); op.end();
      } catch (error) { setup[name] = { error: scrub(error) }; op.fail(error); }
      finally { w.clearTimeout(timer); render(); }
    };
    await Promise.all([
      bounded('browserVersion', async () => n.userAgentData?.getHighEntropyValues ? n.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'wow64']) : { supported: false }),
      bounded('indexedDB', () => new Promise((resolve, reject) => {
        if (!w.indexedDB) return resolve({ available: false });
        const name = `plan-diagnostics-probe-${started}`, request = w.indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('probe');
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve({ available: false, blocked: true });
        request.onsuccess = () => {
          const db = request.result;
          try {
            const tx = db.transaction('probe', 'readwrite'); tx.objectStore('probe').put(1, 'test');
            const read = tx.objectStore('probe').get('test');
            const cleanup = () => { db.close(); w.indexedDB.deleteDatabase(name); };
            tx.oncomplete = () => { cleanup(); resolve({ available: read.result === 1 }); };
            tx.onerror = () => { cleanup(); reject(tx.error); };
            tx.onabort = tx.onerror;
          } catch (error) { db.close(); w.indexedDB.deleteDatabase(name); reject(error); }
        };
      })),
      bounded('storageEstimate', async () => ({ estimate: await n.storage?.estimate?.(), persistent: await n.storage?.persisted?.() })),
      bounded('server', async () => {
        if (!nativeFetch) return { available: false };
        const response = await nativeFetch(new URL('api/diagnostics', d.baseURI), { cache: 'no-store', signal: w.AbortSignal.timeout(3000) });
        if (!response.ok) return { available: false, status: response.status };
        return response.json();
      }),
    ]);
    record('setup.complete'); render();
  }
  const dialog = d.querySelector('#diagnostics-dialog'), button = d.querySelector('#logbtn');
  function render() {
    if (!dialog?.open) return;
    const report = snapshot(), pre = dialog.querySelector('pre'), pinned = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    dialog.querySelector('[data-log-status]').textContent = `${entries.length} events · ${pending.size} operations in progress${dropped ? ` · ${dropped} older events dropped` : ''}`;
    pre.textContent = JSON.stringify(report, null, 2); if (pinned) pre.scrollTop = pre.scrollHeight;
  }
  dialog?.addEventListener('keydown', (event) => event.stopPropagation());
  button?.addEventListener('click', () => { if (!dialog.open) dialog.showModal(); record('diagnostics.open'); render(); });
  dialog?.querySelector('[data-log-close]')?.addEventListener('click', () => dialog.close());
  dialog?.querySelector('[data-log-refresh]')?.addEventListener('click', () => { void collect(); });
  dialog?.querySelector('[data-log-clear]')?.addEventListener('click', () => { entries = []; bytes = 0; dropped = 0; record('diagnostics.cleared'); persist(); render(); });
  dialog?.querySelector('[data-log-download]')?.addEventListener('click', async () => {
    record('diagnostics.download');
    if (nativeFetch) {
      try {
        const response = await nativeFetch(new URL('api/diagnostics', d.baseURI), { cache: 'no-store', signal: w.AbortSignal.timeout(3000) });
        if (response.ok) setup.server = scrub(await response.json());
      } catch { /* retain the last known setup when offline */ }
    }
    const blob = new Blob([`${JSON.stringify(snapshot(), null, 2)}\n`], { type: 'application/json' });
    const url = w.URL.createObjectURL(blob), a = d.createElement('a'); a.href = url; a.download = `plan-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    d.body.appendChild(a); a.click(); a.remove(); later(() => w.URL.revokeObjectURL(url), 4000); persist();
  });
  void collect().catch((error) => record('setup.error', { error }, 'error'));
})();
