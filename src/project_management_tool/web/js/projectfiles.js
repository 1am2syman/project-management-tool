import { diagnostics } from './diagnosticlog.js';
import { cleanRem, cleanVersions, isEmail, LINK_TYPES, MAX_VERSIONS } from './model.js';
import { createFileBindings } from './filebindings.js';
import { openLocalFiles } from './localfiles.js';
import { calendarError, WorkingCalendar } from './calendar.js';

export const PROJECT_FILE_EXTENSION = '.plan';
export const MAX_PROJECT_FILE_BYTES = 64 * 1024 * 1024;
const FORMAT = 'plan-project', VERSION = 5;
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

// Tasks, relationships and calendar of the live plan or of a saved version.
function validatePlan(d, fileVersion, where = '') {
  if (!object(d) || !Array.isArray(d.tasks) || !Array.isArray(d.links)) invalid(`${where}tasks or relationships are missing.`);
  const { ids, maxId, summaries } = validateTasks(d.tasks);
  for (const t of d.tasks) if (t.calendar != null) {
    if (fileVersion < 5) invalid(`${where}task calendars require file version 5.`);
    const reason = calendarError(t.calendar);
    if (reason || summaries.has(t.id)) invalid(`${where}task ${t.id} calendar: ${reason || 'summary rows cannot have calendars'}.`);
  }
  if (fileVersion < 3 && d.tasks.some((t) => t.scheduling != null)) invalid('explicit scheduling modes require file version 3.');
  if (fileVersion >= 2 || d.calendar != null) {
    const reason = calendarError(d.calendar); if (reason) invalid(`${where}calendar: ${reason}.`);
    if (fileVersion === 1 && (d.calendar.workdays.length !== 7 || d.calendar.holidays.length)) invalid('a working calendar requires file version 2.');
    const work = new WorkingCalendar(d.calendar);
    if (d.tasks.some((t) => Math.abs((t.calendar ? new WorkingCalendar(t.calendar) : work).finish(t.start, t.dur)) > 99999999)) invalid(`${where}a task finish is outside the supported date range.`);
  }
  const maxLink = validateLinks(d.links, ids, summaries);
  if (!integer(d.nextId, maxId + 1) || !integer(d.nextLink, maxLink + 1)) invalid(`${where}the next task or relationship ID is invalid.`);
  return ids;
}

function validateVersions(list, nextVersion, fileVersion) {
  if (!Array.isArray(list) || list.length > MAX_VERSIONS) invalid(`saved versions must be a list of at most ${MAX_VERSIONS}.`);
  const numbers = new Set();
  for (const v of list) {
    if (!object(v) || !integer(v.n, 1) || numbers.has(v.n)) invalid('saved version numbers must be unique positive integers.');
    const where = `version ${v.n}: `;
    if (!text(v.name, 80) || !v.name.trim() || !text(v.note, 1000) || !text(v.by, 120)) invalid(`${where}name, note or author is invalid.`);
    if (typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at)) || typeof v.auto !== 'boolean' || !(v.target === null || integer(v.target, 1))) invalid(`${where}date, scheduling or critical-path target is invalid.`);
    validatePlan(v.plan, fileVersion, where);
    numbers.add(v.n);
  }
  if (!integer(nextVersion, Math.max(0, ...numbers) + 1)) invalid('the next version number is invalid.');
}

// Validate before the model's forgiving storage sanitizer can discard or repair file contents.
function validateDocument(doc) {
  if (!object(doc) || doc.format !== FORMAT) invalid('choose a .plan file saved by Plan.');
  if (![1, 2, 3, 4, VERSION].includes(doc.version)) invalid(`file version ${doc.version} is not supported. Update Plan to open this file.`);
  const p = doc.project, prefs = doc.preferences;
  if (!object(p) || !text(p.name, 60) || !p.name.trim()) invalid('the project name is missing or too long.');
  if (!object(prefs) || typeof prefs.auto !== 'boolean' || typeof prefs.critical !== 'boolean') invalid('scheduling preferences are missing.');
  const d = p.data;
  if (!object(d) || !Array.isArray(d.tasks) || !Array.isArray(d.links) || !Array.isArray(d.collapsed)) invalid('tasks, relationships or collapsed groups are missing.');
  const ids = validatePlan(d, doc.version);
  if (d.collapsed.some((id) => !ids.has(id)) || new Set(d.collapsed).size !== d.collapsed.length) invalid('collapsed groups refer to missing or repeated tasks.');
  validateReminders(p.rem);
  if (p.versions !== undefined || p.nextVersion !== undefined) {
    if (doc.version < 4) invalid('saved versions require file version 4.');
    validateVersions(p.versions, p.nextVersion, doc.version);
  }
  return doc;
}

// Plans carry reminder opt-outs as explicit booleans; newly inserted tasks acquire theirs on the next model load.
function portablePlan(data) {
  delete data.collapsed;
  for (const task of data.tasks) task.noRem = !!task.noRem;
  return data;
}

export function encodeProjectFile(store) {
  const sheet = store.sheet();
  // While a saved version is on screen, the loaded tasks are that version; the file holds the live plan.
  const data = JSON.parse(store.preview ? JSON.stringify(sheet.data) : store.serialize());
  for (const task of data.tasks) task.noRem = !!task.noRem;
  data.collapsed ??= [];
  const versions = store.versions(), calendar = data.calendar || { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] };
  let version = calendar.workdays.length === 7 && !calendar.holidays.length ? 1 : 2;
  if (data.tasks.some((t) => t.scheduling)) version = 3;
  if (versions.length) version = 4;
  if (data.tasks.some((t) => t.calendar) || versions.some((v) => JSON.parse(v.data).tasks.some((t) => t.calendar))) version = VERSION;
  const project = { name: sheet.name, data, rem: cleanRem(sheet.rem) };
  if (versions.length) {
    project.versions = versions.map((v) => ({ n: v.n, name: v.name, note: v.note, at: new Date(v.at || 0).toISOString(), by: v.by, auto: v.auto, target: v.target, plan: portablePlan(JSON.parse(v.data)) }));
    project.nextVersion = Math.max(sheet.nextVersion || 1, versions.at(-1).n + 1);
  }
  const doc = validateDocument({
    format: FORMAT, version, project,
    preferences: { auto: sheet.readOnly ? false : store.auto, critical: store.critical },
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
    versions: cleanVersions((doc.project.versions || []).map((v) => ({ ...v, at: Date.parse(v.at), data: JSON.stringify(v.plan) }))),
    nextVersion: doc.project.nextVersion,
  };
}

export function openProjectFile(store, contents, options = {}) {
  const validation = diagnostics.begin('file.open.validate');
  let project;
  try { project = parseProjectFile(contents); validation.end({ taskCount: project.data.tasks.length, linkCount: project.data.links.length }); }
  catch (error) { validation.fail(error); throw error; }
  if (store.stale) throw new Error('Reload this window before opening a project; the app changed in another window.');
  const apply = diagnostics.begin('file.open.apply');
  try {
    // Apply the saved scheduling mode before loading, so manually scheduled dates survive.
    store.auto = project.preferences.auto; store.critical = project.preferences.critical;
    const extra = { rem: project.rem, ...(options.fileToken ? { fileToken: options.fileToken } : {}), ...(project.versions.length ? { versions: project.versions, nextVersion: project.nextVersion } : {}) };
    const id = store.addSheet(project.data, project.name, extra);
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
  // Capability errors remain errors: falling back after an uncertain native request
  // could cause a second picker or write.
  let backendPromise;
  const localBackend = () => {
    if (!ctx.storage) return Promise.resolve(null);
    if (!backendPromise) backendPromise = openLocalFiles(browser).catch(error => { backendPromise = null; throw error; });
    return backendPromise;
  };
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
  const localError = result => ({
    busy: 'Another file chooser is already open.',
    not_found: 'The selected file no longer exists.', invalid_utf8: 'The selected file is not valid UTF-8.',
    too_large: 'Plan project files must be 64 MB or smaller.', external_change: 'The file changed outside Plan.',
    chooser_interrupted: 'The file chooser was interrupted when the server stopped.',
    not_committed: 'The previous write did not complete.',
    file_in_use: 'The file is open in another program. Close it and try again.',
    permission_denied: 'Cannot access this file. It may be read-only or open in another program. Close it there, check permissions, or use Save As.',
  }[result.error] || 'The local file operation could not be completed.');
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
    ctx.toast(`Opened “${store.sheet(id).name}”`);
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

  // A terminal rejection wrote no bytes: release the selection so a new Open or Save can start.
  async function settleRejected(native, id, result, message) {
    if (['conflict', 'failed', 'cancelled', 'released'].includes(result.stage)) {
      try { await native.release(id); } catch { /* terminal stages need no release */ }
      native.clear();
      throw new Error(localError(result));
    }
    throw new Error(message);
  }

  // A terminal attach rejection keeps the imported or saved contents but drops the unconfirmed binding,
  // so the project does not claim a connection it does not have.
  function dropUnconfirmed(sheet) { delete sheet.fileToken; store.save(); }

  // A refused commit or attach can be this window's own autosave, which moves the workspace revision between
  // the barrier and the server check. Such a refusal retries on the newest revision. The retry count is bounded,
  // so a continuous typist cannot loop forever.
  const OWN_REVISION_RETRIES = 2;

  // Who moved the revision a refusal names? 'own' when this window wrote it, 'outside' when another window did,
  // 'unknown' when the server cannot be asked.
  async function revisionOrigin() {
    const current = await ctx.storage.currentRevision().catch(() => null);
    if (current === null) return 'unknown';
    return (await ctx.storage.ownsRevision(current)) ? 'own' : 'outside';
  }

  // A definitive refusal wrote no bytes: release the selection so a new Open or Save can start.
  // If release fails, the pending selection stays so the next Open or Save can release it.
  async function releaseRefused(native, id) {
    try { await native.release(id); native.clear(); }
    catch { /* keep the pending selection for recovery */ }
  }

  // Commits the staged snapshot. Only a 409 is a definitive refusal; any other failure keeps the selection for
  // recovery because the write may have happened. A revision-only refusal caused by this window's own autosave
  // retries the same selection on the newest barrier revision. Any other refusal releases the selection.
  async function commitFile(native, id, revision, { retryOwn = true } = {}) {
    let current = revision;
    for (let attempt = 0; ; attempt += 1) {
      try { return await native.write(id, current); }
      catch (error) {
        if (error.status !== 409) throw error;
        const origin = error.reason === 'revision' && retryOwn ? await revisionOrigin() : 'unchecked';
        if (origin === 'own' && attempt < OWN_REVISION_RETRIES) {
          try { current = await ctx.storage.barrier(); continue; }
          catch (barrierError) { await releaseRefused(native, id); throw barrierError; }
        }
        if (origin === 'outside') ctx.storage.markStale();
        await releaseRefused(native, id);
        throw new Error(origin === 'own' ? 'The project kept changing while it was being saved. Try saving again.'
          : origin === 'outside' ? 'The project changed in another window. Reload before saving, or use Save As.'
          : 'The project or file changed before saving. Reload before saving, or use Save As.');
      }
    }
  }

  // Attaches a sheet to a written or opened file. A revision-only refusal from this window's own autosave retries
  // on the newest revision. A final refusal is rethrown: the caller decides what it means for the connection.
  async function attachFile(native, id, sheetId, revision) {
    let current = revision;
    for (let attempt = 0; ; attempt += 1) {
      try { return await native.attach(id, sheetId, current); }
      catch (error) {
        const origin = error.status === 409 && error.reason === 'revision' ? await revisionOrigin() : 'unchecked';
        if (origin === 'own' && attempt < OWN_REVISION_RETRIES) { current = await ctx.storage.barrier(); continue; }
        if (origin === 'outside') ctx.storage.markStale();
        throw error;
      }
    }
  }

  async function recoverPending(native) {
    const pending = native.pending();
    if (!pending) return;
    let result;
    try { result = await native.wait(pending.id); }
    catch (error) {
      if (error.status !== 404) throw error;
      if (pending.phase !== 'starting' || !pending.start) {
        native.clear(); ctx.toast('The previous file operation is no longer available. Please try again.'); return;
      }
      await native.resumeStart(pending.start);
      result = await native.wait(pending.id);
    }
    if (result.stage === 'choosing' || result.stage === 'writing') throw new Error('A previous file operation is still in progress.');
    if (result.kind === 'open' && result.stage === 'succeeded') {
      native.clear(); ctx.toast('Confirmed the previous project connection'); return;
    }
    if (result.kind === 'open' && result.stage === 'ready') {
      let sheet = (pending.sheet && store.sheet(pending.sheet)) || store.wb.sheets.find(item => item.fileToken === result.token);
      if (!sheet) {
        const contents = await native.content(pending.id);
        let sheetId;
        try { sheetId = openProjectFile(store, contents, { fileToken: result.token }); }
        catch (error) {
          try { await native.release(pending.id); native.clear(); } catch { /* retain recovery evidence */ }
          throw error;
        }
        native.remember({ sheet: sheetId, phase: 'attaching' });
        sheet = store.sheet(sheetId);
      }
      sheet.fileToken = result.token; store.save();
      const revision = await ctx.storage.barrier();
      try { await attachFile(native, pending.id, sheet.id, revision); }
      catch (error) {
        if (error.status !== 409 && error.status !== 404) throw error;
        dropUnconfirmed(sheet); native.clear(); ctx.toast('Project opened, but its file connection could not be confirmed. Use Save As to reconnect.'); return;
      }
      native.clear(); ctx.toast(`Opened “${sheet.name}” · reminders are off`);
      return;
    }
    if (result.kind === 'save_as' && result.stage === 'succeeded' && pending.copyOnly) {
      native.clear(); ctx.toast('Confirmed the previous project copy was saved'); return;
    }
    if (result.kind === 'save_as' && result.stage === 'succeeded') {
      const sheet = pending.sheet && store.sheet(pending.sheet);
      if (!sheet) { native.clear(); ctx.toast('The file was saved, but its project no longer exists.'); return; }
      sheet.fileToken = result.token; store.save();
      const revision = await ctx.storage.barrier();
      try { await attachFile(native, pending.id, sheet.id, revision); }
      catch (error) {
        if (error.status !== 409 && error.status !== 404) throw error;
        dropUnconfirmed(sheet); native.clear(); ctx.toast('The file was saved, but its connection could not be confirmed. Use Save As to reconnect.'); return;
      }
      native.clear(); ctx.toast('Saved project file and restored its connection'); return;
    }
    if (result.stage === 'ready' && result.hasSnapshot) {
      const revision = pending.copyOnly ? await ctx.storage.currentRevision() : await ctx.storage.barrier();
      const committed = await commitFile(native, pending.id, revision, { retryOwn: !pending.copyOnly });
      if (committed.stage !== 'succeeded') await settleRejected(native, pending.id, committed, 'The previous project save could not be confirmed.');
      await recoverPending(native); return;
    }
    if (result.stage === 'ready') await native.release(pending.id);
    native.clear();
    if (result.stage === 'succeeded') ctx.toast('Confirmed the previous project save');
    else if (result.stage !== 'cancelled') ctx.toast('The previous file operation did not complete.');
  }

  async function open() {
    if (busy || !canOpen()) { diagnostics.record('file.open.ignored', { busy }); return; }
    const operation = diagnostics.begin('file.open');
    lock(true);
    try {
      const native = await localBackend();
      if (native) {
        if (native.pending()) { await recoverPending(native); operation.end(); return; }
        const id = native.newId();
        let selected;
        try {
          await native.start({ id, kind: 'open' });
          selected = await native.wait(id);
          if (selected.stage === 'cancelled') { native.clear(); operation.end({ cancelled: true }); return; }
          if (selected.stage !== 'ready') throw new Error(localError(selected));
          const contents = await native.content(id);
          const sheetId = openProjectFile(store, contents, { fileToken: selected.token });
          native.remember({ sheet: sheetId, phase: 'attaching' });
          const sheet = store.sheet(sheetId);
          sheet.fileToken = selected.token; store.save();
          const revision = await ctx.storage.barrier();
          try { await attachFile(native, id, sheetId, revision); }
          catch (error) {
            if (error.status === 409 || error.status === 404) {
              dropUnconfirmed(sheet); native.clear(); ctx.toast('Project opened, but its file connection could not be confirmed. Use Save As to reconnect.');
              operation.end(); return;
            }
            ctx.toast('Project opened, but its file connection could not be confirmed. Use Save As to reconnect.'); throw error;
          }
          native.clear();
          ctx.toast(`Opened “${sheet.name}” · reminders are off`);
          operation.end({ cancelled: false }); return;
        } catch (error) {
          if (selected?.stage === 'ready' && !native.pending()?.sheet) {
            try { await native.release(id); native.clear(); } catch { /* retain recovery evidence */ }
          }
          throw error;
        }
      }
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
      const native = await localBackend();
      if (native) {
        if (native.pending()) { await recoverPending(native); operation.end(); return; }
        if (store.stale && !asNew) throw new Error('Use Save As to save a copy from this outdated window.');
        const exportingStale = store.stale && asNew;
        const revision = exportingStale ? await ctx.storage.currentRevision() : await ctx.storage.barrier();
        const sourceToken = sheet.fileToken || null;
        const connected = typeof sourceToken === 'string' && sourceToken.startsWith('local-') && await native.connected(sheet.id, sourceToken);
        if (sourceToken && !connected && !browser.sessionStorage.getItem('plan-file-reconnect-notice')) {
          browser.sessionStorage.setItem('plan-file-reconnect-notice', '1');
          ctx.toast('This project needs Open or Save As to reconnect its file.');
        }
        if (!asNew && connected && (store.stale || sheet.readOnly)) throw new Error('Use Save As to save a copy from this read-only or outdated window.');
        const id = native.newId();
        const kind = !asNew && connected ? 'save' : 'save_as';
        await native.start({ id, kind, sheet: sheet.id, token: sourceToken, revision, suggestedName: name, copyOnly: exportingStale });
        await native.stage(id, contents);
        const selected = await native.wait(id);
        if (selected.stage === 'cancelled') { native.clear(); operation.end({ cancelled: true }); return; }
        if (selected.stage !== 'ready') throw new Error(localError(selected));
        const currentRevision = exportingStale ? await ctx.storage.currentRevision() : await ctx.storage.barrier();
        if ((!exportingStale && store.stale) || (!asNew && connected && sheet.readOnly)) {
          await native.release(id); native.clear(); throw new Error('The project changed while selecting a file. Try again.');
        }
        const result = await commitFile(native, id, currentRevision, { retryOwn: !exportingStale });
        if (result.stage !== 'succeeded') await settleRejected(native, id, result, 'The project could not be saved. Check the selected file before trying again.');
        if (kind === 'save_as' && !exportingStale) {
          sheet.fileToken = result.token; store.save();
          const attachedRevision = await ctx.storage.barrier();
          try { await attachFile(native, id, sheet.id, attachedRevision); }
          catch (error) {
            if (error.status !== 409 && error.status !== 404) throw error;
            dropUnconfirmed(sheet); native.clear(); ctx.toast('The file was saved, but its connection could not be confirmed. Use Save As to reconnect.');
            operation.end(); return;
          }
        }
        native.clear(); ctx.toast('Saved project file'); operation.end(); return;
      }
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

  let paintSequence = 0;
  async function paintSave() {
    if (!normalSave) return;
    const sheet = store.sheet(), sequence = ++paintSequence;
    let connected = !!sheet.fileToken;
    try {
      const native = await localBackend();
      if (native) connected = typeof sheet.fileToken === 'string' && sheet.fileToken.startsWith('local-') && await native.connected(sheet.id, sheet.fileToken);
    } catch { connected = false; }
    if (sequence !== paintSequence || store.sheet() !== sheet) return;
    normalSave.querySelector('.tool-label').textContent = connected ? 'Save' : 'Save…';
    normalSave.title = connected ? 'Save changes to the connected .plan file (Ctrl/⌘+S)' : 'Choose a .plan file for this project (Ctrl/⌘+S)';
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
