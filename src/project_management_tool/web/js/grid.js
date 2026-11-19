// Spreadsheet-style grid: name box, formula bar, column letters, group bands, heat-mapped cells,
import { appState } from './appstate.js';
// sparklines, frozen columns, inline editing, resizable columns.
import { fmtDate, fmtISO, today } from './model.js';
import { esc, setHTML } from './dom.js';
import { slackLabel } from './slackui.js';

export const COLS = [
  { id: 'name', letter: 'A', label: 'Task', w: 188, group: 'task' },
  { id: 'start', letter: 'B', label: 'Start', w: 70, group: 'sched', ctr: true },
  { id: 'end', letter: 'C', label: 'End', w: 70, group: 'sched', ctr: true },
  { id: 'dur', letter: 'D', label: 'Days', w: 58, group: 'sched', num: true },
  // Delay accounting: shown once the project has agreed dates (see delayui.js colVisible)
  { id: 'agreedO', letter: 'L', label: 'Original agreed', w: 128, group: 'dly', ctr: true, dly: true },
  { id: 'agreed', letter: 'M', label: 'Agreed', w: 76, group: 'dly', ctr: true, dly: true },
  { id: 'var', letter: 'N', label: '± days', w: 66, group: 'dly', num: true, dly: true },
  { id: 'origin', letter: 'O', label: 'Own / Inherited', w: 136, group: 'dly', dly: true },
  { id: 'cause', letter: 'P', label: 'Cause', w: 130, group: 'dly', dly: true },
  { id: 'progress', letter: 'E', label: 'Done', w: 66, group: 'prog', num: true },
  { id: 'float', letter: 'F', label: 'Total slack', w: 104, group: 'slack', num: true },
  { id: 'freeFloat', letter: 'G', label: 'Free slack', w: 100, group: 'slack', num: true },
  { id: 'trend', letter: 'H', label: 'Trend', w: 100, group: 'trend', spark: true },
  { id: 'pred', letter: 'I', label: 'Depends on', w: 104, group: 'dep' },
  { id: 'owner', letter: 'J', label: 'Owner', w: 112, group: 'dep' },
  { id: 'email', letter: 'K', label: 'Email', w: 190, group: 'dep' },
];
const GROUPS = [
  { id: 'task', label: 'Task' },
  { id: 'sched', label: 'Schedule · days', hl: true },
  { id: 'dly', label: 'Agreed · variance', hl: true },
  { id: 'prog', label: 'Progress' },
  { id: 'slack', label: 'Slack · working days' },
  { id: 'trend', label: 'Trend' },
  { id: 'dep', label: 'Dependencies & team' },
];
const AV = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444'];
const heat = (v) => { v = Math.max(0, Math.min(1, v)); return `background:rgba(79,102,240,${(0.05 + v * 0.62).toFixed(3)});${v > 0.62 ? 'color:#fff;font-weight:600;' : ''}`; };
const smooth = (x) => x * x * (3 - 2 * x);

function spark(f) {
  const s = f.start, e = Math.max(f.end, s + 1), W = 84, H = 24, x = (u) => 2 + u * (W - 6), y = (u) => H - 3 - u * (H - 8);
  const pts = []; for (let i = 0; i <= 14; i++) { const u = i / 14; pts.push(`${x(u).toFixed(1)},${y(smooth(u)).toFixed(1)}`); }
  const fr = Math.max(0, Math.min(1, (today - s) / (e - s))), p = f.progress / 100;
  const behind = p < fr - 0.05, done = f.progress >= 100, started = today >= s || f.progress > 0;
  const col = done ? '#15803d' : !started ? '#94a3b8' : behind ? '#dc2626' : '#15803d';
  const ex = x(started ? Math.max(fr, p > 0 ? Math.min(fr, 1) : 0) : 0), ey = y(started ? p : 0);
  return `<svg viewBox="0 0 ${W} ${H}"><polyline points="${pts.join(' ')}" stroke="#aab4c6" stroke-width="1.3" fill="none"/>` +
    (started ? `<polyline points="${x(0)},${y(0)} ${ex.toFixed(1)},${ey.toFixed(1)}" stroke="#5b7cfa" stroke-width="1.8" fill="none"/>` : '') +
    `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.2" fill="${col}" stroke="none"/></svg>`;
}

export function createGrid(ctx) {
  const { store, ui } = ctx;
  const $ = (s) => document.querySelector(s);
  const gx = $('#gx'), inner = $('#ginner'), band = $('#gband'), letters = $('#gletters'), head = $('#ghead'), body = $('#gbody');
  const namebox = $('#namebox'), fxin = $('#fxin');
  let editing = null, commitEditing = null, headKey = '', restoringScroll = true;
  try {
    const widths = JSON.parse(appState.getItem('pm-column-widths') || '{}');
    for (const col of COLS) if (Number.isFinite(widths?.[col.id])) col.w = Math.max(44, Math.min(1000, widths[col.id]));
  } catch { /* use default widths */ }
  function restoreScroll() {
    let saved = {};
    try { saved = JSON.parse(appState.getItem('pm-grid-scroll') || '{}') || {}; } catch { /* no saved scroll */ }
    gx.scrollLeft = Number(saved[store.wb.active]) || 0;
    restoringScroll = false;
  }

  // ---- column visibility (persisted). Hidden columns keep their letters, like a spreadsheet. ----
  const HKEY = 'pm-hidden-cols';
  let hidden = new Set();
  try { const sv = appState.getItem(HKEY); hidden = new Set(sv == null ? ['email'] : JSON.parse(sv)); } catch { hidden = new Set(['email']); }
  hidden.delete('name');
  const shownCol = (c) => !hidden.has(c.id) && (!c.dly || !!ctx.delay?.colVisible(c.id));
  const VIS = () => COLS.filter(shownCol);
  const edge = (c) => {
    const g = GROUPS.find((x) => x.id === c.group); if (!g || !g.hl) return '';
    const v = VIS().filter((x) => x.group === c.group);
    return (v[0] === c ? ' hl-l' : '') + (v[v.length - 1] === c ? ' hl-r' : '');
  };

  const tpl = () => `44px ${VIS().map((c) => `${c.w}px`).join(' ')}`;
  const applyTpl = () => { inner.style.setProperty('--tpl', tpl()); gx.style.setProperty('--frz', `${44 + (VIS()[0]?.w || 0) + 6}px`); inner.style.width = `${44 + VIS().reduce((a, c) => a + c.w, 0)}px`; };

  function renderHead() {
    const key = `${ui.col}|${[...hidden].join(',')}|${ctx.delay?.colKey() ?? ''}`;
    if (key === headKey) return; headKey = key;
    let b = '<div class="c"></div>', ci = 2;
    for (const g of GROUPS) {
      const n = VIS().filter((c) => c.group === g.id).length;
      if (!n) continue;
      const cls = g.hl ? ' hl hl-l hl-r' : '';
      b += `<div class="c${cls}" style="grid-column:${ci} / span ${n}">${g.label}</div>`; ci += n;
    }
    setHTML(band, b);
    setHTML(letters, '<div class="c"></div>' + VIS().map((c) => `<div class="c${c.id === ui.col ? ' sel' : ''}" data-i="${COLS.indexOf(c)}">${c.letter}<i class="rs" data-i="${COLS.indexOf(c)}"></i></div>`).join(''));
    setHTML(head, '<div class="c rn">1</div>' + VIS().map((c) => `<div class="c${c.num ? ' num' : ''}${c.ctr ? ' ctr' : ''}${c.id === ui.col ? ' sel' : ''}">${c.label}</div>`).join(''));
  }

  function raw(id, col) {
    const t = store.byId.get(id), f = store.info.get(id);
    switch (col) {
      case 'name': return t.name;
      case 'start': return fmtISO(f.start);
      case 'end': return fmtISO(t.ms && !f.summary ? t.start : f.end - 1);
      case 'dur': return String(store.duration(id));
      case 'progress': return String(Math.round(f.progress));
      case 'float': return f.float == null ? '' : String(f.float);
      case 'freeFloat': return f.freeFloat == null ? '' : String(f.freeFloat);
      case 'pred': return store.predText(id);
      case 'owner': return t.owner;
      case 'email': return t.email || '';
      default: return '';
    }
  }

  function cell(t, f, c, maxDur) {
    const sel = t.id === ui.selId && c.id === ui.col;
    const hl = edge(c);
    let cls = 'c' + (sel ? ' sel' : '') + hl + (c.num ? ' num' : '') + (c.ctr ? ' ctr' : ''), style = '', html = '';
    const dur = store.duration(t.id);
    switch (c.id) {
      case 'name':
        cls += ' nm' + (t.calendar && !f.summary ? ' has-task-calendar' : ''); style = `padding-left:${9 + t.level * 16}px`;
        html = (f.summary ? `<span class="tog${store.collapsed.has(t.id) ? '' : ' open'}">▸</span>` : '<span class="tog sp"></span>') + (t.ms ? '<i class="dm"></i>' : '') + `<span class="t">${esc(t.name)}</span>` + (ctx.delay?.nameBadges(t, f) ?? '') + (!f.summary ? `<span class="schedule-badge ${store.scheduling(t.id).mode}" title="${esc(store.scheduling(t.id).detail)}" aria-label="${esc(store.scheduling(t.id).label)}">${store.scheduling(t.id).mark}</span>` : '');
        if (t.calendar && !f.summary) html += '<span class="task-calendar-marker" role="img" aria-label="Custom task calendar active" title="Custom task calendar active. Right-click → Task calendar to inspect or change it."></span>';
        break;
      case 'start': html = fmtDate(f.start); break;
      case 'end': html = fmtDate(t.ms && !f.summary ? t.start : f.end - 1); break;
      case 'dur': if (t.ms && !f.summary) { html = '◆'; cls += ' dim'; } else { cls += ' heat'; style = heat(dur / maxDur * 0.9); html = dur; } break;
      case 'progress': { const p = Math.round(f.progress); cls += ' heat'; style = p ? heat(p / 100) : ''; html = p ? p + '%' : '<span style="color:#b6c0d0">·</span>'; break; }
      case 'float': case 'freeFloat': {
        const value = c.id === 'float' ? f.float : f.freeFloat;
        cls += ' slack-cell';
        if (value == null) { cls += ' dim'; html = '·'; }
        else { cls += value < 0 ? ' neg' : value === 0 ? ' zero' : ' pos'; html = value; }
        break;
      }
      case 'trend': cls += ' spark'; html = spark(f); break;
      case 'pred': html = esc(store.predText(t.id)) || '<span style="color:#cbd5e1">—</span>'; break;
      case 'email': html = esc(t.email || '') || '<span style="color:#cbd5e1">—</span>'; break;
      case 'agreedO': case 'agreed': case 'var': case 'origin': case 'cause': { const d = ctx.delay.cell(t, f, c.id); cls += d.cls; html = d.html; break; }
      case 'owner': if (t.owner) { const h = [...t.owner].reduce((a, ch) => a + ch.charCodeAt(0), 0); html = `<span class="chip"><span class="av" style="background:${AV[h % AV.length]}">${esc(t.owner.split(' ').map((w) => w[0]).join('').slice(0, 2))}</span>${esc(t.owner)}</span>`; } break;
    }
    const slack = c.id === 'float' || c.id === 'freeFloat';
    return `<div class="${cls}"${slack ? ` title="${esc(c.label + ': ' + slackLabel(f, c.id === 'freeFloat') + '. Click or press Enter for details.')}" aria-haspopup="dialog"` : ''} role="gridcell"${sel ? ' aria-selected="true"' : ''} data-col="${c.id}"${style ? ` style="${style}"` : ''}${c.id === 'owner' && t.email ? ` title="${esc(t.email)}"` : ''}>${html}</div>`;
  }

  // Rows are diffed against what is already on screen: while dragging a bar only the few rows whose text changed are re-parsed,
  // instead of rebuilding (and re-laying-out) the whole grid on every pointer move.
  let shown = new Map(), shownIds = '', shownKey = '', totEl = null, totShown = '';
  const scratch = document.createElement('div');
  function parseRows(list) { setHTML(scratch, list.join('')); return [...scratch.children]; }
  function paintRows(rowHtml, totHtml) {
    const key = `${VIS().map((c) => c.id).join()}`, ids = rowHtml.map((r) => r[0]).join();
    if (key !== shownKey || ids !== shownIds || !totEl || !totEl.isConnected) { // structure changed: rebuild everything
      setHTML(body, rowHtml.map((r) => r[1]).join('') + totHtml + '<div class="pad"></div>');
      shown = new Map(); body.querySelectorAll(':scope > .r[data-id]').forEach((el, i) => shown.set(rowHtml[i][0], { el, html: rowHtml[i][1] }));
      totEl = body.querySelector(':scope > .r.tot'); totShown = totHtml; shownKey = key; shownIds = ids; return;
    }
    const changed = rowHtml.filter(([id, html]) => shown.get(id).html !== html);
    if (changed.length) {
      const fresh = parseRows(changed.map((c) => c[1]));
      changed.forEach(([id, html], i) => { const o = shown.get(id); o.el.replaceWith(fresh[i]); shown.set(id, { el: fresh[i], html }); });
    }
    if (totHtml !== totShown) { const [el] = parseRows([totHtml]); totEl.replaceWith(el); totEl = el; totShown = totHtml; }
  }

  function render() {
    if (editing) return;
    applyTpl(); renderHead();
    const rows = store.rows;
    let maxDur = 1; for (const t of store.tasks) { const f = store.info.get(t.id); if (!f.summary) maxDur = Math.max(maxDur, store.duration(t.id)); }
    const rowHtml = [];
    for (const t of rows) {
      const f = store.info.get(t.id);
      rowHtml.push([t.id, `<div role="row" class="r${ctx.relClass(t.id)}${t.id === ui.selId ? ' on' : ''}${f.summary ? ' sum' : ''}${f.critical && store.critical && !f.summary ? ' crit' : ''}" data-id="${t.id}" aria-level="${t.level + 1}"${f.summary ? ` aria-expanded="${!store.collapsed.has(t.id)}"` : ''}><div class="c rn" data-col="rn">${store.readOnly ? '' : '<span class="row-handle" aria-hidden="true" title="Drag to reorder; drop in the middle of a row to nest">⠿</span>'}<span>${f.i + 2}</span></div>${VIS().map((c) => cell(t, f, c, maxDur)).join('')}</div>`]);
    }
    const P = store.project, pd = store.work.count(P.start, P.end);
    let tot = '<div class="c rn">Σ</div>';
    const allProg = (() => { let w = 0, s = 0; for (const t of store.tasks) { const f = store.info.get(t.id); if (f.summary) continue; const wt = Math.max(t.dur, 0.0001); w += wt; s += wt * t.progress; } return w ? s / w : 0; })();
    for (const c of VIS()) {
      let v = '', st = '', cl = `c${c.num ? ' num' : ''}${c.ctr ? ' ctr' : ''}${edge(c)}`;
      if (c.id === 'name') v = 'Project total';
      else if (c.id === 'start') v = fmtDate(P.start);
      else if (c.id === 'end') v = fmtDate(P.end - 1);
      else if (c.id === 'dur') v = pd;
      else if (c.id === 'progress') { cl += ' heat'; st = heat(allProg / 100 * 0.95 + 0.1); v = Math.round(allProg) + '%'; }
      else if (c.id === 'float') { cl += ' zero'; v = store.critCount + ' crit'; }
      else if (c.dly) { const T = ctx.delay.total(c.id); v = T.html; cl += T.cls; }
      else if (c.id === 'owner') v = new Set(store.tasks.map((t) => t.owner).filter(Boolean)).size + ' people';
      tot += `<div class="${cl}"${st ? ` style="${st}"` : ''}>${v}</div>`;
    }
    const totHtml = `<div class="r tot">${tot}</div>`;
    paintRows(rowHtml, totHtml);
    // name box + formula bar
    const col = COLS.find((c) => c.id === ui.col), has = ui.selId != null && store.info.has(ui.selId);
    namebox.textContent = has ? col.letter + store.rowNum(ui.selId) : 'A1';
    fxin.readOnly = ui.col === 'float' || ui.col === 'freeFloat';
    if (document.activeElement !== fxin) fxin.value = has ? raw(ui.selId, ui.col) : '';
  }

  // ---- editing ----
  function startEdit(id, col, initial) {
    if (editing) return;
    if (col === 'float' || col === 'freeFloat') { if (initial == null) ctx.slack.open(id); return; }
    if (store.readOnly) { store.emit('denied'); return; }
    const c = COLS.find((x) => x.id === col); if (!c || c.spark || c.dly) return;
    const f = store.info.get(id);
    if (f.summary && ['end', 'dur', 'progress', 'pred'].includes(col)) { ctx.toast('Computed from child tasks'); return; }
    const el = body.querySelector(`.r[data-id="${id}"] .c[data-col="${col}"]`); if (!el) return;
    const inp = document.createElement('input'); inp.className = 'editor';
    inp.value = initial ?? raw(id, col); el.appendChild(inp); inp.focus();
    if (initial == null) inp.select(); else inp.setSelectionRange(inp.value.length, inp.value.length);
    editing = { id, col, inp };
    let picked = null, unpick = null;
    const finish = (commit, move) => {
      if (!editing) return; const e = editing; editing = null; commitEditing = null;
      const val = e.inp.value; e.inp.remove(); unpick?.();
      if (commit && picked) store.setOwner(e.id, picked.name, picked.email);
      else if (commit && val !== raw(e.id, e.col)) { const err = store.setCell(e.id, e.col, val); if (err) ctx.toast(err); }
      if (move) { render(); move(); } else ctx.requestRender();
      if (document.activeElement?.tagName === 'INPUT') document.activeElement.blur();
    };
    commitEditing = () => finish(true);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Enter') { e.preventDefault(); finish(true); ctx.insertTask(e.shiftKey); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true, () => moveSel(1, 0)); }
      else if (e.key === 'Tab') { e.preventDefault(); const d = e.shiftKey ? -1 : 1; finish(true, () => moveSel(0, d)); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    if (col === 'owner' && ctx.people) unpick = ctx.people.attach(inp, (p, ev) => { // Enter/Tab on a suggestion behaves like Enter/Tab in any cell: commit, then move on
      picked = p; inp.value = p.name;
      finish(true, ev && ev.key === 'Enter' ? () => moveSel(1, 0) : ev && ev.key === 'Tab' ? () => moveSel(0, ev.shiftKey ? -1 : 1) : undefined);
    });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('input', () => { fxin.value = inp.value; });
  }

  function moveSel(dr, dc) {
    const rows = store.rows; if (!rows.length) return;
    let ri = rows.findIndex((t) => t.id === ui.selId); if (ri < 0) ri = 0;
    const vc = VIS();
    let ci = vc.findIndex((c) => c.id === ui.col); if (ci < 0) ci = 0;
    ri = Math.max(0, Math.min(rows.length - 1, ri + dr)); ci = Math.max(0, Math.min(vc.length - 1, ci + dc));
    ctx.select(rows[ri].id, vc[ci].id, true);
  }

  // ---- events ----
  body.addEventListener('click', (e) => {
    const tog = e.target.closest('.tog:not(.sp)'), r = e.target.closest('.r[data-id]'); if (!r) return;
    const id = +r.dataset.id;
    if (tog) { store.toggle(id); return; }
    const c = e.target.closest('.c'); if (c && c.dataset.col && !c.querySelector('.editor')) { gx.focus({ preventScroll: true }); ctx.select(id, c.dataset.col === 'rn' ? ui.col : c.dataset.col); }
    if (c && (c.dataset.col === 'float' || c.dataset.col === 'freeFloat')) { ctx.slack.open(id); return; }
    // the first click re-renders the rows, which can swallow the browser's dblclick: use the click count instead
    if (e.detail >= 2 && c && c.dataset.col && c.dataset.col !== 'rn') startEdit(id, c.dataset.col);
  });
  body.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.r[data-id]'), c = e.target.closest('.c[data-col]');
    if (r && c && c.dataset.col !== 'rn' && !e.target.closest('.tog')) startEdit(+r.dataset.id, c.dataset.col);
  });
  function rememberScroll() {
    if (restoringScroll) return;
    let saved = {};
    try { const value = JSON.parse(appState.getItem('pm-grid-scroll') || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch { /* no saved scroll */ }
    saved[store.wb.active] = gx.scrollLeft;
    appState.setItem('pm-grid-scroll', JSON.stringify(saved));
  }
  gx.addEventListener('scroll', () => { gx.classList.toggle('scrolled', gx.scrollLeft > 0); ctx.syncGantt(gx.scrollTop); });
  gx.addEventListener('scrollend', rememberScroll);
  window.addEventListener('pm-flush-view', rememberScroll);

  letters.addEventListener('pointerdown', (e) => {
    const rs = e.target.closest('.rs');
    if (!rs) { const c = e.target.closest('.c[data-i]'); if (c && ui.selId != null) ctx.select(ui.selId, COLS[+c.dataset.i].id); return; }
    const col = COLS[+rs.dataset.i], x0 = e.clientX, w0 = col.w;
    rs.setPointerCapture(e.pointerId);
    const mv = (ev) => { col.w = Math.max(44, w0 + ev.clientX - x0); applyTpl(); };
    const up = () => {
      rs.removeEventListener('pointermove', mv); rs.removeEventListener('lostpointercapture', up);
      appState.setItem('pm-column-widths', JSON.stringify(Object.fromEntries(COLS.map((item) => [item.id, item.w]))));
    };
    rs.addEventListener('pointermove', mv); rs.addEventListener('lostpointercapture', up);
  });

  let fxcancel = false;
  fxin.addEventListener('focus', () => { fxcancel = false; });
  fxin.addEventListener('blur', () => {
    if (fxcancel || ui.selId == null || !store.info.has(ui.selId)) return;
    if (fxin.value !== raw(ui.selId, ui.col)) { const err = store.setCell(ui.selId, ui.col, fxin.value); if (err) ctx.toast(err); }
  });
  fxin.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Enter') {
      e.preventDefault();
      if (ui.selId != null) { const err = store.setCell(ui.selId, ui.col, fxin.value); if (err) { ctx.toast(err); e.stopPropagation(); return; } }
      fxcancel = true; fxin.blur(); ctx.insertTask(e.shiftKey);
    }
    else if (e.key === 'Enter' && ui.selId != null) { const err = store.setCell(ui.selId, ui.col, fxin.value); if (err) ctx.toast(err); fxcancel = true; fxin.blur(); render(); }
    else if (e.key === 'Escape') { fxcancel = true; fxin.value = ui.selId != null ? raw(ui.selId, ui.col) : ''; fxin.blur(); render(); }
    e.stopPropagation();
  });

  // ---- column picker ----
  const colbtn = $('#colbtn'), colpop = $('#colpop');
  function fillColPop() {
    const rows = COLS.filter((c) => !c.dly || ctx.delay?.colVisible(c.id)).map((c) => {
      const locked = c.id === 'name', on = !hidden.has(c.id);
      return `<label class="ci${locked ? ' lock' : ''}"><input type="checkbox" data-c="${c.id}"${on ? ' checked' : ''}${locked ? ' disabled' : ''}><i></i><span class="cl">${c.letter}</span><span class="cn">${esc(c.label)}</span></label>`;
    }).join('');
    setHTML(colpop, `<div class="ttl"><b>Columns</b><button data-all="1">Show all</button></div>${rows}<div class="ttl foot">${VIS().length} of ${COLS.filter((c) => !c.dly || ctx.delay?.colVisible(c.id)).length} shown</div>`);
  }
  function applyCols() {
    try { appState.setItem(HKEY, JSON.stringify([...hidden])); } catch { /* storage unavailable */ }
    if (hidden.has(ui.col)) ui.col = 'name';
    headKey = ''; fillColPop(); render(); ctx.requestRender();
  }
  colbtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!colpop.hidden) { colpop.hidden = true; return; }
    fillColPop(); colpop.hidden = false;
    const r = colbtn.getBoundingClientRect();
    colpop.style.left = `${Math.max(8, Math.min(r.right - 220, innerWidth - 232))}px`; colpop.style.top = `${r.bottom + 6}px`;
  });
  colpop.addEventListener('change', (e) => {
    const id = e.target.dataset.c; if (!id) return;
    if (e.target.checked) hidden.delete(id); else hidden.add(id);
    applyCols();
  });
  colpop.addEventListener('click', (e) => { if (e.target.dataset.all) { hidden.clear(); applyCols(); } });
  document.addEventListener('pointerdown', (e) => { if (!colpop.hidden && !colpop.contains(e.target) && !colbtn.contains(e.target)) colpop.hidden = true; }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') colpop.hidden = true; });

  return { render, startEdit, commitEdit: () => commitEditing?.(), moveSel, restoreScroll, resetScroll: () => { restoringScroll = true; }, setScrollTop: (v) => { if (gx.scrollTop !== v) gx.scrollTop = v; }, scrollIntoView: () => body.querySelector('.c.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), isEditing: () => !!editing, invalidateHead: () => { headKey = ''; } };
}
