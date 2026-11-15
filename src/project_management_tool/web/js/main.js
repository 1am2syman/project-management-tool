import { Store, fmtDate } from './model.js';
import { createGrid, COLS } from './grid.js';
import { createGantt } from './gantt.js';
import { setHTML } from './dom.js';
import { initDensity, setDensity, dims } from './dims.js';

const $ = (s) => document.querySelector(s);
initDensity();
const store = new Store();
const ui = { selId: null, col: 'name', linkId: null };
let raf = 0, toastT = 0, grid, gantt;

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
  scrollV(dy) { $('#gb').scrollTop += dy; },
  syncV(v) { grid.setScrollTop(v); },
};
grid = createGrid(ctx);
gantt = createGantt(ctx);

function status() {
  const leaves = store.tasks.filter((t) => !store.info.get(t.id).summary), ms = leaves.filter((t) => t.ms).length, P = store.project;
  const viol = store.links.filter((l) => l.violated).length;
  setHTML($('#stat'), `<span><b>${leaves.length - ms}</b> tasks · <b>${ms}</b> milestones · <b>${store.links.length}</b> links</span>` +
    `<span>Finish <b>${fmtDate(P.end - 1)}</b> · <b>${P.end - P.start}</b> days</span>` +
    `<span class="cr">Critical path: <b class="cr">${store.critCount}</b> tasks</span>` + (viol ? `<span style="color:#b45309">${viol} violated link${viol > 1 ? 's' : ''} (auto-schedule off)</span>` : ''));
}

function renderAll() {
  if (ui.selId != null && !store.info.has(ui.selId)) ui.selId = null;
  grid.render(); gantt.render(); status();
  $('[data-act=undo]').disabled = !store.undoStack.length;
  $('[data-act=redo]').disabled = !store.redoStack.length;
  $('#optCrit').checked = store.critical; $('#optAuto').checked = store.auto;
}
store.on((kind) => { if (kind === 'drag') { renderAll(); } else ctx.requestRender(); });

const act = {
  add: () => { const id = store.addTask(ui.selId); ctx.select(id, 'name', true); setTimeout(() => grid.startEdit(id, 'name'), 30); },
  addms: () => { const id = store.addTask(ui.selId, true); ctx.select(id, 'name', true); },
  indent: () => { if (ui.selId != null) store.indent(ui.selId, 1); },
  outdent: () => { if (ui.selId != null) store.indent(ui.selId, -1); },
  del: () => {
    if (ui.linkId) { store.removeLink(ui.linkId); ui.linkId = null; gantt.closePop(); }
    else if (ui.selId != null) { const rows = store.rows, i = rows.findIndex((t) => t.id === ui.selId); store.deleteTask(ui.selId); const n = store.rows[Math.min(i, store.rows.length - 1)]; ui.selId = n ? n.id : null; }
  },
  undo: () => store.undo(), redo: () => store.redo(),
  reset: () => { ui.selId = null; store.reset(); },
  density: () => { setDensity(dims.name === 'compact' ? 'roomy' : 'compact'); ctx.requestRender(); },
  zoomin: () => gantt.zoomStep(1), zoomout: () => gantt.zoomStep(-1), today: () => gantt.goToday(),
};
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && act[b.dataset.act]) act[b.dataset.act](); });
$('#optCrit').addEventListener('change', (e) => store.setPref('critical', e.target.checked));
$('#optAuto').addEventListener('change', (e) => store.setPref('auto', e.target.checked));

// keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
  if (e.key === 'Escape') { if (gantt.isDragging()) gantt.cancelDrag(); else if (gantt.popOpen()) gantt.closePop(); else { ui.linkId = null; ctx.select(null); } return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (ui.linkId || ui.selId != null) { e.preventDefault(); act.del(); } return; }
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
  const sp = $('#split'), saved = localStorage.getItem('pm-gridw');
  if (saved) document.documentElement.style.setProperty('--gridw', `${saved}px`);
  sp.addEventListener('pointerdown', (e) => {
    sp.setPointerCapture(e.pointerId); sp.classList.add('on');
    const x0 = e.clientX, w0 = $('#left').getBoundingClientRect().width;
    const mv = (ev) => { const w = Math.max(320, Math.min(innerWidth - 320, w0 + ev.clientX - x0)); document.documentElement.style.setProperty('--gridw', `${w}px`); localStorage.setItem('pm-gridw', Math.round(w)); gantt.render(); };
    const up = () => { sp.classList.remove('on'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); };
    sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up);
  });
})();

addEventListener('resize', () => ctx.requestRender());
renderAll();
requestAnimationFrame(() => gantt.initialScroll());
void COLS;
