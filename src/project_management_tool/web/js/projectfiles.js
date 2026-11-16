import { diagnostics } from './diagnosticlog.js';
import { cleanRem, isEmail, LINK_TYPES } from './model.js';
import { createFileBindings } from './filebindings.js';
import { calendarError, WorkingCalendar } from './calendar.js';

export const PROJECT_FILE_EXTENSION = '.plan';
export const MAX_PROJECT_FILE_BYTES = 64 * 1024 * 1024;
const FORMAT = 'plan-project', VERSION = 3;
const TYPES = [{ description: 'Plan project', accept: { 'application/json': [PROJECT_FILE_EXTENSION] } }];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v, max) => typeof v === 'string' && v.length <= max;
const invalid = (detail) => { throw new Error(`Invalid Plan project: ${detail}`); };

function validateTasks(tasks) {
  const ids = new Set(); let previousLevel = -1, maxId = 0;
  for (const t of tasks) {
    if (!object(t) || !integer(t.id, 1) || ids.has(t.id)) invalid('task IDs must be unique positive integers.');
    if (!text(t.name, 200) || !t.name.trim() || !text(t.owner, 80) || !text(t.email, 254) || (t.email && !isEmail(t.email))) invalid(`task ${t.id} has invalid text or email fields.`);
    if (!integer(t.level, 0, previousLevel + 1)) invalid(`task ${t.id} has an invalid hierarchy level.`);
    // Stay inside JavaScript's representable date range, including the exclusive finish date.
    if (!integer(t.start, -99999999, 99999999) || typeof t.ms !== 'boolean' || !integer(t.dur, t.ms ? 0 : 1, 99999999) || (t.ms && t.dur !== 0) || Math.abs(t.start + t.dur) > 99999999) invalid(`task ${t.id} has an invalid date or duration.`);
    if (t.scheduling != null && !['auto', 'manual', 'anchor'].includes(t.scheduling)) invalid(`task ${t.id} has invalid scheduling mode.`);
    if (!integer(t.progress, 0, 100) || typeof t.noRem !== 'boolean') invalid(`task ${t.id} has invalid progress or reminder settings.`);
    ids.add(t.id); maxId = Math.max(maxId, t.id); previousLevel = t.level;
  }
  const summaries = new Set(tasks.filter((t, i) => tasks[i + 1]?.level > t.level).map((t) => t.id));
  return { ids, maxId, summaries };
}

function validateLinks(links, ids, summaries) {
  const linkIds = new Set(), outgoing = new Map(), indegree = new Map([...ids].map((id) => [id, 0])); let maxLink = 0;
  for (const l of links) {
    if (!object(l) || typeof l.id !== 'string' || !/^l[1-9]\d*$/.test(l.id) || !integer(Number(l.id.slice(1)), 1) || linkIds.has(l.id)) invalid('relationship IDs must be unique.');
    if (!ids.has(l.from) || !ids.has(l.to) || l.from === l.to || summaries.has(l.from) || summaries.has(l.to) || !LINK_TYPES.includes(l.type) || !integer(l.lag, -99999999, 99999999)) invalid(`relationship ${l.id} has invalid endpoints, type or lag.`);
    linkIds.add(l.id); maxLink = Math.max(maxLink, Number(l.id.slice(1)));
    if (!outgoing.has(l.from)) outgoing.set(l.from, []);
    outgoing.get(l.from).push(l.to); indegree.set(l.to, indegree.get(l.to) + 1);
  }
  const queue = [...ids].filter((id) => indegree.get(id) === 0);
  for (let i = 0; i < queue.length; i++) for (const to of outgoing.get(queue[i]) || []) {
    indegree.set(to, indegree.get(to) - 1);
    if (indegree.get(to) === 0) queue.push(to);
  }
  if (queue.length !== ids.size) invalid('relationships contain a dependency cycle.');
  return maxLink;
}

function validateReminders(r) {
  if (!object(r) || typeof r.on !== 'boolean' || typeof r.auto !== 'boolean' || typeof r.overdue !== 'boolean') invalid('reminder switches are invalid.');
  if (!['task', 'person', 'project'].includes(r.mode) || !integer(r.hour, 0, 23)) invalid('reminder mode or send hour is invalid.');
  if (!Array.isArray(r.offsets) || r.offsets.length > 8 || r.offsets.some((n) => !integer(n, 0, 60))) invalid('reminder lead times are invalid.');
  if (!text(r.subject, 200) || !text(r.body, 4000)) invalid('reminder message is invalid.');
  if (!Array.isArray(r.muted) || r.muted.length > 500 || r.muted.some((email) => !isEmail(email))) invalid('muted reminder addresses are invalid.');
}

// Validate before the model's forgiving storage sanitizer can discard or repair file contents.
function validateDocument(doc) {
  if (!object(doc) || doc.format !== FORMAT) invalid('choose a .plan file saved by Plan.');
  if (![1, 2, VERSION].includes(doc.version)) invalid(`file version ${doc.version} is not supported. Update Plan to open this file.`);
  const p = doc.project, prefs = doc.preferences;
  if (!object(p) || !text(p.name, 60) || !p.name.trim()) invalid('the project name is missing or too long.');
  if (!object(prefs) || typeof prefs.auto !== 'boolean' || typeof prefs.critical !== 'boolean') invalid('scheduling preferences are missing.');
  const d = p.data;
  if (!object(d) || !Array.isArray(d.tasks) || !Array.isArray(d.links) || !Array.isArray(d.collapsed)) invalid('tasks, relationships or collapsed groups are missing.');
  const { ids, maxId, summaries } = validateTasks(d.tasks);
  if (doc.version < 3 && d.tasks.some((t) => t.scheduling != null)) invalid('explicit scheduling modes require file version 3.');
  if (doc.version >= 2 || d.calendar != null) {
    const reason = calendarError(d.calendar); if (reason) invalid(`calendar: ${reason}.`);
    if (doc.version === 1 && (d.calendar.workdays.length !== 7 || d.calendar.holidays.length)) invalid('a working calendar requires file version 2.');
    const work = new WorkingCalendar(d.calendar);
    if (d.tasks.some((t) => Math.abs(work.finish(t.start, t.dur)) > 99999999)) invalid('a task finish is outside the supported date range.');
  }
  const maxLink = validateLinks(d.links, ids, summaries);
  if (d.collapsed.some((id) => !ids.has(id)) || new Set(d.collapsed).size !== d.collapsed.length) invalid('collapsed groups refer to missing or repeated tasks.');
  if (!integer(d.nextId, maxId + 1) || !integer(d.nextLink, maxLink + 1)) invalid('the next task or relationship ID is invalid.');
  validateReminders(p.rem);
  return doc;
}

export function encodeProjectFile(store) {
  const data = JSON.parse(store.serialize());
  // Newly inserted tasks acquire their default reminder flag on the next model load.
  for (const task of data.tasks) task.noRem = !!task.noRem;
  let version = store.calendar.workdays.length === 7 && !store.calendar.holidays.length ? 1 : 2;
  if (data.tasks.some((t) => t.scheduling)) version = VERSION;
  const doc = validateDocument({
    format: FORMAT, version,
    project: { name: store.sheet().name, data, rem: cleanRem(store.sheet().rem) },
    preferences: { auto: store.readOnly ? false : store.auto, critical: store.critical },
  });
  const contents = JSON.stringify(doc, null, 2) + '\n';
  if (new TextEncoder().encode(contents).length > MAX_PROJECT_FILE_BYTES) throw new Error('Plan project files must be 64 MB or smaller.');
  return contents;
}

export function parseProjectFile(contents) {
  if (typeof contents !== 'string' || new TextEncoder().encode(contents).length > MAX_PROJECT_FILE_BYTES) throw new Error('Plan project files must be 64 MB or smaller.');
  let doc;
  try { doc = JSON.parse(contents.replace(/^\uFEFF/, '')); } catch { invalid('the file is not valid JSON or is incomplete.'); }
  validateDocument(doc);
  // Explicitly select portable fields; live sharing, mailbox IDs and credentials never transfer.
  return {
    name: doc.project.name, data: doc.project.data,
    rem: { ...cleanRem(doc.project.rem), on: false, auto: false },
    preferences: { auto: doc.preferences.auto, critical: doc.preferences.critical },
  };
}

export function openProjectFile(store, contents) {
  const validation = diagnostics.begin('file.open.validate');
  let project;
  try { project = parseProjectFile(contents); validation.end({ taskCount: project.data.tasks.length, linkCount: project.data.links.length }); }
  catch (error) { validation.fail(error); throw error; }
  if (store.stale) throw new Error('Reload this window before opening a project; the app changed in another window.');
  const apply = diagnostics.begin('file.open.apply');
  try {
    // Apply the saved scheduling mode before loading, so manually scheduled dates survive.
    store.auto = project.preferences.auto; store.critical = project.preferences.critical;
    const id = store.addSheet(project.data, project.name, { rem: project.rem });
    apply.end({ taskCount: store.tasks.length, linkCount: store.links.length }); return id;
  } catch (error) { apply.fail(error); throw error; }
}

export function projectFileName(name) {
  let base = String(name).replace(/\.plan$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'Project';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return base + PROJECT_FILE_EXTENSION;
}

export function createProjectFiles(ctx, browser = window) {
  const { store } = ctx, doc = browser.document;
  const openButton = doc.querySelector('#openprojectbtn'), saveButton = doc.querySelector('#saveprojectbtn');
  const normalSave = doc.querySelector('#savefilebtn'), bindings = createFileBindings(browser);
  let busy = false;
  const tokenFor = (sheet) => sheet.fileToken ||= (browser.crypto?.randomUUID?.() || `file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  async function connect(sheet, handle, contents) {
    await bindings.write(tokenFor(sheet), { handle, contents }); store.save(); paintSave();
  }
  const lock = (value) => { busy = value; openButton.disabled = value; saveButton.disabled = value; if (normalSave) normalSave.disabled = value; };
  const report = (action, e) => {
    diagnostics.record(`file.${action}.failure`, { error: e, cancelledOrAborted: e?.name === 'AbortError' }, e?.name === 'AbortError' ? 'warn' : 'error');
    if (e?.name !== 'AbortError') ctx.toast(`Could not ${action} project: ${e.message || e}`);
  };
  const canOpen = () => {
    if (!store.stale) return true;
    diagnostics.record('file.open.blocked', { reason: 'stale-window' }, 'warn');
    ctx.toast('Reload this window before opening a project; the app changed in another window.'); return false;
  };

  async function loadFile(file) {
    diagnostics.record('file.open.selected', { bytes: file.size, mimeType: file.type || '', extension: /\.plan$/i.test(file.name || '') ? '.plan' : 'other' });
    if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error('Plan project files must be 64 MB or smaller.');
    const contents = await diagnostics.trace('file.open.readText', () => file.text());
    const id = openProjectFile(store, contents);
    ctx.toast(`Opened “${store.sheet(id).name}” · reminders are off`);
    return { id, contents };
  }

  function fallbackOpen() {
    return new Promise((resolve, reject) => {
      const input = doc.createElement('input'); input.type = 'file'; input.accept = PROJECT_FILE_EXTENSION; input.hidden = true;
      const finish = (file) => { input.remove(); resolve(file); };
      input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true });
      input.addEventListener('cancel', () => finish(null), { once: true });
      doc.body.appendChild(input);
      try { input.click(); } catch (e) { input.remove(); reject(e); }
    });
  }

  async function open() {
    if (busy || !canOpen()) { diagnostics.record('file.open.ignored', { busy }); return; }
    const operation = diagnostics.begin('file.open');
    lock(true);
    try {
      let file, handle;
      if (typeof browser.showOpenFilePicker === 'function') {
        [handle] = await diagnostics.trace('file.open.picker', () => browser.showOpenFilePicker({ id: 'plan-projects', types: TYPES, multiple: false }), { kind: 'native' });
        file = await diagnostics.trace('file.open.getFile', () => handle.getFile());
      } else file = await diagnostics.trace('file.open.picker', fallbackOpen, { kind: 'input' });
      if (file) { const { id, contents } = await loadFile(file); if (handle) await diagnostics.trace('file.open.connect', () => connect(store.sheet(id), handle, contents)); }
      operation.end({ cancelled: !file });
    } catch (e) { operation.fail(e); report('open', e); }
    finally { lock(false); diagnostics.record('file.open.controlsUnlocked'); }
  }

  async function writeProject(asNew = false) {
    if (busy) { diagnostics.record('file.save.ignored', { busy }); return; }
    const operation = diagnostics.begin('file.save', { asNew });
    lock(true); let writable = null, closing = false;
    try {
      // Snapshot before awaiting the dialog: a later tab switch must not change what is saved.
      const encode = diagnostics.begin('file.save.encode');
      let contents;
      const sheet = store.sheet(), name = projectFileName(sheet.name);
      try { contents = encodeProjectFile(store); encode.end({ characters: contents.length }); }
      catch (error) { encode.fail(error); throw error; }
      let record = !asNew && sheet.fileToken ? await bindings.read(sheet.fileToken) : null;
      // Stale/read-only windows may export a copy, but must not replace a connected file.
      if (record && (store.stale || sheet.readOnly)) throw new Error('Use Save As to save a copy from this read-only or outdated window.');
      if (record) {
        const { handle } = record;
        if (handle.queryPermission && await diagnostics.trace('file.save.queryPermission', () => handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          if (!handle.requestPermission || await diagnostics.trace('file.save.requestPermission', () => handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('File access denied. Allow access or use Save As.');
        }
        const current = await diagnostics.trace('file.save.checkExternalChanges', async () => (await handle.getFile()).text());
        if (current !== record.contents && current !== record.pending) throw new Error('This file changed outside Plan. Open it to review the changes, or use Save As for a separate copy.');
      }
      if (record || typeof browser.showSaveFilePicker === 'function') {
        const handle = record?.handle || await diagnostics.trace('file.save.picker', () => browser.showSaveFilePicker({ id: 'plan-projects', suggestedName: name, types: TYPES }));
        // Remember the attempted snapshot if close loses its acknowledgement. Next Save first
        // reconciles the actual file with either the last confirmed or attempted contents.
        if (record) await bindings.write(sheet.fileToken, { ...record, pending: contents });
        if (record && (store.stale || sheet.readOnly)) throw new Error('The project changed in another window. Reload, or use Save As for a copy.');
        writable = await diagnostics.trace('file.save.createWritable', () => handle.createWritable());
        await diagnostics.trace('file.save.write', () => writable.write(contents)); closing = true;
        await diagnostics.trace('file.save.close', () => writable.close()); writable = null;
        await diagnostics.trace('file.save.connect', () => connect(sheet, handle, contents));
        ctx.toast(`Saved ${handle.name || name}`);
      } else {
        const url = browser.URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
        const a = doc.createElement('a'); a.href = url; a.download = name; doc.body.appendChild(a);
        try { a.click(); } finally { a.remove(); browser.setTimeout(() => browser.URL.revokeObjectURL(url), 4000); }
        ctx.toast(`Download started: ${name}`);
      }
      operation.end();
    } catch (e) {
      operation.fail(e);
      if (writable) { try { await writable.abort(); } catch { /* the browser may have already closed the stream */ } }
      if (closing) ctx.toast('Could not confirm the project save. Check the selected file before trying again.');
      else report('save', e);
    } finally { lock(false); diagnostics.record('file.save.controlsUnlocked'); }
  }

  function paintSave() {
    if (!normalSave) return;
    normalSave.querySelector('.tool-label').textContent = store.sheet().fileToken ? 'Save' : 'Save…';
    normalSave.title = store.sheet().fileToken ? 'Save changes to the connected .plan file (Ctrl/⌘+S)' : 'Choose a .plan file for this project (Ctrl/⌘+S)';
  }
  store.on(paintSave); paintSave();
  const save = () => writeProject(false), saveAs = () => writeProject(true);
  openButton.addEventListener('click', open);
  normalSave?.addEventListener('click', save);
  saveButton.addEventListener('click', saveAs);
  doc.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !['o', 's'].includes(e.key.toLowerCase())) return;
    e.preventDefault();
    if (doc.querySelector('.modal-back, #diagnostics-dialog[open]') || store._orig) return;
    e.stopPropagation();
    // Commit an in-progress grid/formula edit before capturing the project.
    doc.activeElement?.blur();
    if (e.key.toLowerCase() === 'o') void open(); else if (e.shiftKey) void saveAs(); else void save();
  }, true);
  return { open, save, saveAs };
}
