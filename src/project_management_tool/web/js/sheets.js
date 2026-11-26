// Excel-style sheet tabs (one project per sheet) + template picker / saver.
import { Store, fmtISO, parseDate, today } from './model.js';
import { esc, setHTML } from './dom.js';

const PALETTE = ['#5b7cfa', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'];
const colorOf = (id) => PALETTE[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

export function createSheets(ctx) {
  const { store } = ctx;
  const $ = (s) => document.querySelector(s);
  const tabs = $('#tabs'), tplbtn = $('#tplbtn'), tplpop = $('#tplpop'), menu = $('#ctxmenu');
  let pending = false;
  const blocked = () => pending || store.pending || store.suspended || store.locked || store.stale;
  async function action(command) {
    if (blocked()) return;
    pending = true; render();
    tplpop.setAttribute('aria-busy', 'true');
    const notice = document.createElement('p'); notice.setAttribute('role', 'status'); notice.textContent = 'Pending…'; tplpop.appendChild(notice);
    const controls = [...tplpop.querySelectorAll('button,input')].map((el) => [el, el.disabled]);
    controls.forEach(([el]) => { el.disabled = true; });
    try { return await command(); }
    catch (error) { ctx.toast(error.message || String(error)); }
    finally { pending = false; render(); notice.remove(); tplpop.removeAttribute('aria-busy'); controls.forEach(([el, disabled]) => { el.disabled = disabled; }); }
  }
  let key = '', renaming = false, dragId = null, startVal = fmtISO(today), menuId = null;

  // ---------- tabs ----------
  function render() {
    $('#addsheet').disabled = !!blocked();
    tplbtn.disabled = !!blocked();
    if (!menu.hidden) {
      const index = store.wb.sheets.findIndex(sheet => sheet.id === menuId), count = store.wb.sheets.length;
      for (const button of menu.querySelectorAll('button[data-a]')) {
        const action = button.dataset.a;
        button.disabled = !!(blocked() || (action === 'left' && index === 0) || (action === 'right' && index === count - 1) || (action === 'del' && count < 2));
      }
    }
    if (renaming) return;
    const k = `${store.wb.active}|${blocked() ? 1 : 0}|${store.wb.sheets.map((s) => `${s.id}:${s.name}:${s.readOnly ? 1 : 0}`).join('|')}`;
    if (k === key) return; key = k;
    setHTML(tabs, store.wb.sheets.map((s) => `<div class="tab${s.id === store.wb.active ? ' on' : ''}${s.readOnly ? ' ro' : ''}" draggable="${blocked() ? 'false' : 'true'}" data-id="${esc(s.id)}" style="--tc:${colorOf(s.id)}" title="${esc(s.name)}"><i class="sd"></i><span class="tn">${esc(s.name)}</span></div>`).join(''));
    tabs.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function rename(id) {
    if (renaming || blocked()) return;
    const tab = tabs.querySelector(`.tab[data-id="${id}"]`); if (!tab) return;
    const s = store.sheet(id); renaming = true;
    const inp = document.createElement('input'); inp.value = s.name; inp.maxLength = 60;
    tab.querySelector('.tn').replaceWith(inp); tab.draggable = false; inp.focus(); inp.select();
    let done = false;
    const end = async (commit) => {
      if (done || pending) return;
      if (!commit) { done = true; renaming = false; key = ''; render(); return; }
      if (!inp.value.trim()) { ctx.toast('Give the project a name'); inp.focus(); return; }
      await action(async () => {
        inp.disabled = true; inp.setAttribute('aria-busy', 'true');
        try {
          await store.renameSheet(id, inp.value);
          done = true; renaming = false; key = ''; render(); ctx.requestRender();
        } finally { inp.disabled = false; inp.removeAttribute('aria-busy'); }
      });
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') end(true); else if (e.key === 'Escape') end(false); });
    inp.addEventListener('blur', () => end(true));
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  tabs.addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t && !e.target.matches('input')) store.switchSheet(t.dataset.id); });
  tabs.addEventListener('dblclick', (e) => { const t = e.target.closest('.tab'); if (t) rename(t.dataset.id); });
  tabs.addEventListener('contextmenu', (e) => { const t = e.target.closest('.tab'); if (!t) return; e.preventDefault(); openMenu(t.dataset.id, e.clientX, e.clientY); });
  tabs.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabs.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

  // drag to reorder
  const clearDrop = () => tabs.querySelectorAll('.drop-l,.drop-r').forEach((t) => t.classList.remove('drop-l', 'drop-r'));
  tabs.addEventListener('dragstart', (e) => { if (blocked()) { e.preventDefault(); return; } const t = e.target.closest('.tab'); if (!t) return; dragId = t.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); t.classList.add('dragging'); });
  tabs.addEventListener('dragover', (e) => {
    const t = e.target.closest('.tab'); if (blocked() || !dragId || !t) return; e.preventDefault();
    const r = t.getBoundingClientRect(), left = e.clientX < r.left + r.width / 2;
    clearDrop(); if (t.dataset.id !== dragId) t.classList.add(left ? 'drop-l' : 'drop-r');
  });
  tabs.addEventListener('drop', (e) => {
    if (blocked()) return;
    const t = e.target.closest('.tab'); if (!dragId || !t || t.dataset.id === dragId) return; e.preventDefault();
    const r = t.getBoundingClientRect(), left = e.clientX < r.left + r.width / 2;
    const ws = store.wb.sheets, from = ws.findIndex((s) => s.id === dragId); let to = ws.findIndex((s) => s.id === t.dataset.id) + (left ? 0 : 1);
    if (from < to) to--;
    const id = dragId; void action(() => store.moveSheet(id, to));
  });
  tabs.addEventListener('dragend', () => { dragId = null; clearDrop(); tabs.querySelectorAll('.dragging').forEach((t) => t.classList.remove('dragging')); });

  $('#addsheet').addEventListener('click', () => action(async () => { await store.newBlank(); ctx.toast('New blank project — use Templates to start from a template'); }));

  // ---------- context menu ----------
  function openMenu(id, x, y) {
    menuId = id; const s = store.sheet(id), i = store.wb.sheets.indexOf(s), n = store.wb.sheets.length;
    const item = (a, label, dis, cls = '') => `<button data-a="${a}" class="${cls}"${blocked() || dis ? ' disabled' : ''}>${label}</button>`;
    setHTML(menu, item('rename', 'Rename') + item('dup', 'Duplicate') + item('tpl', 'Save as template…') + '<hr>' + item('left', 'Move left', i === 0) + item('right', 'Move right', i === n - 1) + '<hr>' + item('del', 'Delete', n < 2, 'danger'));
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`; menu.style.top = `${Math.max(8, y - r.height - 4)}px`;
  }
  const closeMenu = () => { menu.hidden = true; };
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]'); if (!b || b.disabled || blocked()) return;
    const id = menuId, a = b.dataset.a, ws = store.wb.sheets, i = ws.findIndex((s) => s.id === id); closeMenu();
    if (a === 'rename') { if (id !== store.wb.active) store.switchSheet(id); setTimeout(() => rename(id), 30); }
    else if (a === 'dup') void action(() => store.duplicateSheet(id));
    else if (a === 'tpl') { if (id !== store.wb.active) store.switchSheet(id); setTimeout(() => openTpl(true), 30); }
    else if (a === 'left') void action(() => store.moveSheet(id, i - 1));
    else if (a === 'right') void action(() => store.moveSheet(id, i + 1));
    else if (a === 'del') {
      const s = store.sheet(id);
      if (window.confirm(`Delete "${s.name}"? This cannot be undone.`)) void action(() => store.deleteSheet(id));
    }
  });

  // ---------- templates ----------
  function tplList() {
    return store.allTemplates().map((t) => {
      const sm = Store.summaryOf(t);
      return `<div class="tcard" data-t="${esc(t.id)}" tabindex="0"><div class="tt"><b>${esc(t.name)}</b>${t.builtin ? '' : '<em>saved</em>'}</div><div class="td">${esc(t.desc || '')}</div><div class="tm">${sm.tasks} tasks · ${sm.ms} milestones · ${sm.span} days</div>${t.builtin ? '' : `<button class="tx" data-del="${esc(t.id)}" title="Delete template">✕</button>`}</div>`;
    }).join('');
  }
  function fillTpl(focusName) {
    const cur = store.sheet().name;
    const keep = tplpop.querySelector('#tplname')?.value;
    setHTML(tplpop, `<div class="ttl"><b>Start a new sheet from a template</b></div>` +
      `<label class="trow"><span>Start date</span><input type="date" id="tplstart" value="${esc(startVal)}"></label>` +
      `<div class="tlist">${tplList()}</div>` +
      `<div class="ttl sv"><b>Save “${esc(cur)}” as a template</b></div>` +
      `<div class="trow"><input id="tplname" placeholder="Template name" maxlength="60" value="${esc(keep ?? cur)}"><button id="tplsave" class="pri">Save</button></div>` +
      `<div class="note">Saved templates keep tasks, durations, owners and links (relative dates, progress reset).</div>`);
    if (focusName) { const i = tplpop.querySelector('#tplname'); i.focus(); i.select(); }
  }
  function openTpl(focusName) {
    if (blocked()) return;
    closeMenu(); fillTpl(focusName); tplpop.hidden = false;
    const r = tplbtn.getBoundingClientRect(), pr = tplpop.getBoundingClientRect();
    tplpop.style.left = `${Math.max(8, Math.min(r.right - pr.width, innerWidth - pr.width - 8))}px`;
    tplpop.style.top = `${Math.max(8, r.top - pr.height - 8)}px`;
  }
  const closeTpl = () => { if (!pending) tplpop.hidden = true; };
  tplbtn.addEventListener('click', (e) => { e.stopPropagation(); if (tplpop.hidden) openTpl(false); else closeTpl(); });
  tplpop.addEventListener('input', (e) => { if (e.target.id === 'tplstart') startVal = e.target.value; });
  tplpop.addEventListener('click', (e) => {
    if (blocked()) return;
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); void action(async () => { await store.deleteTemplate(del.dataset.del); fillTpl(false); ctx.toast('Template deleted'); }); return; }
    if (e.target.id === 'tplsave') return saveTpl();
    const card = e.target.closest('.tcard');
    if (card) useTpl(card.dataset.t);
  });
  tplpop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeTpl();
    else if (e.key === 'Enter') { if (e.target.id === 'tplname') saveTpl(); else if (e.target.classList?.contains('tcard')) useTpl(e.target.dataset.t); }
  });
  function useTpl(id) {
    if (blocked()) return;
    const day = parseDate(startVal || '', today);
    if (day == null) { ctx.toast('Choose a valid start date'); return; }
    return action(async () => {
      const created = await store.commit((draft) => {
        const template = draft.allTemplates().find((x) => x.id === id);
        if (!template) throw new Error('That template no longer exists');
        return draft.instantiate(template, day);
      });
      tplpop.hidden = true; ctx.toast(`Created “${store.sheet(created)?.name || 'project'}” from template`);
    });
  }
  function saveTpl() {
    if (blocked()) return;
    const name = tplpop.querySelector('#tplname').value;
    return action(async () => {
      const r = await store.saveTemplate(name);
      if (!r) { ctx.toast('Give the template a name'); return; }
      fillTpl(false); ctx.toast(r.updated ? `Template “${r.tpl.name}” updated` : `Saved template “${r.tpl.name}”`);
    });
  }

  document.addEventListener('pointerdown', (e) => {
    if (!tplpop.hidden && !tplpop.contains(e.target) && !tplbtn.contains(e.target)) closeTpl();
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  addEventListener('blur', closeMenu);

  return { render, rename, openTemplates: () => openTpl(false), closeAll: () => { closeMenu(); closeTpl(); } };
}
