import { cleanRem, isEmail, LINK_TYPES } from './model.js';

export const PROJECT_FILE_EXTENSION = '.plan';
export const MAX_PROJECT_FILE_BYTES = 64 * 1024 * 1024;
const FORMAT = 'plan-project', VERSION = 1;
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
  if (doc.version !== VERSION) invalid(`file version ${doc.version} is not supported. Update Plan to open this file.`);
  const p = doc.project, prefs = doc.preferences;
  if (!object(p) || !text(p.name, 60) || !p.name.trim()) invalid('the project name is missing or too long.');
  if (!object(prefs) || typeof prefs.auto !== 'boolean' || typeof prefs.critical !== 'boolean') invalid('scheduling preferences are missing.');
  const d = p.data;
  if (!object(d) || !Array.isArray(d.tasks) || !Array.isArray(d.links) || !Array.isArray(d.collapsed)) invalid('tasks, relationships or collapsed groups are missing.');
  const { ids, maxId, summaries } = validateTasks(d.tasks);
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
  const doc = validateDocument({
    format: FORMAT, version: VERSION,
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
  const project = parseProjectFile(contents);
  if (store.stale) throw new Error('Reload this window before opening a project; the app changed in another window.');
  // Apply the saved scheduling mode before loading, so manually scheduled dates survive.
  store.auto = project.preferences.auto; store.critical = project.preferences.critical;
  return store.addSheet(project.data, project.name, { rem: project.rem });
}

export function projectFileName(name) {
  let base = String(name).replace(/\.plan$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'Project';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return base + PROJECT_FILE_EXTENSION;
}

export function createProjectFiles(ctx, browser = window) {
  const { store } = ctx, doc = browser.document;
  const openButton = doc.querySelector('#openprojectbtn'), saveButton = doc.querySelector('#saveprojectbtn');
  let busy = false;
  const lock = (value) => { busy = value; openButton.disabled = value; saveButton.disabled = value; };
  const report = (action, e) => { if (e?.name !== 'AbortError') ctx.toast(`Could not ${action} project: ${e.message || e}`); };
  const canOpen = () => {
    if (!store.stale) return true;
    ctx.toast('Reload this window before opening a project; the app changed in another window.'); return false;
  };

  async function loadFile(file) {
    if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error('Plan project files must be 64 MB or smaller.');
    const id = openProjectFile(store, await file.text());
    ctx.toast(`Opened “${store.sheet(id).name}” · reminders are off`);
    return id;
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
    if (busy || !canOpen()) return;
    lock(true);
    try {
      let file;
      if (typeof browser.showOpenFilePicker === 'function') {
        const [handle] = await browser.showOpenFilePicker({ id: 'plan-projects', types: TYPES, multiple: false });
        file = await handle.getFile();
      } else file = await fallbackOpen();
      if (file) await loadFile(file);
    } catch (e) { report('open', e); }
    finally { lock(false); }
  }

  async function saveAs() {
    if (busy) return;
    lock(true); let writable = null, closing = false;
    try {
      // Snapshot before awaiting the dialog: a later tab switch must not change what is saved.
      const contents = encodeProjectFile(store), name = projectFileName(store.sheet().name);
      if (typeof browser.showSaveFilePicker === 'function') {
        const handle = await browser.showSaveFilePicker({ id: 'plan-projects', suggestedName: name, types: TYPES });
        writable = await handle.createWritable();
        await writable.write(contents); closing = true;
        await writable.close(); writable = null;
        ctx.toast(`Saved ${handle.name || name}`);
      } else {
        const url = browser.URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
        const a = doc.createElement('a'); a.href = url; a.download = name; doc.body.appendChild(a);
        try { a.click(); } finally { a.remove(); browser.setTimeout(() => browser.URL.revokeObjectURL(url), 4000); }
        ctx.toast(`Download started: ${name}`);
      }
    } catch (e) {
      if (writable) { try { await writable.abort(); } catch { /* the browser may have already closed the stream */ } }
      if (closing) ctx.toast('Could not confirm the project save. Check the selected file before trying again.');
      else report('save', e);
    } finally { lock(false); }
  }

  openButton.addEventListener('click', open);
  saveButton.addEventListener('click', saveAs);
  doc.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !['o', 's'].includes(e.key.toLowerCase())) return;
    e.preventDefault();
    if (doc.querySelector('.modal-back') || store._orig) return;
    e.stopPropagation();
    // Commit an in-progress grid/formula edit before capturing the project.
    doc.activeElement?.blur();
    if (e.key.toLowerCase() === 'o') void open(); else void saveAs();
  }, true);
  return { open, saveAs };
}
