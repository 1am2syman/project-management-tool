import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/project_management_tool/web/js/model.js';
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

function harness(store = fixture()) {
  const openButton = new Element(), saveButton = new Element(), doc = new Element();
  const elements = [], notices = [], blobs = [], revoked = [];
  doc.body = { appendChild: (el) => elements.push(el) };
  doc.querySelector = (s) => s === '#openprojectbtn' ? openButton : s === '#saveprojectbtn' ? saveButton : null;
  doc.activeElement = { blur: () => { doc.blurred = true; } };
  doc.createElement = (tag) => { const el = new Element(tag); el.onClick = () => browser.onElementClick?.(el); return el; };
  const browser = { document: doc, URL: { createObjectURL: (blob) => { blobs.push(blob); return 'blob:project'; }, revokeObjectURL: (url) => revoked.push(url) }, setTimeout: (fn) => fn() };
  const files = createProjectFiles({ store, toast: (v) => notices.push(v) }, browser);
  return { store, browser, files, openButton, saveButton, doc, elements, notices, blobs, revoked };
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
    (d) => { d.version = 4; }, (d) => { d.format = 'other'; },
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
