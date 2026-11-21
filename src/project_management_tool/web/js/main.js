import { diagnostics } from './diagnosticlog.js';
import { Store, fmtDate, PREVIEW_LOCK } from './model.js';
import { appState } from './appstate.js';
import { openProjectStorage } from './storage.js';
import { createHistory } from './history.js';
import { createGrid, COLS } from './grid.js';
import { createTaskUI } from './taskui.js';
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
const store = new Store(storage.initial);
storage.attach(store);
globalThis.PlanDiagnostics?.setStoreSummary(() => ({ sheetCount: store.wb.sheets.length, taskCount: store.tasks.length, linkCount: store.links.length, readOnly: store.readOnly, stale: !!store.stale, autoSchedule: store.auto, connectedFile: !!store.sheet().fileToken, undoCount: store.undoStack.length, saveStatus: $('#save-status').dataset.state }));
diagnostics.record('app.modelReady', { sheetCount: store.wb.sheets.length, taskCount: store.tasks.length });
let focusOn = true; try { focusOn = appState.getItem('pm-focus') !== '0'; } catch {}
let endDatesOn = false; try { endDatesOn = appState.getItem('pm-end-dates') === '1'; } catch {}
const ui = { selId: null, col: 'name', linkId: null, focus: focusOn, endDates: endDatesOn };
let selections = {};
try { const value = JSON.parse(appState.getItem('pm-selection') || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) selections = value; } catch { /* no saved selection */ }
function restoreSelection() {
  const current = selections[store.wb.active] || {};
  ui.selId = current.selId ?? null; ui.linkId = current.linkId ?? null;
  ui.col = COLS.some((col) => col.id === current.col) ? current.col : 'name';
}
function rememberSelection() {
  selections[store.wb.active] = { selId: ui.selId, linkId: ui.linkId, col: ui.col };
  appState.setItem('pm-selection', JSON.stringify(selections));
}
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
createProjectFiles(ctx);
createImport(ctx);
createHistory();
ctx.people = createPeople(ctx);
ctx.delay = createDelayUI(ctx);
const banner = $('#robanner');
banner.addEventListener('click', (event) => {
  if (event.target.closest('#roCopy')) {
    store.duplicateSheet(store.wb.active);
    ctx.toast('Editable local copy created');
  }
});
function paintReadOnly() {
  const readOnly = store.readOnly;
  $('#app').classList.toggle('ro', readOnly);
  banner.hidden = !readOnly;
  if (readOnly) setHTML(banner, '<span class="lock">Read-only local snapshot</span><span>Create a local copy to edit this older project.</span><span style="flex:1"></span><button id="roCopy">Make editable copy</button>');
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
  $('[data-act=undo]').disabled = !store.undoStack.length;
  $('[data-act=redo]').disabled = !store.redoStack.length;
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
  $('#optEnd').checked = ui.endDates; $('#optAuto').checked = store.auto; criticalUI.render();
  // A saved version on screen is read-only: its scheduling and critical-path target are the version's own.
  $('#optAuto').disabled = !!store.preview; $('#critical-target').disabled = !!store.preview;
  ctx.versions.render();
}
store.on((kind) => {
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

ctx.insertTask = (ms = false, position = 'after', referenceId = ui.selId) => {
  grid.commitEdit();
  const result = store.insertTask(referenceId, ms, position);
  if (result.error) { ctx.toast(result.error); return; }
  ctx.select(result.id, 'name', true);
  grid.startEdit(result.id, 'name');
};
createTaskUI(ctx, grid);
ctx.calendar = createCalendarUI(ctx, grid);
const act = {
  add: () => ctx.insertTask(),
  addms: () => ctx.insertTask(true),
  indent: () => { grid.commitEdit(); if (ui.selId != null) { const err = store.indent(ui.selId, 1); if (err) ctx.toast(err); else ctx.select(ui.selId, 'name', true); } },
  outdent: () => { grid.commitEdit(); if (ui.selId != null) { const err = store.indent(ui.selId, -1); if (err) ctx.toast(err); else ctx.select(ui.selId, 'name', true); } },
  del: () => {
    if (ui.linkId) { store.removeLink(ui.linkId); ui.linkId = null; gantt.closePop(); }
    else if (ui.selId != null) {
      const id = ui.selId, rows = store.rows, i = rows.findIndex((t) => t.id === id);
      const after = () => { const n = store.rows[Math.min(i, store.rows.length - 1)]; ui.selId = n ? n.id : null; };
      // a task with an agreed date leaves the plan as an agreed omission (kept in the Delay log) or is deleted outright
      ctx.delay.confirmDelete(id, () => { store.deleteTask(id); after(); }, after);
    }
  },
  undo: () => store.undo(), redo: () => store.redo(),
  reset: () => { if (window.confirm('Restore the demo workbook? All sheets will be replaced.')) store.resetAll(); },
  zoomin: () => gantt.zoomStep(1), zoomout: () => gantt.zoomStep(-1), today: () => gantt.goToday(),
};
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && act[b.dataset.act]) act[b.dataset.act](); });
$('#density').addEventListener('change', (e) => { setDensity(e.target.value); ctx.requestRender(); });
$('#optFocus').checked = ui.focus;
$('#optFocus').addEventListener('change', (e) => { ui.focus = e.target.checked; try { appState.setItem('pm-focus', ui.focus ? '1' : '0'); } catch {} renderAll(); });
{
  const cm = $('#critmode'), modes = ['off', 'show', 'only'];
  cm.addEventListener('click', (e) => { const b = e.target.closest('button[data-crit]'); if (b) store.setCriticalMode(b.dataset.crit); });
  cm.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = modes.indexOf(store.criticalMode());
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (cur + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
    store.setCriticalMode(modes[next]);
    cm.querySelector(`[data-crit="${modes[next]}"]`)?.focus();
  });
}
$('#optEnd').addEventListener('change', (e) => { ui.endDates = e.target.checked; try { appState.setItem('pm-end-dates', ui.endDates ? '1' : '0'); } catch {} renderAll(); });
$('#optAuto').addEventListener('change', (e) => store.setPref('auto', e.target.checked));

// another tab saved the workbook: stop writing from this one (it would overwrite that tab's work) and offer a reload
window.addEventListener('storage', (e) => {
  if (e.key !== 'pm-workbook-v1' || store.stale) return;
  store.stale = true;
  storage.markStale();
  const bar = document.createElement('div'); bar.className = 'robanner stale';
  setHTML(bar, '<span class="lock">Changed in another tab</span><span>Edits here are no longer saved, to protect the other tab’s work.</span><span style="flex:1"></span><button>Reload</button>');
  bar.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(bar);
});

// keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea,select') || document.querySelector('.modal-back, #diagnostics-dialog[open], #analysis:not([hidden])')) return; // dialogs own the keyboard
  const mod = e.metaKey || e.ctrlKey;
  // keys on a focused button/link/switch belong to that control, not to the grid (keeps Tab and Enter working for keyboard users)
  if (!mod && !e.altKey && e.target !== document.body && e.target.closest('button,a[href],select,summary,[role=button],[role=tab]') && !['Escape', 'Delete', 'Backspace'].includes(e.key)) return;
  if (gantt.isDragging() && e.key !== 'Escape') { if (mod || e.key === 'Delete' || e.key === 'Backspace') e.preventDefault(); return; }
  if (mod && !e.altKey && e.key === 'Enter') { e.preventDefault(); ctx.insertTask(e.shiftKey); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
  if (e.key === 'Escape') { if (gantt.isDragging()) gantt.cancelDrag(); else if (gantt.popOpen()) gantt.closePop(); else { ui.linkId = null; ctx.select(null); } return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (ui.linkId || (ui.selId != null && mod)) { e.preventDefault(); act.del(); }
    else if (ui.selId != null) { // spreadsheet behaviour: clear the cell; deleting a task needs Ctrl/⌘+Delete or the toolbar button
      e.preventDefault();
      if (['owner', 'email', 'pred'].includes(ui.col)) { const err = store.setCell(ui.selId, ui.col, ''); if (err) ctx.toast(err); }
      else ctx.toast('Ctrl/⌘+Delete removes the selected task');
    }
    return;
  }
  if (e.altKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
    e.preventDefault(); const ws = store.wb.sheets, i = ws.findIndex((s) => s.id === store.wb.active), n = ws.length;
    store.switchSheet(ws[(i + (e.key === 'PageDown' ? 1 : n - 1)) % n].id); return;
  }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); act.indent(); return; }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); act.outdent(); return; }
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
    sp.setPointerCapture(e.pointerId); sp.classList.add('on');
    const x0 = e.clientX, w0 = $('#left').getBoundingClientRect().width;
    let w = w0, pend = 0;
    const mv = (ev) => { w = Math.max(320, Math.min(innerWidth - 320, w0 + ev.clientX - x0)); if (!pend) pend = requestAnimationFrame(() => { pend = 0; document.documentElement.style.setProperty('--gridw', `${w}px`); gantt.render(); }); };
    const up = () => { sp.classList.remove('on'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('lostpointercapture', up); try { appState.setItem('pm-gridw', Math.round(w)); } catch { /* storage blocked */ } };
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
