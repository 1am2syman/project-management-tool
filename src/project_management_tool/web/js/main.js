import { Store, fmtDate } from './model.js';
import { createGrid, COLS } from './grid.js';
import { createGantt } from './gantt.js';
import { setHTML } from './dom.js';
import { createSheets } from './sheets.js';
import { createExport } from './export.js';
import { initDensity, setDensity, dims } from './dims.js';

const $ = (s) => document.querySelector(s);
initDensity();
const store = new Store();
const ui = { selId: null, col: 'name', linkId: null };
let raf = 0, toastT = 0, grid, gantt, sheets;

const ctx = {
  store, ui,
  requestRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); },
  select(id, col, reveal) {
    ui.selId = id; ui.linkId = null; if (col) ui.col = col;
    gantt.closePop(); grid.invalidateHead(); renderAll();
    if (reveal && id != null) { gantt.reveal(id, true); grid.scrollIntoView(); }
  },
  selectLink(id) { ui.linkId = id; ui.selId = null; renderAll(); },
  toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); },
  syncGantt(v) { const gb = $('#gb'); if (gb.scrollTop !== v) gb.scrollTop = v; },
  syncV(v) { grid.setScrollTop(v); },
};
grid = createGrid(ctx);
gantt = createGantt(ctx);
sheets = createSheets(ctx);
createExport(ctx);

function status() {
  const leaves = store.tasks.filter((t) => !store.info.get(t.id).summary), ms = leaves.filter((t) => t.ms).length, P = store.project;
  const viol = store.links.filter((l) => l.violated).length;
  setHTML($('#stat'), `<span><b>${leaves.length - ms}</b> tasks · <b>${ms}</b> milestones · <b>${store.links.length}</b> links</span>` +
    `<span>Finish <b>${fmtDate(P.end - 1)}</b> · <b>${P.end - P.start}</b> days</span>` +
    `<span class="cr">Critical path: <b class="cr">${store.critCount}</b> tasks</span>` + (viol ? `<span style="color:#b45309">${viol} violated link${viol > 1 ? 's' : ''} (auto-schedule off)</span>` : ''));
}

function renderAll() {
  if (ui.selId != null && !store.info.has(ui.selId)) ui.selId = null;
  grid.render(); gantt.render(); status(); sheets.render();
  $('.brand b').textContent = store.sheet().name;
  document.title = `${store.sheet().name} — Plan`;
  $('[data-act=undo]').disabled = !store.undoStack.length;
  $('[data-act=redo]').disabled = !store.redoStack.length;
  $('#optCrit').checked = store.critical; $('#optAuto').checked = store.auto;
}
store.on((kind) => {
  if (kind === 'drag') renderAll();
  else if (kind === 'sheet') {
    ui.selId = null; ui.linkId = null; gantt.reset(); grid.invalidateHead(); renderAll();
    requestAnimationFrame(() => gantt.initialScroll());
  } else ctx.requestRender();
});

const act = {
  add: () => { const id = store.addTask(ui.selId); ctx.select(id, 'name', true); setTimeout(() => grid.startEdit(id, 'name'), 30); },
  addms: () => { const id = store.addTask(ui.selId, true); ctx.select(id, 'name', true); },
  indent: () => { if (ui.selId != null) { const err = store.indent(ui.selId, 1); if (err) ctx.toast(err); } },
  outdent: () => { if (ui.selId != null) store.indent(ui.selId, -1); },
  del: () => {
    if (ui.linkId) { store.removeLink(ui.linkId); ui.linkId = null; gantt.closePop(); }
    else if (ui.selId != null) { const rows = store.rows, i = rows.findIndex((t) => t.id === ui.selId); store.deleteTask(ui.selId); const n = store.rows[Math.min(i, store.rows.length - 1)]; ui.selId = n ? n.id : null; }
  },
  undo: () => store.undo(), redo: () => store.redo(),
  reset: () => { if (window.confirm('Restore the demo workbook? All sheets will be replaced.')) store.resetAll(); },
  density: () => { setDensity(dims.name === 'compact' ? 'roomy' : 'compact'); ctx.requestRender(); },
  zoomin: () => gantt.zoomStep(1), zoomout: () => gantt.zoomStep(-1), today: () => gantt.goToday(),
};
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && act[b.dataset.act]) act[b.dataset.act](); });
$('#optCrit').addEventListener('change', (e) => store.setPref('critical', e.target.checked));
$('#optAuto').addEventListener('change', (e) => store.setPref('auto', e.target.checked));

// keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea,select')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (gantt.isDragging() && e.key !== 'Escape') { if (mod || e.key === 'Delete' || e.key === 'Backspace') e.preventDefault(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
  if (e.key === 'Escape') { if (gantt.isDragging()) gantt.cancelDrag(); else if (gantt.popOpen()) gantt.closePop(); else { ui.linkId = null; ctx.select(null); } return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (ui.linkId || (ui.selId != null && mod)) { e.preventDefault(); act.del(); }
    else if (ui.selId != null) { // spreadsheet behaviour: clear the cell; deleting a task needs Ctrl/⌘+Delete or the toolbar button
      e.preventDefault();
      if (['owner', 'pred'].includes(ui.col)) { const err = store.setCell(ui.selId, ui.col, ''); if (err) ctx.toast(err); }
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
  if (ui.selId == null) { if (e.key.startsWith('Arrow')) { e.preventDefault(); ctx.select(store.rows[0]?.id, 'name'); } return; }
  const mv = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }[e.key];
  if (mv) { e.preventDefault(); grid.moveSel(...mv); return; }
  if (e.key === 'Tab') { e.preventDefault(); grid.moveSel(0, e.shiftKey ? -1 : 1); return; }
  if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); grid.startEdit(ui.selId, ui.col); return; }
  if (e.key.length === 1 && !mod && !e.altKey) { e.preventDefault(); grid.startEdit(ui.selId, ui.col, e.key); }
});

// splitter
(() => {
  const sp = $('#split'); let saved = null; try { saved = localStorage.getItem('pm-gridw'); } catch { /* storage blocked */ }
  if (saved) document.documentElement.style.setProperty('--gridw', `${saved}px`);
  sp.addEventListener('pointerdown', (e) => {
    sp.setPointerCapture(e.pointerId); sp.classList.add('on');
    const x0 = e.clientX, w0 = $('#left').getBoundingClientRect().width;
    let w = w0, pend = 0;
    const mv = (ev) => { w = Math.max(320, Math.min(innerWidth - 320, w0 + ev.clientX - x0)); if (!pend) pend = requestAnimationFrame(() => { pend = 0; document.documentElement.style.setProperty('--gridw', `${w}px`); gantt.render(); }); };
    const up = () => { sp.classList.remove('on'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('lostpointercapture', up); try { localStorage.setItem('pm-gridw', Math.round(w)); } catch { /* storage blocked */ } };
    sp.addEventListener('pointermove', mv); sp.addEventListener('lostpointercapture', up);
  });
})();

addEventListener('resize', () => ctx.requestRender());
renderAll();
requestAnimationFrame(() => gantt.initialScroll());
void COLS;
