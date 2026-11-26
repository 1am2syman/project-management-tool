import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/project_management_tool/web/js/model.js';
import { importSheets } from '../src/project_management_tool/web/js/import.js';
import { createExport } from '../src/project_management_tool/web/js/export.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import { createProjectFiles, encodeProjectFile, parseProjectFile, openProjectFile, projectFileName, MAX_PROJECT_FILE_BYTES } from '../src/project_management_tool/web/js/projectfiles.js';

beforeEach(() => {
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), key: (i) => [...memory.keys()][i], get length() { return memory.size; } };
  appState.onChange(() => {}); appState.restore({});
});

function fixture() {
  const store = new Store(); store.auto = false; store.critical = false;
  store.renameSheet(store.wb.active, 'Release & delivery');
  store.setOwner(3, 'Ada', 'ada@example.com'); store.setNoRem(3, true);
  const id = store.addTask(null, true);
  assert.equal(store.addLink(21, 's', id, 'f'), null); // SF, alongside the demo's FS/SS/FF
  store.updateLink(store.links.at(-1).id, { lag: -2 });
  store.toggle(2);
  store.setRem({ on: true, auto: true, mode: 'person', offsets: [5, 1], hour: 14, subject: 'Due: {{task}}', body: 'Hello {{person}}', muted: ['muted@example.com'] });
  store.setShare(store.wb.active, { driveId: 'private-drive', itemId: 'private-file', people: { 'viewer@example.com': { permId: 'private-permission' } } });
  appState.setItem('pm-m365-config', JSON.stringify({ clientId: 'private-client' }));
  return store;
}

class Element {
  constructor(tag = '') { this.tag = tag; this.listeners = new Map(); this.registrations = []; this.disabled = false; this.removed = false; this.onClick = null; }
  addEventListener(type, fn, options) { this.registrations.push({ type, options }); if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  async dispatch(type, e = {}) { await Promise.all((this.listeners.get(type) || []).map((fn) => fn(e))); }
  click() { this.clicked = true; this.onClick?.(); return this.dispatch('click'); }
  remove() { this.removed = true; }
}

function harness(store = fixture(), storage) {
  const openButton = new Element(), saveButton = new Element(), copyButton = new Element(), doc = new Element();
  const elements = [], notices = [], blobs = [], revoked = [];
  doc.body = { appendChild: (el) => elements.push(el) };
  doc.querySelector = (s) => s === '#openprojectbtn' ? openButton : s === '#saveprojectbtn' ? saveButton : s === '#downloadcopybtn' ? copyButton : null;
  doc.activeElement = { blur: () => { doc.blurred = true; } };
  doc.createElement = (tag) => { const el = new Element(tag); el.onClick = () => browser.onElementClick?.(el); return el; };
  const browser = { document: doc, URL: { createObjectURL: (blob) => { blobs.push(blob); return 'blob:project'; }, revokeObjectURL: (url) => revoked.push(url) }, setTimeout: (fn) => fn() };
  const files = createProjectFiles({ store, storage, toast: (v) => notices.push(v) }, browser);
  return { store, browser, files, openButton, saveButton, copyButton, doc, elements, notices, blobs, revoked };
}
const file = (contents, name = 'project.plan') => ({ name, size: new TextEncoder().encode(contents).length, text: async () => contents });

// Exercise the public model integration, including a fresh browser with no old project cache.
test('native project round-trip preserves all four link types, dates, hierarchy, owners, milestones, collapsed groups and preferences', () => {
  const source = fixture(), contents = encodeProjectFile(source), expected = JSON.parse(contents);
  const original = JSON.parse(source.serialize());
  assert.deepEqual(new Set(expected.project.data.links.map((l) => l.type)), new Set(['FS', 'SS', 'FF', 'SF']));
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const target = new Store(), existing = target.wb.active;
  target.save();
  const previous = structuredClone(target.sheet());
  const id = openProjectFile(target, contents);
  assert.equal(target.wb.active, id); assert.notEqual(id, existing);
  assert.deepEqual(target.sheet(existing), previous);
  assert.deepEqual(JSON.parse(target.serialize()), expected.project.data);
  assert.equal(target.sheet().name, source.sheet().name);
  assert.equal(target.auto, false); assert.equal(target.critical, false);
  assert.deepEqual(target.rem, { ...source.rem, on: false, auto: false });
  assert.deepEqual(target.undoStack, []); assert.deepEqual(target.redoStack, []);
  assert.equal(target.sheet().share, undefined); assert.equal(target.sheet().source, undefined); assert(!target.readOnly);
  assert.deepEqual(JSON.parse(source.serialize()), original, 'saving must not mutate the live project');
  assert(!contents.includes('private-drive')); assert(!contents.includes('private-client')); assert(!contents.includes('private-permission'));
});

test('saving an automatic schedule reopens with the same schedule', () => {
  const store = new Store(); const contents = encodeProjectFile(store);
  openProjectFile(store, contents);
  assert.deepEqual(JSON.parse(store.serialize()), JSON.parse(contents).project.data);
  assert.equal(store.auto, true);
  assert.match(store.sheet().name, /\(2\)$/);
});

test('a shared read-only snapshot opens as an editable copy with its published dates', () => {
  const store = fixture(), data = JSON.parse(store.serialize());
  store.auto = true;
  store.importShared(data, 'Published plan', { driveId: 'drive', itemId: 'item', by: 'Owner' });
  assert(store.readOnly);
  const published = JSON.parse(store.serialize()), contents = encodeProjectFile(store);
  openProjectFile(store, contents);
  assert(!store.readOnly); assert.equal(store.auto, false);
  assert.deepEqual(JSON.parse(store.serialize()), published);
});

test('legacy relationship conflicts remain available for explicit review after a file round-trip', () => {
  const store = fixture();
  store.links.push({ id: 'l100', from: 3, to: 4, type: 'FS', lag: 5 }); store.nextLink = 101;
  const contents = encodeProjectFile(store);
  openProjectFile(store, contents);
  assert.equal(store.linkConflicts().length, 1);
  assert.equal(store.linksBetween(3, 4).length, 2);
});

test('an empty project is a valid native file', () => {
  const store = new Store(); store.auto = false;
  while (store.tasks.length) store.deleteTask(store.tasks[0].id);
  const contents = encodeProjectFile(store);
  openProjectFile(store, contents);
  assert.deepEqual(store.tasks, []); assert.deepEqual(store.links, []);
});

test('reject malformed, unrelated, future-version and invalid project files without modifying any app state', () => {
  const store = fixture(), good = JSON.parse(encodeProjectFile(store));
  const corruptions = [
    (d) => { d.version = 7; }, (d) => { d.format = 'other'; },
    (d) => { delete d.project; }, (d) => { d.project.name = ''; },
    (d) => { delete d.preferences; }, (d) => { d.preferences.auto = 'true'; },
    (d) => { d.project.data.tasks = {}; }, (d) => { d.project.data.tasks[1].id = d.project.data.tasks[0].id; },
    (d) => { d.project.data.tasks[0].level = 2; }, (d) => { d.project.data.tasks[2].dur = -5; },
    (d) => { d.project.data.tasks[2].start = 1e200; }, (d) => { d.project.data.tasks[2].progress = 101; },
    (d) => { d.project.data.tasks[2].email = 'invalid'; }, (d) => { d.project.data.nextId = 1; },
    (d) => { d.project.data.nextLink = 1; }, (d) => { d.project.data.collapsed.push(12345); },
    (d) => { d.project.data.links[0].to = 12345; }, (d) => { d.project.data.links[0].type = 'NO'; },
    (d) => { d.project.data.links[0].lag = 0.5; }, (d) => { d.project.data.links.push(d.project.data.links[0]); },
    (d) => { d.project.data.links[0].from = 1; }, // summary endpoint would otherwise be silently dropped by the model
    (d) => { d.project.data.links.push({ id: 'l99', from: 5, to: 3, type: 'FS', lag: 0 }); d.project.data.nextLink = 100; },
    (d) => { d.project.rem.hour = 30; }, (d) => { d.project.rem.offsets = [Infinity]; },
  ];
  const before = JSON.stringify(store.savedState());
  for (const bad of ['{', 'null', '[]', '{}', '{"tasks":[]}', ...corruptions.map((change) => { const doc = structuredClone(good); change(doc); return JSON.stringify(doc); })]) {
    assert.throws(() => openProjectFile(store, bad), /Invalid Plan project/);
    assert.equal(JSON.stringify(store.savedState()), before);
  }
  assert.equal(parseProjectFile('\uFEFF' + JSON.stringify(good)).name, good.project.name);
});

test('native Save As writes a snapshot and reports success only after close', async () => {
  const h = harness(), calls = [], expected = encodeProjectFile(h.store);
  h.browser.showSaveFilePicker = async (options) => {
    calls.push(options);
    assert(h.openButton.disabled && h.saveButton.disabled);
    h.store.newBlank(); // a later tab switch cannot change the captured file
    return { name: 'chosen.plan', createWritable: async () => ({
      write: async (contents) => { calls.push(contents); assert.equal(h.notices.length, 0); },
      close: async () => { calls.push('closed'); assert.equal(h.notices.length, 0); },
    }) };
  };
  await h.saveButton.click();
  assert.equal(calls[0].suggestedName, 'Release & delivery.plan');
  assert.deepEqual(calls[0].types[0].accept, { 'application/json': ['.plan'] });
  assert.equal(calls[1], expected); assert.equal(calls[2], 'closed');
  assert.deepEqual(h.notices, ['Saved chosen.plan']);
  assert(!h.openButton.disabled && !h.saveButton.disabled);
});

test('native Open uses a single-file picker and adds a project', async () => {
  const h = harness(), contents = encodeProjectFile(h.store), count = h.store.wb.sheets.length;
  h.browser.showOpenFilePicker = async (options) => {
    assert.equal(options.multiple, false);
    assert.deepEqual(options.types[0].accept, { 'application/json': ['.plan'] });
    return [{ getFile: async () => file(contents) }];
  };
  await h.openButton.click();
  assert.equal(h.store.wb.sheets.length, count + 1);
  assert.deepEqual(JSON.parse(h.store.serialize()), JSON.parse(contents).project.data);
  assert.match(h.notices[0], /^Opened/); assert(!h.saveButton.disabled);
});

test('cancelling either native picker is silent and leaves projects unchanged', async () => {
  const h = harness(), before = JSON.stringify(h.store.savedState());
  const cancel = async () => { throw new DOMException('Cancelled', 'AbortError'); };
  h.browser.showOpenFilePicker = cancel; h.browser.showSaveFilePicker = cancel;
  await h.files.open(); await h.files.saveAs();
  assert.equal(JSON.stringify(h.store.savedState()), before);
  assert.deepEqual(h.notices, []); assert(!h.openButton.disabled && !h.saveButton.disabled);
});

test('permission errors report failure without switching to downloads', async () => {
  const h = harness();
  h.browser.showSaveFilePicker = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  await h.files.saveAs();
  assert.match(h.notices[0], /Could not save.*Permission denied/);
  assert.equal(h.blobs.length, 0); assert(!h.saveButton.disabled);
});

test('a failed write aborts the stream and never claims a successful save', async () => {
  const h = harness(); let aborted = false, closed = false;
  h.browser.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => { throw new Error('Disk full'); }, close: async () => { closed = true; }, abort: async () => { aborted = true; } }) });
  await h.files.saveAs();
  assert(aborted); assert(!closed); assert.match(h.notices[0], /Could not save.*Disk full/); assert(!h.saveButton.disabled);
});

test('a close failure is reported as unconfirmed and is not retried', async () => {
  const h = harness(); let calls = 0;
  h.browser.showSaveFilePicker = async () => { calls++; return { createWritable: async () => ({ write: async () => {}, close: async () => { throw new Error('Lost acknowledgement'); }, abort: async () => {} }) }; };
  await h.files.saveAs();
  assert.equal(calls, 1); assert.match(h.notices[0], /Could not confirm/);
});

test('unsupported browsers download the native project and clean up the object URL', async () => {
  const h = harness(), expected = encodeProjectFile(h.store);
  await h.files.saveAs();
  assert.equal(h.elements[0].download, 'Release & delivery.plan');
  assert(h.elements[0].clicked && h.elements[0].removed);
  assert.equal(await h.blobs[0].text(), expected); assert.deepEqual(h.revoked, ['blob:project']);
  assert.match(h.notices[0], /^Download started/);
});

test('fallback file input opens a project and cleans up on selection or cancellation', async () => {
  const h = harness(), contents = encodeProjectFile(h.store), count = h.store.wb.sheets.length;
  h.browser.onElementClick = (input) => { assert.equal(input.accept, '.plan'); input.files = [file(contents)]; void input.dispatch('change'); };
  await h.files.open();
  assert.equal(h.store.wb.sheets.length, count + 1); assert(h.elements[0].removed);
  h.browser.onElementClick = (input) => { void input.dispatch('cancel'); };
  await h.files.open();
  assert.equal(h.store.wb.sheets.length, count + 1); assert(h.elements[1].removed); assert(!h.openButton.disabled);
});

test('oversized or invalid files do not change projects and do not leave controls locked', async () => {
  const h = harness(), before = JSON.stringify(h.store.savedState()); let read = false;
  h.browser.showOpenFilePicker = async () => [{ getFile: async () => ({ size: MAX_PROJECT_FILE_BYTES + 1, text: async () => { read = true; return ''; } }) }];
  await h.files.open(); assert(!read); assert.match(h.notices[0], /64 MB/);
  h.browser.showOpenFilePicker = async () => [{ getFile: async () => file('not a project') }];
  await h.files.open(); assert.match(h.notices[1], /Invalid Plan project/);
  assert.equal(JSON.stringify(h.store.savedState()), before); assert(!h.openButton.disabled);
});

test('stale windows cannot open files, including a conflict arriving while the picker is open', async () => {
  const h = harness(), before = JSON.stringify(h.store.savedState()), contents = encodeProjectFile(h.store); let picked = false;
  h.browser.showOpenFilePicker = async () => { picked = true; h.store.stale = true; return [{ getFile: async () => file(contents) }]; };
  await h.files.open(); assert(picked); assert.equal(JSON.stringify(h.store.savedState()), before);
  picked = false; await h.files.open(); assert(!picked);
  assert(h.notices.every((n) => /Reload/.test(n))); assert(!h.openButton.disabled);
  // A portable snapshot can still rescue this window's local edits.
  await h.files.saveAs(); assert.equal(h.blobs.length, 1);
});

test('keyboard shortcuts commit active edits and suppress the browser page save', async () => {
  const h = harness(); let prevented = false;
  const e = { ctrlKey: true, key: 'S', preventDefault: () => { prevented = true; }, stopPropagation: () => {} };
  assert.equal(h.doc.registrations.find((r) => r.type === 'keydown').options, true, 'capture shortcuts before cell editors stop propagation');
  await h.doc.dispatch('keydown', e);
  assert(prevented); assert(h.doc.blurred); assert.equal(h.blobs.length, 1);
});

test('portable filenames handle path characters, reserved Windows names and empty names', () => {
  assert.equal(projectFileName('Budget: Q1 / Q2?'), 'Budget_ Q1 _ Q2_.plan');
  assert.equal(projectFileName('CON'), '_CON.plan'); assert.equal(projectFileName('.. '), 'Project.plan');
  assert.equal(projectFileName('Release.plan'), 'Release.plan');
});

function nativeHandle(contents, name = 'connected.plan') {
  const h = { contents, name, writes: [], fail: null, permission: 'granted', requests: 0,
    getFile: async () => file(h.contents, h.name),
    queryPermission: async () => h.permission,
    requestPermission: async () => { h.requests++; return h.permission; },
    createWritable: async () => {
      let pending;
      return { write: async (text) => { if (h.fail === 'write') throw new Error('Write failed'); pending = text; },
        close: async () => { h.contents = pending; h.writes.push(pending); if (h.fail === 'close') throw new Error('Lost acknowledgement'); }, abort: async () => {} };
    },
  }; return h;
}
test('Open connects the file: subsequent Save writes the same handle without a picker, independently per sheet', async () => {
  const h = harness(), a = nativeHandle(encodeProjectFile(h.store)); let picks = 0;
  h.browser.showOpenFilePicker = async () => [a]; h.browser.showSaveFilePicker = async () => { picks++; throw new Error('Unexpected picker'); };
  await h.files.open(); const openedId = h.store.wb.active;
  h.store.setCell(3, 'name', 'Changed task'); await h.files.save();
  assert.equal(picks, 0); assert.equal(a.writes.length, 1); assert.match(a.contents, /Changed task/);
  h.store.newBlank(); await h.files.save(); assert.equal(picks, 1);
  h.store.switchSheet(openedId); h.store.setCell(3, 'name', 'Changed again'); await h.files.save();
  assert.equal(picks, 1); assert.equal(a.writes.length, 2); assert.match(a.contents, /Changed again/);
});
test('Save As reconnects only after success; cancellation and failed writes retain the previous file', async () => {
  const h = harness(), a = nativeHandle(encodeProjectFile(h.store)), b = nativeHandle('', 'new.plan');
  h.browser.showOpenFilePicker = async () => [a]; await h.files.open();
  h.browser.showSaveFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
  await h.files.saveAs(); await h.files.save(); assert.equal(a.writes.length, 1);
  b.fail = 'write'; h.browser.showSaveFilePicker = async () => b;
  await h.files.saveAs(); await h.files.save(); assert.equal(a.writes.length, 2);
  b.fail = null; await h.files.saveAs(); h.store.setCell(3, 'name', 'New binding'); await h.files.save();
  assert.equal(a.writes.length, 2); assert.equal(b.writes.length, 2); assert.match(b.contents, /New binding/);
});
test('connected Save refuses external modifications, permission denial, stale and read-only windows', async () => {
  const h = harness(), original = encodeProjectFile(h.store), a = nativeHandle(original);
  h.browser.showOpenFilePicker = async () => [a]; await h.files.open();
  a.contents = original.replace('Release & delivery', 'Externally edited'); await h.files.save();
  assert.match(h.notices.at(-1), /changed outside Plan/); assert.equal(a.writes.length, 0);
  a.contents = original; a.permission = 'denied'; await h.files.save();
  assert.equal(a.requests, 1); assert.equal(a.writes.length, 0); assert.match(h.notices.at(-1), /File access denied/);
  a.permission = 'granted'; h.store.stale = true; await h.files.save(); assert.equal(a.writes.length, 0); assert.match(h.notices.at(-1), /outdated window/);
  h.store.stale = false; h.store.sheet().readOnly = true; await h.files.save(); assert.equal(a.writes.length, 0);
});
test('a connected save with uncertain close reconciles the file before the next write', async () => {
  const h = harness(), a = nativeHandle(encodeProjectFile(h.store)); h.browser.showOpenFilePicker = async () => [a]; await h.files.open();
  h.store.setCell(3, 'name', 'First write'); a.fail = 'close'; await h.files.save(); assert.match(h.notices.at(-1), /Could not confirm/);
  a.fail = null; h.store.setCell(3, 'name', 'Reconciled write'); await h.files.save();
  assert.equal(a.writes.length, 2); assert.match(h.notices.at(-1), /^Saved/); assert.match(a.contents, /Reconciled write/);
});
test('save connection follows the sheet captured before an asynchronous picker, and duplication gets no file connection', async () => {
  const h = harness(), first = h.store.wb.active, a = nativeHandle('');
  h.browser.showSaveFilePicker = async () => { h.store.newBlank(); return a; };
  await h.files.saveAs(); assert(h.store.sheet(first).fileToken); assert.equal(h.store.sheet().fileToken, undefined);
  h.store.switchSheet(first); const copy = h.store.duplicateSheet(first); assert.equal(h.store.sheet(copy).fileToken, undefined);
  h.store.switchSheet(first); await h.files.save(); assert.equal(a.writes.length, 2);
});

test('a stale conflict arriving during a connected-file read stops the write', async () => {
  const h = harness(), a = nativeHandle(encodeProjectFile(h.store)); h.browser.showOpenFilePicker = async () => [a]; await h.files.open();
  a.getFile = async () => { h.store.stale = true; return file(a.contents); };
  await h.files.save(); assert.equal(a.writes.length, 0); assert.match(h.notices.at(-1), /another window/);
});

test('diagnostics identifies a stalled native read and traces every successful Open stage without file contents', async (t) => {
  const events = [], pending = new Set();
  globalThis.PlanDiagnostics = {
    record: (event, detail) => events.push({ event, detail }),
    begin: (event, detail) => {
      events.push({ event: `${event}.start`, detail }); pending.add(event);
      return { end: (detail) => { pending.delete(event); events.push({ event: `${event}.end`, detail }); }, fail: (error) => { pending.delete(event); events.push({ event: `${event}.error`, error }); } };
    },
  };
  t.after(() => { delete globalThis.PlanDiagnostics; });
  const h = harness(), contents = encodeProjectFile(h.store);
  let release;
  h.browser.showOpenFilePicker = async () => [{ getFile: () => new Promise((resolve) => { release = resolve; }) }];
  const opened = h.files.open();
  await new Promise(setImmediate);
  assert(pending.has('file.open.getFile')); assert(h.openButton.disabled);
  let releaseText;
  release({ ...file(contents, 'PRIVATE_PROJECT.plan'), text: () => new Promise((resolve) => { releaseText = resolve; }) });
  await new Promise(setImmediate);
  assert(pending.has('file.open.readText')); assert(!pending.has('file.open.getFile'));
  releaseText(contents); await opened;
  for (const stage of ['file.open.picker', 'file.open.getFile', 'file.open.readText', 'file.open.validate', 'file.open.apply', 'file.open.connect', 'file.open']) assert(events.some((e) => e.event === `${stage}.end`), stage);
  assert(events.some((e) => e.event === 'file.open.controlsUnlocked'));
  assert(!JSON.stringify(events).includes('PRIVATE_PROJECT'));
  assert(!JSON.stringify(events).includes('Release & delivery'));
  assert(!h.openButton.disabled); assert.equal(pending.size, 0);
});

test('diagnostics records AbortError during getFile even when the UI treats it silently', async (t) => {
  const events = [];
  globalThis.PlanDiagnostics = { record: (event, detail) => events.push({ event, detail }) };
  t.after(() => { delete globalThis.PlanDiagnostics; });
  const h = harness();
  h.browser.showOpenFilePicker = async () => [{ getFile: async () => { throw new DOMException('File could not be read', 'AbortError'); } }];
  await h.files.open();
  const failure = events.find((e) => e.event === 'file.open.failure');
  assert.equal(failure.detail.error.name, 'AbortError'); assert.equal(failure.detail.cancelledOrAborted, true);
  assert(!h.openButton.disabled); assert.deepEqual(h.notices, []);
});

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
function causedFile() {
  const doc = JSON.parse(encodeProjectFile(fixture()));
  doc.version = 6; doc.project.causes = [{ id: 'c88', name: 'Supplier power outage' }];
  Object.assign(doc.project.data, { baselined: true, nextLog: 2, log: [{ id: 1, type: 'delay', taskId: 3, taskName: 'Design', at: 1, days: 2, cause: 'c88' }] });
  return JSON.stringify(doc);
}

test('file-open keeps causes, preferences, binding and project isolated until one acknowledgement', async () => {
  const source = causedFile(), store = fixture(), before = structuredClone(store.savedState());
  const ack = deferred(); let attempted, writes = 0;
  store.enableCommits(async candidate => { writes++; attempted = candidate; await ack.promise; });
  const opening = openProjectFile(store, source, { fileToken: 'local-open' });
  await tick();
  assert.equal(writes, 1); assert.equal(store.wb.sheets.length, before.workbook.sheets.length);
  assert.deepEqual(appState.snapshot(), before.browser);
  const sheet = attempted.workbook.sheets.at(-1), causes = JSON.parse(attempted.browser['pm-delay-causes']);
  assert.equal(sheet.fileToken, 'local-open');
  assert(causes.list.some(c => c.name === 'Supplier power outage'));
  assert.notEqual(sheet.data.log[0].cause, 'c88');
  ack.resolve(); const id = await opening;
  assert.equal(store.wb.active, id); assert.equal(store.sheet(id).fileToken, 'local-open');
  assert.equal(writes, 1); assert.deepEqual(appState.snapshot(), attempted.browser);
});

test('failed open preserves committed workspace and causes; Download copy uses frozen candidate causes without any service', async () => {
  const store = fixture(), before = structuredClone(store.savedState()); let writes = 0;
  store.enableCommits(async () => { writes++; throw new Error('SQLite disk full'); });
  const h = harness(store, { barrier: () => { throw new Error('copy must not check storage'); } });
  h.browser.fetch = () => { throw new Error('copy must not call backend'); };
  h.browser.showSaveFilePicker = () => { throw new Error('copy must not call native'); };
  h.doc.activeElement.blur = () => { throw new Error('copy must not submit input'); };
  await assert.rejects(openProjectFile(store, causedFile(), { fileToken: 'local-failed' }), /disk full/);
  assert(store.suspended); assert(Object.isFrozen(store.pendingCandidate));
  assert.equal(store.wb.sheets.length, before.workbook.sheets.length); assert.deepEqual(appState.snapshot(), before.browser);
  const frozen = JSON.stringify(store.pendingCandidate);
  await h.copyButton.click();
  const copy = parseProjectFile(await h.blobs[0].text());
  assert(copy.causes.some(c => c.name === 'Supplier power outage'));
  assert(copy.data.log.some(e => copy.causes.some(c => c.id === e.cause)));
  assert.match(h.elements[0].download, /unsaved copy\)\.plan$/);
  assert.match(h.notices.at(-1), /Download started.*unsaved copy.*Check Downloads/);
  assert.equal(JSON.stringify(store.pendingCandidate), frozen); assert.equal(writes, 1);
  assert.equal(h.elements[0].removed, true); assert.deepEqual(h.revoked, ['blob:project']);
});

test('multi-sheet import has one commit, no partial visibility, and retains all staged sheets on failure', async () => {
  const store = fixture(), before = structuredClone(store.savedState()), ack = deferred(); let writes = 0, attempted;
  store.enableCommits(async candidate => { writes++; attempted = candidate; await ack.promise; });
  const data = JSON.parse(store.serialize());
  const importing = importSheets(store, [{ title: 'First import', data }, { title: 'Second import', data }]);
  await tick(); assert.equal(writes, 1); assert.equal(store.wb.sheets.length, before.workbook.sheets.length);
  assert.deepEqual(attempted.workbook.sheets.slice(-2).map(s => s.name), ['First import', 'Second import']);
  ack.reject(new Error('Lost response'));
  await assert.rejects(importing, /Lost response/);
  assert.equal(store.wb.sheets.length, before.workbook.sheets.length);
  assert.deepEqual(store.pendingCandidate.workbook.sheets.slice(-2).map(s => s.name), ['First import', 'Second import']);
  assert.equal(writes, 1);
});

test('normal Save awaits the editor commit and health before encoding or backend initialization', async () => {
  const store = fixture(), ack = deferred(), health = deferred(), order = []; let editing;
  store.enableCommits(async () => { order.push('commit'); await ack.promise; });
  const h = harness(store, { barrier: async () => { order.push('health'); await health.promise; } });
  h.doc.baseURI = 'http://localhost/';
  h.browser.fetch = async () => { order.push('backend'); return { status: 404 }; };
  h.doc.activeElement.blur = () => { order.push('blur'); editing = store.setCell(3, 'name', 'Acknowledged editor change'); };
  const save = h.files.saveAs();
  await tick(); assert.deepEqual(order, ['blur', 'commit']); assert.equal(h.blobs.length, 0);
  ack.resolve(); await editing; await tick(); assert.deepEqual(order, ['blur', 'commit', 'health']);
  assert.equal(h.blobs.length, 0);
  health.resolve(); await save;
  assert.deepEqual(order, ['blur', 'commit', 'health', 'backend']);
  assert.match(await h.blobs[0].text(), /Acknowledged editor change/);
});

test('failed blur commit or workspace health prevents encoding and native startup and offers Download copy', async () => {
  for (const failure of ['commit', 'health']) {
    const store = fixture(); let backend = 0, checks = 0;
    store.enableCommits(async () => { if (failure === 'commit') throw new Error('Editor disk full'); });
    const h = harness(store, { barrier: async () => { checks++; throw new Error('Workspace unavailable'); } });
    h.doc.baseURI = 'http://localhost/';
    h.browser.fetch = async () => { backend++; throw new Error('must not initialize'); };
    let editing;
    h.doc.activeElement.blur = () => { if (failure === 'commit') { editing = store.setCell(3, 'name', 'Failed editor candidate'); void Promise.resolve(editing).catch(() => {}); } };
    store.serialize = () => { throw new Error('must not encode before health'); };
    // The commit coordinator needs its original serializer to build a draft.
    if (failure === 'commit') delete store.serialize;
    await h.files.saveAs();
    if (editing) await assert.rejects(editing, /disk full/);
    assert.equal(backend, 0); assert.equal(checks, failure === 'commit' ? 0 : 1); assert.equal(h.blobs.length, 0);
    assert.match(h.notices.at(-1), /Download copy/);
    assert.equal(h.saveButton.disabled, failure === 'commit'); assert(!h.copyButton.disabled);
  }
});

test('Download copy remains independent while a prior native write has an unknown outcome', async () => {
  const h = harness(fixture(), { barrier: async () => '7' }), session = new Map();
  h.doc.baseURI = 'http://localhost/';
  h.browser.crypto = { randomUUID: () => 'operation-id' };
  h.browser.sessionStorage = { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) };
  let writes = 0, reads = 0, down = false;
  const json = body => ({ ok: true, status: 200, json: async () => body });
  h.browser.fetch = async (url, options = {}) => {
    if (down) throw new Error('Python stopped');
    const path = url.pathname;
    if (path.endsWith('/file-access')) return json({ version: 1, available: true, session: 'test' });
    if (path.endsWith('/snapshot')) return json({ stage: 'ready', hasSnapshot: true });
    if (path.endsWith('/commit')) { writes++; down = true; throw new Error('Lost write acknowledgement'); }
    if (path.endsWith('/file-operations') && options.method === 'POST') return json({ stage: 'ready' });
    reads++; return json({ stage: 'ready', kind: 'save_as', hasSnapshot: true });
  };
  await h.files.saveAs();
  const journal = session.get('plan-file-pending'), priorReads = reads;
  assert(journal); assert.match(h.notices.at(-1), /Could not confirm/);
  h.files.downloadCopy();
  assert.equal(writes, 1); assert.equal(reads, priorReads); assert.equal(session.get('plan-file-pending'), journal);
  assert.equal(h.blobs.length, 1); assert.match(h.notices.at(-1), /Download started.*Check Downloads/);
});

test('Excel/PDF export preparation reads all projects without store.save or a workspace write', async t => {
  const store = fixture(); store.newBlank();
  let writes = 0;
  store.save = () => { writes++; throw new Error('read-only export must not save'); };
  const h = harness(store), button = new Element(), menu = new Element();
  const notices = [];
  h.doc.querySelector = selector => selector === '#expbtn' ? button : selector === '#expmenu' ? menu : null;
  t.mock.method(globalThis, 'setTimeout', fn => { fn(); });
  const oldDocument = globalThis.document; globalThis.document = h.doc;
  t.after(() => { globalThis.document = oldDocument; });
  const exporter = createExport({ store, toast: text => notices.push(text) });
  await exporter.run('pdf', true);
  assert.equal(writes, 0); assert.match(notices.at(-1), /^Exported 2 sheets/);
  await exporter.run('xlsx', true);
  assert.equal(writes, 0); assert.match(notices.at(-1), /^Exported 2 sheets/);
});

test('binding a successfully written browser file waits for workspace acknowledgement and rejects without changing the old connection', async () => {
  const store = fixture(), ack = deferred(); let attempted, writes = 0;
  store.enableCommits(async candidate => { writes++; attempted = candidate; await ack.promise; });
  const h = harness(store), handle = nativeHandle(''); h.browser.showSaveFilePicker = async () => handle;
  const saving = h.files.saveAs(); await tick();
  assert.equal(handle.writes.length, 1); assert.equal(writes, 1);
  assert(attempted.workbook.sheets.find(s => s.id === store.wb.active).fileToken);
  assert.equal(store.sheet().fileToken, undefined); assert.equal(h.notices.length, 0); assert(h.saveButton.disabled);
  ack.reject(new Error('Binding commit failed')); await saving;
  assert.equal(store.sheet().fileToken, undefined); assert(store.suspended);
  assert.equal(handle.writes.length, 1); assert.match(h.notices.at(-1), /file was saved.*connection could not be confirmed.*Binding commit failed/);
  h.files.downloadCopy(); assert.equal(handle.writes.length, 1); assert.match(h.notices.at(-1), /unsaved copy/);
});

test('native open binds in its import commit; a definitive attach rejection drops the token in another acknowledged candidate', async () => {
  const source = encodeProjectFile(fixture()), store = fixture(), imported = deferred(), dropped = deferred();
  let count = 0, attaches = 0; const candidates = [];
  store.enableCommits(async candidate => { candidates.push(candidate); count++; await (count === 1 ? imported : dropped).promise; });
  const h = harness(store, { barrier: async () => { await store.whenIdle(); return '7'; }, currentRevision: async () => '8', ownsRevision: async () => false, markStale: () => {} });
  const session = new Map(); h.doc.baseURI = 'http://localhost/'; h.browser.crypto = { randomUUID: () => 'open-id' };
  h.browser.sessionStorage = { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) };
  const json = body => ({ ok: true, status: 200, json: async () => body });
  h.browser.fetch = async url => {
    if (url.pathname.endsWith('/file-access')) return json({ version: 1, available: true, session: 'test' });
    if (url.pathname.endsWith('/content')) return { ok: true, text: async () => source };
    if (url.pathname.endsWith('/attach')) { attaches++; return { ok: false, status: 409, json: async () => ({ reason: 'binding', error: 'attach refused' }) }; }
    return json({ stage: 'ready', kind: 'open', token: 'local-selected' });
  };
  const before = store.wb.sheets.length, opening = h.files.open(); await tick();
  assert.equal(count, 1); assert.equal(attaches, 0); assert.equal(store.wb.sheets.length, before);
  assert.equal(candidates[0].workbook.sheets.at(-1).fileToken, 'local-selected');
  imported.resolve(); await tick();
  assert.equal(store.wb.sheets.length, before + 1); assert.equal(attaches, 1); assert.equal(count, 2);
  assert.equal(store.sheet().fileToken, 'local-selected'); assert.equal(candidates[1].workbook.sheets.at(-1).fileToken, undefined);
  assert(session.has('plan-file-pending')); assert.equal(h.notices.length, 0);
  dropped.resolve(); await opening;
  assert.equal(store.sheet().fileToken, undefined); assert(!session.has('plan-file-pending'));
  assert.match(h.notices.at(-1), /connection could not be confirmed/);
});

test('Download copy works while normal Save is stalled and does not wait for or poll its journal', async () => {
  const bootstrap = deferred(), h = harness(fixture(), { barrier: async () => '1' });
  h.doc.baseURI = 'http://localhost/'; let requests = 0;
  const journal = '{"id":"previous-write","phase":"writing"}';
  h.browser.sessionStorage = { getItem: () => journal, setItem: () => { throw new Error('copy changed the journal'); }, removeItem: () => { throw new Error('copy cleared the journal'); } };
  h.browser.fetch = () => { requests++; return bootstrap.promise; };
  const saving = h.files.saveAs(); await tick();
  assert(h.saveButton.disabled); assert.equal(requests, 1);
  await h.copyButton.click();
  assert.equal(h.blobs.length, 1); assert.equal(requests, 1); assert(!h.copyButton.disabled);
  assert.match(h.notices.at(-1), /Download started.*Check Downloads/);
  bootstrap.reject(new Error('Python unavailable')); await saving;
  assert.equal(h.blobs.length, 1); assert.equal(requests, 1);
});

test('unacknowledged file-open commit retains native evidence and verified adoption reconnects without importing twice', async () => {
  const contents = encodeProjectFile(fixture()), store = fixture();
  store.enableCommits(async () => { throw new Error('Lost workspace response'); });
  const h = harness(store, { barrier: async () => { await store.whenIdle(); return '7'; } });
  const session = new Map(); let starts = 0, releases = 0, attaches = 0;
  h.doc.baseURI = 'http://localhost/'; h.browser.crypto = { randomUUID: () => 'open-lost' };
  h.browser.sessionStorage = { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) };
  const json = body => ({ ok: true, status: 200, json: async () => body });
  h.browser.fetch = async (url, options = {}) => {
    if (url.pathname.endsWith('/file-access')) return json({ version: 1, available: true, session: 'test' });
    if (url.pathname.endsWith('/content')) return { ok: true, text: async () => contents };
    if (url.pathname.endsWith('/file-operations') && options.method === 'POST') starts++;
    if (url.pathname.endsWith('/release')) releases++;
    if (url.pathname.endsWith('/attach')) { attaches++; return json({ stage: 'succeeded' }); }
    return json({ stage: 'ready', kind: 'open', token: 'local-lost' });
  };
  const count = store.wb.sheets.length;
  await h.files.open();
  assert(store.suspended); assert.equal(store.wb.sheets.length, count);
  assert.equal(starts, 1); assert.equal(releases, 0); assert.equal(attaches, 0);
  const journal = session.get('plan-file-pending'); assert(journal);
  h.files.downloadCopy(); assert.equal(session.get('plan-file-pending'), journal);
  assert.match(h.notices.at(-1), /unsaved copy/);
  store.adoptPending(store.pendingCandidate);
  await h.files.saveAs();
  assert.equal(store.wb.sheets.length, count + 1); assert.equal(starts, 1); assert.equal(attaches, 1); assert.equal(releases, 0);
  assert(!session.has('plan-file-pending'));
});

test('locked tabs refuse Open, Save and Save As before blur, health, pickers or file writes while Download copy remains usable', async () => {
  const store = fixture(); store.enableCommits(async () => { throw new Error('read-only tab wrote workspace'); }); store.locked = true;
  const h = harness(store, { barrier: () => { throw new Error('read-only action checked health'); } });
  h.doc.activeElement.blur = () => { throw new Error('read-only action blurred input'); };
  h.browser.fetch = () => { throw new Error('read-only action initialized native backend'); };
  h.browser.showOpenFilePicker = () => { throw new Error('read-only action opened chooser'); };
  h.browser.showSaveFilePicker = () => { throw new Error('read-only action saved file'); };
  await h.files.open(); await h.files.save(); await h.files.saveAs();
  assert.equal(h.blobs.length, 0); assert.equal(h.notices.length, 3);
  assert(h.notices.every(notice => /read-only.*Download copy/.test(notice)));
  h.files.downloadCopy(); assert.equal(h.blobs.length, 1);
});

test('decision preview cannot silently become an accepted project copy through the presentation proxy', () => {
  const store = fixture(); store.enableCommits(async () => {});
  const committedName = store.tasks.find(task => task.id === 3).name;
  const draft = store.makeDraft(); draft.setCell(3, 'name', 'Unaccepted decision preview'); store.decisionPreview = draft;
  assert.match(store.presentation.serialize(), /Unaccepted decision preview/, 'positive control: presentation exposes the draft');
  const encoded = parseProjectFile(encodeProjectFile(store.presentation));
  assert.equal(encoded.data.tasks.find(task => task.id === 3).name, committedName);
  const h = harness(store.presentation); h.files.downloadCopy();
  assert(!h.elements[0].download.includes('unsaved copy'));
  assert(!h.notices.at(-1).includes('unsaved copy'));
});

test('file shortcuts stay outside a delay decision or pending action and never lock the file buttons', async () => {
  for (const pending of [false, true]) {
    const store = fixture(), h = harness(store); Object.defineProperty(store, 'pending', { value: pending });
    const query = h.doc.querySelector;
    h.doc.querySelector = selector => selector.includes('.dly-pop') && !pending ? {} : query(selector);
    h.doc.activeElement.blur = () => { throw new Error('shortcut submitted a staged decision'); };
    for (const key of ['o', 's']) {
      let prevented = false;
      await h.doc.dispatch('keydown', { ctrlKey: true, key, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
      assert(prevented); assert(!h.openButton.disabled); assert(!h.saveButton.disabled);
    }
    assert.equal(h.blobs.length, 0);
  }
});

test('file controls track acknowledged actions, suspension and locks without unlocking an active native operation', async () => {
  const store = fixture(), acknowledgement = deferred(), picker = deferred();
  store.enableCommits(async () => { await acknowledgement.promise; });
  const h = harness(store), normalSave = new Element();
  normalSave.querySelector = () => ({ textContent: '' });
  // Use a second controller with the normal Save control present as in production.
  const query = h.doc.querySelector;
  h.doc.querySelector = selector => selector === '#savefilebtn' ? normalSave : query(selector);
  const files = createProjectFiles({ store, toast: text => h.notices.push(text) }, h.browser);
  const controls = [h.openButton, normalSave, h.saveButton];
  assert(controls.every(control => !control.disabled)); assert(!h.copyButton.disabled);
  const editing = store.setCell(3, 'name', 'Awaited action');
  await tick(); assert(controls.every(control => control.disabled)); assert(!h.copyButton.disabled);
  acknowledgement.resolve(); await editing;
  assert(controls.every(control => !control.disabled)); assert(!h.copyButton.disabled);
  h.browser.showSaveFilePicker = () => picker.promise;
  const saving = files.saveAs(); await tick(); assert(controls.every(control => control.disabled));
  store.emit('idle'); assert(controls.every(control => control.disabled), 'model idle cannot clear native busy');
  picker.reject(new DOMException('Cancelled', 'AbortError')); await saving;
  assert(controls.every(control => !control.disabled));
  store.locked = true; store.emit('change');
  assert(controls.every(control => control.disabled)); assert(!h.copyButton.disabled);
  store.locked = false; store.emit('change'); assert(controls.every(control => !control.disabled));
  store.suspend(new Error('Storage unavailable'));
  assert(controls.every(control => control.disabled)); assert(!h.copyButton.disabled);
});
