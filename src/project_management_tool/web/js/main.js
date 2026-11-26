import { diagnostics } from './diagnosticlog.js';
import { Store, fmtDate, PREVIEW_LOCK } from './model.js';
import { appState } from './appstate.js';
import { openProjectStorage } from './storage.js';
import { createHistory } from './history.js';
import { createGrid, COLS } from './grid.js';
import { createTaskUI } from './taskui.js';
import { createTaskDialog } from './taskdialog.js';
import { createCalendarUI } from './calendarui.js';
import { createCriticalUI } from './criticalui.js';
import { createSlackUI } from './slackui.js';
import { createGantt } from './gantt.js';
import { createRelationshipEditor } from './relationships.js';
import { esc, setHTML } from './dom.js';
import { createSheets } from './sheets.js';
import { createExport } from './export.js';
import { createImport } from './import.js';
import { createProjectFiles } from './projectfiles.js';
import { createPeople } from './people.js';
import { createVersionsUI } from './versionsui.js';
import { createDelayUI } from './delayui.js';
import { createAnalysis } from './analysis.js';
import { initDensity, setDensity, fitDensity, dims } from './dims.js';

const $ = (s) => document.querySelector(s);
diagnostics.record('app.start');
const storage = await openProjectStorage();
initDensity();
const committedStore = new Store(storage.initial, { disk: storage.mode() === 'disk' });
await storage.attach(committedStore);
const store = committedStore.presentation || committedStore;
globalThis.PlanDiagnostics?.setStoreSummary(() => {
  const cal = store.calendar, crit = store.criticalOptions();
  const customGlobalCalendar = (cal?.workdays?.length ?? 7) !== 7 || (cal?.holidays?.length ?? 0) > 0;
  return {
    sheetCount: store.wb.sheets.length,
    taskCount: store.tasks.length,
    linkCount: store.links.length,
    readOnly: store.readOnly,
    stale: !!store.stale,
    autoSchedule: store.auto,
    connectedFile: !!store.sheet().fileToken,
    undoCount: store.undoStack.length,
    redoCount: store.redoStack.length,
    saveStatus: $('#save-status').dataset.state,
    storageMode: storage.mode?.() || 'unknown',
    templateCount: store.templates.length,
    versionCount: store.versions().length,
    previewingVersion: !!store.preview,
    criticalMode: store.criticalMode(),
    criticalMethod: crit.method,
    criticalThreshold: crit.threshold,
    hasCriticalTarget: !!store.criticalTarget(),
    slackMode: ui.slackMode || 'selected',
    density: dims.name,
    focus: !!ui.focus,
    fitMode: !!gantt?.isFit?.(),
    customGlobalCalendar,
    holidayCount: cal?.holidays?.length || 0,
    taskCalendarCount: store.tasks.filter((t) => !!t.calendar).length,
    baselined: !!store.baselined,
    agreedTaskCount: store.tasks.filter((t) => !!t.agr).length,
    pendingInclusionCount: store.tasks.filter((t) => !!t.inc).length,
    delayLogCount: store.log?.length || 0,
    starredMilestoneCount: store.stars?.size || 0,
    violatedLinkCount: store.links.filter((l) => l.violated).length,
    linkConflictCount: store.linkConflicts().length,
    actualsTaskCount: store.tasks.filter((t) => t.actualStart != null || t.actualEnd != null).length,
    notesTaskCount: store.tasks.filter((t) => !!t.notes).length,
    analysisOpen: !!ctx?.analysis?.isOpen?.(),
    taskDialogOpen: !!ctx?.taskDialog?.isOpen?.(),
  };
});
diagnostics.record('app.modelReady', { sheetCount: store.wb.sheets.length, taskCount: store.tasks.length });
let focusOn = true; try { focusOn = appState.getItem('pm-focus') !== '0'; } catch {}
const ui = { selId: null, col: 'name', linkId: null, focus: focusOn };
const acceptedLayout = Object.fromEntries(['pm-focus', 'pm-density', 'pm-gridw'].map(key => [key, appState.getItem(key)]));
function syncAcceptedLayout() {
  if (store.pending || store.suspended) return;
  for (const key of Object.keys(acceptedLayout)) {
    const value = appState.getItem(key);
    if (value === acceptedLayout[key]) continue;
    acceptedLayout[key] = value;
    if (key === 'pm-focus') { ui.focus = value !== '0'; $('#optFocus').checked = ui.focus; }
    else if (key === 'pm-density') setDensity(value || 'auto', { persist: false });
    else {
      const width = Number(value);
      if (Number.isFinite(width) && width > 0) document.documentElement.style.setProperty('--gridw', `${Math.max(320, Math.min(innerWidth - 320, width))}px`);
    }
  }
}
let selectionTimer = 0, queuedSelection = null;
function readSelections() {
  try { const value = JSON.parse(appState.getItem('pm-selection') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function flushSelection() {
  clearTimeout(selectionTimer); selectionTimer = 0;
  if (!queuedSelection) return;
  const { id, value } = queuedSelection; queuedSelection = null;
  if (!store.sheet(id)) return;
  const selections = readSelections(), prev = selections[id];
  if (prev && prev.selId === value.selId && prev.linkId === value.linkId && prev.col === value.col) return;
  selections[id] = value;
  appState.setItem('pm-selection', JSON.stringify(selections));
}
function restoreSelection() {
  flushSelection();
  const current = readSelections()[store.wb.active] || {};
  ui.selId = current.selId ?? null; ui.linkId = current.linkId ?? null;
  ui.col = COLS.some((col) => col.id === current.col) ? current.col : 'name';
}
function rememberSelection() {
  queuedSelection = { id: store.wb.active, value: { selId: ui.selId, linkId: ui.linkId, col: ui.col } };
  clearTimeout(selectionTimer); selectionTimer = setTimeout(flushSelection, 250);
}
window.addEventListener('pm-flush-view', flushSelection);
restoreSelection();
let raf = 0, toastT = 0, grid, gantt, sheets;

const ctx = {
  store, ui, storage,
  rel: null, critOnly: false, critKeep: null,
  // css classes for a task row/bar given the current selection (focus mode or critical-path-only mode)
  relClass(id) {
    if (this.critOnly) {
      if (!this.critKeep.has(id)) return ' dim';
      return id === ui.selId ? ' r-self' : '';
    }
    const r = this.rel; if (!r) return '';
    if (id === ui.selId) return ' r-self';
    return r.anc.has(id) ? ' r-anc' : r.desc.has(id) ? ' r-desc' : r.up.has(id) ? ' r-up' : r.down.has(id) ? ' r-down' : ' dim';
  },
  requestRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); },
  select(id, col, reveal) {
    ui.selId = id; ui.linkId = null; if (col) ui.col = col;
    gantt.closePop(); grid.invalidateHead(); renderAll();
    if (reveal && id != null) { gantt.reveal(id, true); grid.scrollIntoView(); }
    rememberSelection();
  },
  selectLink(id) { ui.linkId = id; ui.selId = null; renderAll(); rememberSelection(); },
  toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); },
  syncGantt(v) { const gb = $('#gb'); if (gb.scrollTop !== v) gb.scrollTop = v; },
  syncV(v) { grid.setScrollTop(v); },
};
ctx.relationships = createRelationshipEditor(ctx);
grid = createGrid(ctx);
gantt = createGantt(ctx);
sheets = createSheets(ctx);
createExport(ctx);
ctx.files = createProjectFiles(ctx);
createImport(ctx);
createHistory();
ctx.people = createPeople(ctx);
ctx.delay = createDelayUI(ctx);
const banner = $('#robanner');
banner.addEventListener('click', async (event) => {
  if (event.target.closest('#roCopy')) {
    try { await store.duplicateSheet(store.wb.active); ctx.toast('Editable local copy created'); }
    catch (error) { ctx.toast(error.message); }
  }
});
function paintReadOnly() {
  const readOnly = store.readOnly;
  $('#app').classList.toggle('ro', readOnly);
  banner.hidden = !readOnly;
  if (readOnly) setHTML(banner, store.locked ? '<span class="lock">Read-only tab</span><span>Close the editing tab, then reload to edit fresh data.</span>' : '<span class="lock">Read-only local snapshot</span><span>Create a local copy to edit this older project.</span><span style="flex:1"></span><button id="roCopy">Make editable copy</button>');
}
const criticalUI = createCriticalUI(ctx, grid);
ctx.slack = createSlackUI(ctx, grid);
ctx.analysis = createAnalysis(ctx);
ctx.versions = createVersionsUI(ctx);

function status() {
  const target = store.criticalTarget();
  const leaves = store.tasks.filter((t) => !store.info.get(t.id).summary), ms = leaves.filter((t) => t.ms).length, P = store.project;
  const viol = store.links.filter((l) => l.violated).length;
  setHTML($('#stat'), `<span><b>${leaves.length - ms}</b> tasks · <b>${ms}</b> milestones · <b>${store.links.length}</b> links</span>` +
    `<span>Finish <b>${fmtDate(P.end - 1)}</b> · <b>${P.end - P.start}</b> days</span>` + ctx.delay.statusHtml() +
    `<span class="cr" title="${esc(store.criticalLabel())} · ${esc(target?.name || 'Project completion')}">${store.criticalOptions().method === 'longest' ? 'Longest path' : 'Critical path'}${target ? ` to ${esc(target.name)}` : ' to Project completion'}: <b class="cr">${store.critCount}</b> tasks</span>` + (viol ? `<span style="color:#b45309">${viol} violated link${viol > 1 ? 's' : ''} (check manual dates or Auto-schedule)</span>` : ''));
}

function renderAll() {
  if (ui.selId != null && !store.info.has(ui.selId)) ui.selId = null;
  if (ui.linkId != null && !store.links.some((link) => link.id === ui.linkId)) ui.linkId = null;
  // Critical-only mode: focus exclusively on critical-path items (and their critical links), dimming everything else.
  ctx.critOnly = store.critical && store.criticalOnly;
  ctx.critKeep = ctx.critOnly ? new Set(store.tasks.filter((t) => store.info.get(t.id).critical).map((t) => t.id)) : null;
  ctx.rel = !ctx.critOnly && ui.focus && ui.selId != null ? store.related(ui.selId) : null;
  $('#app').classList.toggle('focusing', !!ctx.rel || ctx.critOnly);
  $('#app').classList.toggle('crit-only', ctx.critOnly);
  {
    const lg = $('#focusleg');
    if (ctx.critOnly) {
      lg.hidden = false;
      setHTML(lg, `<b>Critical path only</b><span class="k crit-k"><i></i>In focus <em>${store.critCount}</em></span>`);
    } else if (ctx.rel) {
      const n = (s) => ctx.rel[s].size;
      lg.hidden = false;
      setHTML(lg, `<b>Focus</b><span class="k anc"><i></i>Parents <em class="n-anc">${n('anc')}</em></span><span class="k desc"><i></i>Children <em class="n-desc">${n('desc')}</em></span><span class="k up"><i></i>Predecessors <em class="n-up">${n('up')}</em></span><span class="k down"><i></i>Successors <em class="n-down">${n('down')}</em></span>`);
    } else {
      lg.hidden = true;
    }
  }
  fitDensity($('#gb').clientHeight, store.rows.length);
  $('#density').value = dims.name;
  ctx.delay.refresh();
  grid.render(); gantt.render(); status(); sheets.render(); paintReadOnly(); ctx.relationships.render(); ctx.slack.render();
  $('.brand b').textContent = store.sheet().name; $('.brand b').title = store.sheet().name;
  document.title = `${store.sheet().name} — Plan`;
  const blocked = !!(store.pending || store.suspended || store.locked);
  document.querySelectorAll('[data-act=add],[data-act=addms],[data-act=indent],[data-act=outdent],[data-act=del],[data-act=reset],#snapshotbtn,#impbtn,#settingsbtn,#addsheet,#optFocus,#density,#critmode button').forEach(button => { button.disabled = blocked; });
  $('[data-act=undo]').disabled = blocked || !store.undoStack.length;
  $('[data-act=redo]').disabled = blocked || !store.redoStack.length;
  {
    const mode = store.criticalMode(), cm = $('#critmode');
    cm.dataset.mode = mode;
    cm.querySelectorAll('button[data-crit]').forEach((b) => {
      const on = b.dataset.crit === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  $('#optAuto').checked = store.auto; criticalUI.render();
  // A saved version on screen is read-only: its scheduling and critical-path target are the version's own.
  $('#optAuto').disabled = blocked || !!store.preview; $('#critical-target').disabled = blocked || !!store.preview;
  ctx.versions.render();
}
store.on((kind) => {
  syncAcceptedLayout();
  if (kind !== 'drag') diagnostics.record('model.change', { kind, taskCount: store.tasks.length, linkCount: store.links.length });
  if (kind === 'denied' && store.preview) { ctx.toast(PREVIEW_LOCK); return; }
  if (kind === 'denied') { ctx.toast('This local snapshot is read-only. Make an editable copy to change it.'); return; }
  if (kind === 'drag') ctx.requestRender(); // coalesced to one render per frame, however many pointer events arrive
  else if (kind === 'sheet') {
    const render = diagnostics.begin('ui.renderSheet');
    try {
      restoreSelection(); gantt.reset(); grid.resetScroll(); grid.invalidateHead(); renderAll(); render.end();
      requestAnimationFrame(() => { gantt.initialScroll(); grid.restoreScroll(); });
    } catch (error) { render.fail(error); throw error; }
  } else if (kind === 'version') { // entering or leaving a saved version replaces the rows on screen
    grid.invalidateHead(); gantt.closePop(); renderAll();
  } else ctx.requestRender();
});

ctx.insertTask = async (ms = false, position = 'after', referenceId = ui.selId) => {
  if (await grid.commitEdit() === false) return;
  try {
    const result = await store.insertTask(referenceId, ms, position);
    if (result.error) { ctx.toast(result.error); return; }
    ctx.select(result.id, 'name', true); grid.startEdit(result.id, 'name');
  } catch (error) { ctx.toast(error.message); }
};
const run = async (action) => { try { await action(); } catch (error) { ctx.toast(`${error.message} Download copy is available.`); } };
createTaskUI(ctx, grid);
ctx.taskDialog = createTaskDialog(ctx, grid);
ctx.calendar = createCalendarUI(ctx, grid);
const act = {
  add: () => ctx.insertTask(),
  addms: () => ctx.insertTask(true),
  indent: async () => { if (await grid.commitEdit() === false) return; if (ui.selId != null) { const err = await store.indent(ui.selId, 1); if (err) ctx.toast(err); else ctx.select(ui.selId, 'name', true); } },
  outdent: async () => { if (await grid.commitEdit() === false) return; if (ui.selId != null) { const err = await store.indent(ui.selId, -1); if (err) ctx.toast(err); else ctx.select(ui.selId, 'name', true); } },
  del: async () => {
    if (await grid.commitEdit() === false) return;
    if (ui.linkId) { await store.removeLink(ui.linkId); ui.linkId = null; gantt.closePop(); }
    else if (ui.selId != null) {
      const id = ui.selId, rows = store.rows, i = rows.findIndex((t) => t.id === id);
      const after = () => { const n = store.rows[Math.min(i, store.rows.length - 1)]; ui.selId = n ? n.id : null; };
      // a task with an agreed date leaves the plan as an agreed omission (kept in the Delay log) or is deleted outright
      await ctx.delay.confirmDelete(id, async () => { await store.deleteTask(id); after(); }, after);
    }
  },
  undo: () => store.undo(), redo: () => store.redo(),
  reset: async () => { if (window.confirm('Restore the demo workbook? All sheets will be replaced.')) await store.resetAll(); },
  zoomin: () => gantt.zoomStep(1), zoomout: () => gantt.zoomStep(-1), today: () => gantt.goToday(),
};
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && act[b.dataset.act]) void run(act[b.dataset.act]); });
$('#density').addEventListener('change', (e) => { const value = e.target.value; e.target.value = dims.name; void run(async () => { await setDensity(value); ctx.requestRender(); }); });
$('#optFocus').checked = ui.focus;
$('#optFocus').addEventListener('change', (e) => { const value = e.target.checked; e.target.checked = ui.focus; void run(async () => { await appState.setItem('pm-focus', value ? '1' : '0'); ui.focus = value; renderAll(); }); });
{
  const cm = $('#critmode'), modes = ['off', 'show', 'only'];
  cm.addEventListener('click', (e) => { const b = e.target.closest('button[data-crit]'); if (b) void run(() => store.setCriticalMode(b.dataset.crit)); });
  cm.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = modes.indexOf(store.criticalMode());
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (cur + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
    void run(() => store.setCriticalMode(modes[next]));
    cm.querySelector(`[data-crit="${modes[next]}"]`)?.focus();
  });
}
$('#optAuto').addEventListener('change', (e) => { const value = e.target.checked; e.target.checked = store.auto; void run(() => store.setPref('auto', value)); });

// The canonical database Web Lock chooses the writer. Browser storage is never
// used as a cross-tab workspace or staleness signal in SQLite mode.

// keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea,select') || document.querySelector('.modal-back, #diagnostics-dialog[open], #analysis:not([hidden])')) return; // dialogs own the keyboard
  const mod = e.metaKey || e.ctrlKey;
  // keys on a focused button/link/switch belong to that control, not to the grid (keeps Tab and Enter working for keyboard users)
  if (!mod && !e.altKey && e.target !== document.body && e.target.closest('button,a[href],select,summary,[role=button],[role=tab]') && !['Escape', 'Delete', 'Backspace'].includes(e.key)) return;
  if (gantt.isDragging() && e.key !== 'Escape') { if (mod || e.key === 'Delete' || e.key === 'Backspace') e.preventDefault(); return; }
  if (mod && !e.altKey && e.key === 'Enter') { e.preventDefault(); ctx.insertTask(e.shiftKey); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); void run(() => e.shiftKey ? store.redo() : store.undo()); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); void run(() => store.redo()); return; }
  if (e.key === 'Escape') { if (gantt.isDragging()) gantt.cancelDrag(); else if (gantt.popOpen()) gantt.closePop(); else { ui.linkId = null; ctx.select(null); } return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (ui.linkId || (ui.selId != null && mod)) { e.preventDefault(); void run(act.del); }
    else if (ui.selId != null) { // spreadsheet behaviour: clear the cell; deleting a task needs Ctrl/⌘+Delete or the toolbar button
      e.preventDefault();
      if (['owner', 'email', 'pred'].includes(ui.col)) { void run(async () => { const err = await store.setCell(ui.selId, ui.col, ''); if (err) ctx.toast(err); }); }
      else ctx.toast('Ctrl/⌘+Delete removes the selected task');
    }
    return;
  }
  if (e.altKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
    e.preventDefault(); const ws = store.wb.sheets, i = ws.findIndex((s) => s.id === store.wb.active), n = ws.length;
    store.switchSheet(ws[(i + (e.key === 'PageDown' ? 1 : n - 1)) % n].id); return;
  }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); void run(act.indent); return; }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); void run(act.outdent); return; }
  if (ui.selId == null) { if (e.key.startsWith('Arrow') && (e.target === document.body || e.target.id === 'gx')) { e.preventDefault(); ctx.select(store.rows[0]?.id, 'name'); } return; }
  const mv = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }[e.key];
  if (mv) { e.preventDefault(); grid.moveSel(...mv); return; }
  if (e.key === 'Tab') { e.preventDefault(); grid.moveSel(0, e.shiftKey ? -1 : 1); return; }
  if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); grid.startEdit(ui.selId, ui.col); return; }
  if (e.key.length === 1 && !mod && !e.altKey) { e.preventDefault(); grid.startEdit(ui.selId, ui.col, e.key); }
});

// splitter
(() => {
  const sp = $('#split'); let saved = null; try { saved = appState.getItem('pm-gridw'); } catch { /* storage blocked */ }
  const width = Number(saved);
  if (Number.isFinite(width) && width > 0) document.documentElement.style.setProperty('--gridw', `${Math.max(320, Math.min(innerWidth - 320, width))}px`);
  sp.addEventListener('pointerdown', (e) => {
    if (store.pending || store.suspended || store.locked) return;
    sp.setPointerCapture(e.pointerId); sp.classList.add('on');
    const x0 = e.clientX, w0 = $('#left').getBoundingClientRect().width;
    let w = w0, pend = 0;
    const mv = (ev) => { w = Math.max(320, Math.min(innerWidth - 320, w0 + ev.clientX - x0)); if (!pend) pend = requestAnimationFrame(() => { pend = 0; document.documentElement.style.setProperty('--gridw', `${w}px`); gantt.render(); }); };
    const up = () => {
      sp.classList.remove('on'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('lostpointercapture', up);
      if (pend) { cancelAnimationFrame(pend); pend = 0; }
      const next = Math.round(w); document.documentElement.style.setProperty('--gridw', `${w0}px`); gantt.render();
      void run(async () => { await appState.setItem('pm-gridw', next); document.documentElement.style.setProperty('--gridw', `${next}px`); gantt.render(); });
    };
    sp.addEventListener('pointermove', mv); sp.addEventListener('lostpointercapture', up);
  });
})();

addEventListener('resize', () => ctx.requestRender());
if (window.ResizeObserver) {
  new ResizeObserver(() => ctx.requestRender()).observe($('#gb'));
  // Both panes share the control row height when timeline controls wrap.
  const strip = $('.strip');
  const syncControlsHeight = () => $('#app').style.setProperty('--controls-height', getComputedStyle(strip).height);
  syncControlsHeight();
  new ResizeObserver(syncControlsHeight).observe(strip);
}
renderAll();
diagnostics.record('app.ready');
// The contour backdrop (behind dialogs and menus, and in the bottom-left corner of the page) is decoration: load it after the app is ready, and if it fails the surfaces stay plain white.
import('./contour.js').then((m) => m.initContour()).catch((e) => diagnostics.record('contour.unavailable', { message: String(e?.message || e) }));
requestAnimationFrame(() => { gantt.initialScroll(); grid.restoreScroll(); });
void COLS;
