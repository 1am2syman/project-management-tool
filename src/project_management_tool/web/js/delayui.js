// Delay accounting on screen: the sheet's agreed / variance columns, the Gantt layer, the record popover, the agreed-deadline,
// inclusion and omission dialogs, version types and Settings -> Delay causes. All numbers come from delays.js.
import { fmtDate, fmtISO, today, parseDate, DAY } from './model.js';
import { esc, setHTML, setSVG, openModal } from './dom.js';
import { dims } from './dims.js';
import * as DL from './delays.js';
import { loadCauses, saveCauses } from './causes.js';

const { sign } = DL;
const pl = (n, w) => `${n} ${w}${Math.abs(n) === 1 ? '' : 's'}`;
const NS = 'http://www.w3.org/2000/svg';
const TYPE_ORDER = ['baseline', 'status', 'draft'];

export function createDelayUI(ctx) {
  const { store } = ctx;
  const $ = (s) => document.querySelector(s);
  const api = {};
  let causes = loadCauses(), pop = null, layer = null, layerMarkup = '', vis = { any: false, rev: false };
  const editable = () => !store.readOnly && !store.stale;
  const refreshCauses = () => { causes = loadCauses(); };

  // Anything that moves an agreed task past its agreed date is watched: the record popover opens after it.
  store.hook = { before: () => (editable() && DL.hasAgreed(store) ? DL.snapshotBefore(store) : null), after: (e) => afterEdit(e) };
  store.on((kind) => { if (kind === 'sheet' || kind === 'version') closePop(); });

  // ---------------------------------------------------------------- sheet columns
  api.refresh = () => { vis = { any: DL.hasAgreed(store), rev: DL.hasAgreed(store) && DL.hasRevision(store) }; };
  api.colVisible = (id) => (id === 'agreedO' ? vis.rev : vis.any);
  api.colKey = () => `${vis.any ? 1 : 0}${vis.rev ? 1 : 0}`;
  api.revised = () => vis.rev;
  api.hasAgreed = () => vis.any;
  api.cell = (t, f, col) => {
    const r = DL.row(store, t.id);
    if (t.inc && col === 'agreed') return { cls: ' dly-c', html: '<span class="dly-chip pend" title="Added after agreement. Agree it to include it in the plan.">Pending</span>' };
    if (!r) return { cls: ' dly-c dim', html: f.summary ? '' : '·' };
    const dim = r.rollup ? ' dly-roll' : '';
    if (col === 'agreedO') return { cls: ` dly-c${dim}`, html: r.orig !== r.agreed ? fmtDate(r.orig) : '<span class="dly-dot">·</span>' };
    if (col === 'agreed') return { cls: ` dly-c${dim}`, html: fmtDate(r.agreed) };
    if (col === 'var') return { cls: ` dly-c num${dim}`, html: `<span class="dly-var ${r.v > 0 ? 'late' : r.v < 0 ? 'early' : 'zero'}">${r.v ? sign(r.v) : '0'}</span>` };
    if (r.rollup) return { cls: ' dly-c', html: '' };
    if (col === 'origin') {
      let h = '';
      if (r.own) h += `<span class="dly-chip own" title="${r.own > 0 ? 'Delay that started at this task' : 'Recovered against the agreed date'}">Own ${sign(r.own)}</span>`;
      if (r.inherited) h += `<span class="dly-chip inh" title="Delay inherited from an earlier task">Inherited ${sign(r.inherited)}</span>`;
      if (r.pend) h += `<span class="dly-chip pend" title="Pushed by new work that is not agreed yet; not a delay">Pending inclusion ${sign(r.pend)}</span>`;
      return { cls: ' dly-c', html: h };
    }
    if (col === 'cause') {
      const e = DL.lastDelay(store, t.id);
      if (r.own > 0) return { cls: ' dly-c', html: e?.cause ? `<span class="dly-cause">${esc(DL.causeName(causes, e.cause))}${causes.list.find((c) => c.id === e.cause)?.retired ? ' <em>(retired)</em>' : ''}${e.party ? `<i> · ${esc(e.party)}</i>` : ''}</span>` : '<span class="dly-nocause">Unclassified delay</span>' };
      if (r.inherited && r.source != null) { const o = DL.originOf(store, r.source), src = DL.lastDelay(store, o); return { cls: ' dly-c', html: `<span class="dly-cause inh">↳ ${esc(DL.nameOf(store, o))}${src?.cause ? ` · ${esc(DL.causeName(causes, src.cause))}` : ''}</span>` }; }
      if (r.pend) return { cls: ' dly-c', html: `<span class="dly-cause inh">↳ ${esc(DL.nameOf(store, r.pendSource))} (pending)</span>` };
    }
    return { cls: ' dly-c', html: '' };
  };
  api.total = (id) => {
    const c = DL.completion(store); if (!c) return { html: '', cls: '' };
    if (id === 'agreed') return { html: fmtDate(c.f), cls: '' };
    if (id === 'agreedO') return { html: c.o !== c.f ? fmtDate(c.o) : '', cls: '' };
    if (id === 'var') return { html: `<span class="dly-var ${c.delay > 0 ? 'late' : c.delay < 0 ? 'early' : 'zero'}">${c.delay ? sign(c.delay) : '0'}</span>`, cls: ' num' };
    return { html: '', cls: '' };
  };
  api.nameBadges = (t, f) => (!f.summary && t.inc ? '<span class="dly-chip pend" title="Added after agreement">Inclusion · pending</span>' : '');
  api.statusHtml = () => {
    const c = DL.completion(store); if (!c) return '';
    const v = c.delay;
    return `<span class="dly-stat" title="Agreed finish ${fmtDate(c.f)} · expected ${fmtDate(c.expected)}">Agreed <b>${fmtDate(c.f)}</b> · <b class="${v > 0 ? 'late' : v < 0 ? 'early' : ''}">${v ? `${sign(v)}d` : 'on time'}</b>${c.pend ? ` · pending inclusion ${sign(c.pend)}d` : ''}</span>`;
  };

  // ---------------------------------------------------------------- Gantt
  api.shade = (id) => (vis.any ? DL.ganttModel(store, id)?.shade ?? null : null);
  api.tooltip = (id) => {
    if (!vis.any) return '';
    const x = DL.explain(store, id, causes); if (!x || !x.parts.length) return '';
    return `\n${x.head}\n${x.parts.join('\n')}`;
  };
  function ensureLayer(canvas) {
    if (layer?.isConnected) return layer;
    layer = document.createElementNS(NS, 'svg'); layer.setAttribute('class', 'dly-layer'); layer.setAttribute('aria-hidden', 'true'); layerMarkup = '';
    canvas.appendChild(layer); return layer;
  }
  api.decorate = (g) => {
    const L = ensureLayer(g.canvas);
    L.setAttribute('width', g.W); L.setAttribute('height', g.H);
    let out = '';
    if (vis.any) {
      const rowH = dims.row, barH = dims.bar;
      store.rows.forEach((t, i) => {
        const f = store.info.get(t.id), a = t.agr;
        if (f.summary || !a) return;
        const top = i * rowH + (rowH - barH) / 2, cy = i * rowH + rowH / 2;
        if (t.ms) {
          const x = g.xOf(a.f), s = dims.msz * 0.5 + 3;
          out += `<path class="dly-agr-ms" d="M${x} ${cy - s - 2}L${x + s + 2} ${cy}L${x} ${cy + s + 2}L${x - s - 2} ${cy}Z"><title>Agreed ${fmtDate(a.f)}</title></path>`;
        } else {
          const ax = g.pixel(g.xOf(a.f + 1)) - 1;
          out += `<path class="dly-agr" d="M${ax - 5} ${top - 5}L${ax + 5} ${top - 5}L${ax} ${top + 1}Z"><title>Agreed finish ${fmtDate(a.f)}</title></path>`;
        }
        const od = DL.overdue(store, t.id);
        if (od) { const bx = g.pixel(g.xOf(f.end)) + 8, w = 122; out += `<g class="dly-od-g" data-dly-overdue="${t.id}" role="button" aria-label="${esc(t.name)}: overdue ${od} days, update?"><rect x="${bx}" y="${cy - 9}" width="${w}" height="18" rx="9"/><text x="${bx + w / 2}" y="${cy + 3.5}" text-anchor="middle">Overdue ${od}d · update?</text></g>`; }
        const m = DL.ganttModel(store, t.id);
        if (m?.leadIn) out += `<line class="dly-lead" x1="${g.pixel(g.xOf(m.leadIn.from)) + 1}" x2="${g.pixel(g.xOf(m.leadIn.to)) + 1}" y1="${cy}" y2="${cy}"/><circle class="dly-lead-dot" cx="${g.pixel(g.xOf(m.leadIn.from)) + 1}" cy="${cy}" r="2.5"/>`;
      });
    }
    if (out !== layerMarkup) { layerMarkup = out; setSVG(layer, out); }
  };
  // the Gantt layer is redrawn as the pointer goes down, so the Overdue chip reacts to the press itself
  document.addEventListener('pointerdown', (e) => { const b = e.target.closest?.('.dly-od-g'); if (b) { e.stopPropagation(); e.preventDefault(); api.openOverdue(+b.dataset.dlyOverdue); } }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) { e.stopPropagation(); closePop(true); } }, true);

  // ---------------------------------------------------------------- the record popover
  function closePop(undo = false) { if (!pop) return; const p = pop; pop = null; p.el.remove(); if (undo && p.o.undo) p.o.undo(); }
  api.closePop = closePop;
  api.popOpen = () => !!pop;
  // Cancel and Escape take back only the edit that opened the popover: if the user has changed anything since, just dismiss it.
  const ownUndo = () => { const n = store.undoStack.length, top = store.undoStack.at(-1); return () => { if (store.undoStack.length === n && store.undoStack.at(-1) === top) store.undo(); }; };
  function afterEdit({ id, kind, pre }) {
    if (!pre || !editable()) return;
    let target = id;
    if (kind === 'link') { // the first agreed task the link pushed past its agreed date
      target = null;
      for (const t of DL.leaves(store)) { if (t.agr && pre.fins.has(t.id) && DL.fin(store, t.id) > pre.fins.get(t.id) && DL.fin(store, t.id) > t.agr.f) { target = t.id; break; } }
      if (target == null) return;
    }
    const t = store.byId.get(target), a = t?.agr;
    if (!t || !a || store.info.get(target).summary) return;
    const old = pre.fins.get(target), now = DL.fin(store, target);
    if (old == null || !(now > a.f) || !(now > old)) return;
    let pushed = 0;
    for (const k of DL.leaves(store)) if (k.id !== target && k.agr && pre.fins.has(k.id) && DL.fin(store, k.id) > pre.fins.get(k.id)) pushed++;
    const op = kind === 'start' || kind === 'move' || kind === 'link' || t.ms ? 'start' : 'finish';
    openPopover({ id: target, op, old, now, pushed, finish: Math.max(0, DL.wd(store, pre.end, DL.endDay(store))), oldStart: pre.starts.get(target), newStart: store.info.get(target).start, pre, anchor: op === 'start' && kind !== 'link', undo: ownUndo() });
  }
  api.openOverdue = (id) => {
    if (!editable()) return;
    ctx.select(id, 'name', true);
    // The app moves nothing by itself: the chip only opens the popover, prefilled with today as the new expected finish.
    const old = DL.fin(store, id), f = store.info.get(id);
    openPopover({ id, op: 'finish', old, now: Math.max(today, old + 1), pushed: 0, finish: 0, oldStart: f.start, newStart: f.start, overdue: true });
  };
  function openPopover(o) {
    closePop();
    const a = store.byId.get(o.id).agr, t = store.byId.get(o.id), w = (x, y) => DL.wd(store, x, y, o.id);
    const days = w(o.old, o.now), beyond = w(Math.max(o.old, a.f), o.now);
    const newAgreed = store.workFor(t).shift(a.f, beyond);
    const el = document.createElement('div'); el.className = 'dly-pop'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Record why this finish moved');
    const active = DL.activeCauses(causes), unit = t.ms ? 'Date' : 'Finish';
    const head = (oldF, newF, oldS, newS, d) => `<b>${!t.ms && oldS !== newS ? `Start ${fmtDate(oldS)} → ${fmtDate(newS)} · ` : ''}${unit} ${fmtDate(oldF)} → ${fmtDate(newF)}</b><span class="dly-days">${sign(d)} working days</span>`;
    const overdueField = o.overdue ? `<label class="fld dly-newfin"><span>New expected finish</span><input data-f="newfin" value="${fmtISO(o.now)}" autocomplete="off" aria-label="New expected finish"><em>Prefilled with today. Type a later date if you expect more.</em></label>` : '';
    setHTML(el, `<div class="dly-h" data-head>${head(o.old, o.now, o.oldStart, o.newStart, days)}<button class="dly-x" data-cancel aria-label="Cancel">×</button></div>
      ${overdueField}
      <div class="dly-sub">${esc(t.name)} · Agreed ${unit.toLowerCase()} ${fmtDate(a.f)}</div>
      <div class="dly-opt on" data-mode="delay"><label><input type="radio" name="dlymode" value="delay" checked><span><b>Delay</b>: keep agreed ${fmtDate(a.f)}</span></label>
        <div class="dly-fields"><label class="fld"><span>Kind</span><select data-f="kind">${DL.KINDS.map((k) => `<option${k === (o.op === 'start' ? 'Late start' : 'Overrun') ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="fld"><span>Cause</span><select data-f="cause"><option value="">Choose a cause…</option>${active.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>Party</span><input data-f="party" placeholder="Who or what caused it" autocomplete="off" maxlength="80"></label></div></div>
      <div class="dly-opt" data-mode="revision"><label><input type="radio" name="dlymode" value="revision"><span><b>Revision</b>: agree new ${unit.toLowerCase()} ${fmtDate(newAgreed)} <i>(${sign(beyond)})</i></span></label>
        <div class="dly-fields"><label class="fld"><span>Reason</span><input data-f="reason" placeholder="Why the plan changes" autocomplete="off" maxlength="500"></label>
        <label class="fld"><span>Approved by</span><input data-f="approved" placeholder="Name" autocomplete="off" maxlength="120"></label></div></div>
      <label class="fld dly-note"><span>Note (optional)</span><input data-f="note" autocomplete="off" maxlength="500"></label>
      <div class="dly-effect" data-effect>${o.overdue ? 'Nothing moves until you record.' : effectText(o.pushed, o.finish)}</div>
      <p class="set-err" role="alert"></p>
      <div class="dly-actions"><button data-skip title="Record the delay without a cause">Skip reason</button><span class="grow"></span><button data-cancel>Cancel</button><button class="primary" data-record>Record</button></div>`);
    document.body.appendChild(el);
    pop = { el, o };
    const mode = () => el.querySelector('input[name=dlymode]:checked').value, f = (k) => el.querySelector(`[data-f=${k}]`);
    const err = (m) => { el.querySelector('.set-err').textContent = m; };
    el.addEventListener('change', (e) => { if (e.target.name === 'dlymode') for (const b of el.querySelectorAll('.dly-opt')) b.classList.toggle('on', b.dataset.mode === e.target.value); });
    el.addEventListener('pointerdown', (e) => { const opt = e.target.closest('.dly-opt'); if (opt && !e.target.closest('label')) { const r = opt.querySelector('input[type=radio]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } });
    const typed = () => { const v = f('newfin')?.value.trim(); return v ? parseDate(v, o.old) : null; };
    const finish = (entry) => {
      if (o.overdue) { // apply the typed date now, then record why; the task keeps its scheduling mode
        const d = typed(); if (d == null || d <= Math.max(o.old, a.f)) return err(`Type a finish date after ${fmtDate(Math.max(o.old, a.f))}.`);
        o.pre = DL.snapshotBefore(store);
        const e = store.applyCell(o.id, 'end', fmtISO(d)); if (e) return err(e);
        o.now = DL.fin(store, o.id);
      }
      const e = DL.record(store, o.id, o.pre, { ...entry, op: o.op }, { anchor: !!o.anchor });
      if (e) return err(e);
      closePop();
      ctx.toast(entry.type === 'revision' ? `Revision recorded · agreed ${fmtDate(store.byId.get(o.id).agr.f)}` : entry.cause ? `Delay recorded · ${sign(DL.lastDelay(store, o.id)?.days ?? days)}d ${DL.causeName(causes, entry.cause)}` : `Delay recorded without a cause · classify it from the task menu`);
      ctx.requestRender();
    };
    if (o.overdue) {
      const upd = () => {
        const d = typed(), bad = d == null || d <= Math.max(o.old, a.f), h = el.querySelector('[data-head]');
        h.querySelector('b').textContent = `Finish ${fmtDate(o.old)} → ${bad ? '…' : fmtDate(d)}`;
        h.querySelector('.dly-days').textContent = bad ? '' : `${sign(w(o.old, d))} working days`;
        if (bad) return;
        const fx = DL.whatIfFinish(store, o.id, d);
        el.querySelector('[data-effect]').textContent = effectText(fx.pushed, fx.finish);
      };
      f('newfin').addEventListener('input', upd); upd();
    }
    el.querySelector('[data-record]').addEventListener('click', () => {
      if (mode() === 'revision') {
        if (!f('reason').value.trim()) return err('Say why the plan changes.');
        if (!f('approved').value.trim()) return err('Type who approved the revision.');
        finish({ type: 'revision', reason: f('reason').value.trim(), approvedBy: f('approved').value.trim(), note: f('note').value.trim() });
      } else {
        if (!f('cause').value) return err('Choose a cause, or use Skip reason.');
        finish({ type: 'delay', kind: f('kind').value, cause: f('cause').value, party: f('party').value.trim(), note: f('note').value.trim() });
      }
    });
    el.querySelector('[data-skip]').addEventListener('click', () => finish({ type: 'delay', kind: f('kind').value, cause: null, party: '', note: '' }));
    for (const b of el.querySelectorAll('[data-cancel]')) b.addEventListener('click', () => closePop(!o.overdue));
    if (ctx.people) { const inp = f('party'); let stop = null; inp.addEventListener('focus', () => { stop?.(); stop = ctx.people.attach(inp, (p) => { inp.value = p.name; }); }); }
    // Place it beside the edited bar without covering it: below, above, to the right, to the left, then over the sheet.
    const row = $(`.bar[data-id="${o.id}"]`) || $(`#gbody .r[data-id="${o.id}"]`), rr = row?.getBoundingClientRect(), vw = innerWidth, vh = innerHeight, width = 540, h = el.offsetHeight;
    const clampX = (x) => Math.min(Math.max(8, x), vw - width - 8), clampY = (y) => Math.min(Math.max(60, y), vh - h - 8);
    let spot = { left: (vw - width) / 2, top: 80 };
    if (rr) {
      const left = clampX(rr.left + (t.ms ? 40 : -20)), mid = clampY(rr.top + rr.height / 2 - h / 2);
      const options = [{ left, top: rr.bottom + 12 }, { left, top: rr.top - h - 12 }, { left: rr.right + 12, top: mid }, { left: rr.left - width - 12, top: mid }, { left: 8, top: mid }];
      const clear = (c) => c.left >= 8 && c.left + width <= vw - 8 && c.top >= 60 && c.top + h <= vh - 8 && (c.left + width < rr.left - 4 || c.left > rr.right + 4 || c.top + h < rr.top - 4 || c.top > rr.bottom + 4);
      spot = options.find(clear) || options.at(-1);
    }
    el.style.left = `${spot.left}px`; el.style.top = `${spot.top}px`;
    (f('cause') || el).focus();
  }
  const effectText = (pushed, finish) => `${pushed ? `Pushes ${pl(pushed, 'later task')}` : 'Pushes no later tasks'} · ${finish > 0 ? `project finish ${sign(finish)}d` : 'project finish not affected'}`;

  // Re-classify a recorded delay (cause, party, kind, note): one undo step per Save. Works on any entry of the task; with several, the
  // dialog lists them (date, kind, days, cause) and the fields follow the chosen one.
  const entryText = (e) => `${new Date(e.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${e.kind || 'Delay'} ${sign(e.days)}d · ${e.cause ? DL.causeName(causes, e.cause) : 'Unclassified'}`;
  api.editRecord = (id, entryId = null, after = null) => {
    if (!editable()) { store.emit('denied'); return; }
    if (document.querySelector('.modal[aria-label="Edit delay record"]')) return; // a double-click arrives as a click and a dblclick
    const list = entryId != null ? DL.delaysOf(store, store.log.find((x) => x.id === entryId)?.taskId ?? id) : DL.delaysOf(store, id);
    if (!list.length) { ctx.toast('No recorded delay to edit at this task'); return; }
    let e = list.find((x) => x.id === entryId) || list.at(-1);
    const taskName = (x) => esc(store.byId.get(x.taskId)?.name ?? x.taskName ?? '');
    const m = openModal('Edit delay record', `<p class="help"></p>
      ${list.length > 1 ? `<label class="fld"><span>Delay</span><select id="dly-entry">${list.map((x) => `<option value="${x.id}">${esc(entryText(x))}</option>`).join('')}</select></label>` : ''}
      <label class="fld"><span>Kind</span><select id="dly-kind"></select></label>
      <label class="fld"><span>Cause</span><select id="dly-cause"></select></label>
      <label class="fld"><span>Party</span><input id="dly-party" maxlength="80" autocomplete="off"></label>
      <label class="fld"><span>Note</span><input id="dly-note" maxlength="500" autocomplete="off"></label>
      <p class="set-err" role="alert"></p><div class="rem-actions"><span class="grow"></span><button data-cancel>Cancel</button><button class="primary" data-ok>Save</button></div>`);
    const b = m.body, q = (sel) => b.querySelector(sel);
    const fill = () => {
      setHTML(q('.help'), `<b>${taskName(e)}</b> · ${esc(e.kind || 'Delay')} ${sign(e.days)} working days`);
      setHTML(q('#dly-kind'), DL.KINDS.map((k) => `<option${k === e.kind ? ' selected' : ''}>${k}</option>`).join(''));
      // Retired causes stay selectable only for an entry that already uses them.
      setHTML(q('#dly-cause'), `<option value="">Unclassified</option>${causes.list.filter((c) => !c.retired || c.id === e.cause).map((c) => `<option value="${esc(c.id)}"${c.id === e.cause ? ' selected' : ''}>${esc(c.name)}${c.retired ? ' (retired)' : ''}</option>`).join('')}`);
      q('#dly-party').value = e.party || ''; q('#dly-note').value = e.note || ''; q('.set-err').textContent = '';
    };
    fill();
    q('#dly-entry')?.addEventListener('change', (ev) => { e = list.find((x) => x.id === +ev.target.value) || e; fill(); });
    if (ctx.people) q('#dly-party').addEventListener('focus', (ev) => ctx.people.attach(ev.target, (p) => { ev.target.value = p.name; }));
    q('[data-cancel]').addEventListener('click', () => m.close());
    q('[data-ok]').addEventListener('click', () => {
      const err = DL.reclassify(store, e.id, { kind: q('#dly-kind').value, cause: q('#dly-cause').value, party: q('#dly-party').value, note: q('#dly-note').value });
      if (err) q('.set-err').textContent = err; else { m.close(); ctx.requestRender(); after?.(); }
    });
    setTimeout(() => q('#dly-cause')?.focus(), 0);
  };
  // The Cause cell of a task (double-click, Enter or F2). A task without recorded delays of its own points at the task it inherits from.
  api.editCause = (id) => {
    if (!editable()) { store.emit('denied'); return; }
    if (DL.delaysOf(store, id).length) { api.editRecord(id); return; }
    const r = DL.row(store, id);
    ctx.toast(r?.inherited && r.source != null ? `This delay started at “${DL.nameOf(store, DL.originOf(store, r.source))}”: set its cause there` : 'No recorded delay at this task');
  };

  // ---------------------------------------------------------------- agreed dates, inclusion, omission
  api.menuHtml = (id, item) => {
    const t = store.byId.get(id), f = store.info.get(id); if (!t || f.summary || store.readOnly) return '';
    let h = '<div role="separator"></div>';
    if (DL.delaysOf(store, id).length) h += item('Edit delay record…', 'dly-edit-record', null);
    if (t.inc) h += item('Agree inclusion…', 'dly-agree-inclusion', null);
    h += item(t.agr ? 'Change agreed deadline…' : 'Set agreed deadline…', 'dly-agree-deadline', t.inc ? 'Agree the inclusion first' : store.structureError());
    return h;
  };
  api.menuAction = (action, id) => {
    if (action === 'edit-record') api.editRecord(id);
    else if (action === 'agree-deadline') agreedDialog(id, 'deadline');
    else if (action === 'agree-inclusion') agreedDialog(id, 'inclusion');
  };
  // One dialog for agreeing a single task's date: the expected date in one click, or another date from the picker.
  function agreedDialog(id, kind) {
    if (!editable()) { store.emit('denied'); return; }
    const t = store.byId.get(id), exp = DL.fin(store, id), incl = kind === 'inclusion', cur = t.agr?.f ?? null;
    const unit = t.ms ? 'date' : 'finish';
    const m = openModal(incl ? 'Agree inclusion' : t.agr ? 'Change agreed deadline' : 'Set agreed deadline', `
      <p class="help">${incl ? `Agree <b>${esc(t.name)}</b> as part of the plan. Tasks it pushes later get their agreed dates moved by the same days, so none of it counts as delay.` : `Agree a ${unit} for <b>${esc(t.name)}</b>. The plan keeps its expected date; delays are counted against the agreed one.`}</p>
      <label class="dly-choice on"><input type="radio" name="dlyd" value="expected" checked><span><b>Expected date · ${fmtDate(exp)}</b><em>${t.agr ? `Currently agreed ${fmtDate(cur)}.` : `The plan's current ${unit}.`}</em></span></label>
      <label class="dly-choice"><input type="radio" name="dlyd" value="other"><span><b>Another date</b><input id="dly-date" placeholder="Pick a date or type one" autocomplete="off" aria-label="Another agreed date"></span></label>
      <div class="dly-cal" id="dly-cal" hidden></div>
      <div class="dly-why" hidden><label class="fld"><span>Reason</span><input data-f="reason" placeholder="${incl ? 'Why the work is added' : 'Why the agreed date changes'}" autocomplete="off" maxlength="500"></label><label class="fld"><span>Approved by</span><input data-f="approved" placeholder="Name" autocomplete="off" maxlength="120"></label></div>
      <p class="set-err" role="alert"></p>
      <div class="rem-actions"><span class="grow"></span><button data-cancel>Cancel</button><button class="primary" data-ok>${incl ? 'Agree inclusion' : 'Set agreed deadline'}</button></div>`);
    const b = m.body, input = b.querySelector('#dly-date'), cal = b.querySelector('#dly-cal'), why = b.querySelector('.dly-why'), err = b.querySelector('.set-err');
    let picked = null, shown = exp;
    const radio = (v) => { b.querySelector(`input[name=dlyd][value=${v}]`).checked = true; for (const c of b.querySelectorAll('.dly-choice')) c.classList.toggle('on', c.querySelector('input').checked); update(); };
    const chosen = () => (b.querySelector('input[name=dlyd]:checked').value === 'expected' ? exp : picked);
    const update = () => { const d = chosen(); why.hidden = !(incl || (t.agr && d != null && d !== cur)); };
    const paint = () => {
      const x = new Date(shown * DAY), y = x.getUTCFullYear(), mo = x.getUTCMonth();
      const first = Date.UTC(y, mo, 1) / DAY, lead = (new Date(first * DAY).getUTCDay() + 6) % 7, n = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      let h = `<div class="dly-cal-h"><button type="button" data-nav="-1" aria-label="Previous month">‹</button><b>${new Date(first * DAY).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b><button type="button" data-nav="1" aria-label="Next month">›</button></div><div class="dly-cal-g">${'MTWTFSS'.split('').map((d) => `<i>${d}</i>`).join('')}`;
      for (let i = 0; i < lead; i++) h += '<span></span>';
      for (let d = 1; d <= n; d++) { const day = first + d - 1; h += `<button type="button" data-day="${day}" class="${day === picked ? 'on' : ''}${day === today ? ' today' : ''}">${d}</button>`; }
      setHTML(cal, h + '</div>');
    };
    input.addEventListener('focus', () => { radio('other'); cal.hidden = false; paint(); });
    input.addEventListener('click', () => { radio('other'); cal.hidden = false; paint(); });
    input.addEventListener('input', () => { const d = parseDate(input.value, exp); picked = d; if (d != null) shown = d; radio('other'); if (!cal.hidden) paint(); });
    cal.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]'); if (nav) { const d = new Date(shown * DAY); shown = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + +nav.dataset.nav, 1) / DAY; paint(); return; }
      const bt = e.target.closest('[data-day]'); if (bt) { picked = +bt.dataset.day; input.value = fmtISO(picked); cal.hidden = true; radio('other'); }
    });
    b.addEventListener('change', (e) => { if (e.target.name === 'dlyd') { for (const c of b.querySelectorAll('.dly-choice')) c.classList.toggle('on', c.querySelector('input').checked); update(); } });
    update();
    b.querySelector('[data-cancel]').addEventListener('click', () => m.close());
    const ok = () => {
      const day = chosen();
      if (day == null) { err.textContent = 'Pick a date first.'; return; }
      const f = (k) => b.querySelector(`[data-f=${k}]`)?.value ?? '';
      const e = incl ? DL.agreeInclusion(store, id, { finishDay: day, reason: f('reason'), approvedBy: f('approved') }) : DL.setAgreed(store, id, day, { reason: f('reason'), approvedBy: f('approved') });
      if (e) { err.textContent = e; return; }
      m.close(); ctx.toast(incl ? `Agreed inclusion “${t.name}” · agreed ${fmtDate(store.byId.get(id).agr.f)}` : `Agreed ${unit} ${fmtDate(store.byId.get(id).agr.f)} set for “${t.name}”`); ctx.requestRender();
    };
    b.querySelector('[data-ok]').addEventListener('click', ok);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'radio') { e.preventDefault(); ok(); } });
  }
  // Deleting a task that has an agreed date: omit it from scope (agreed, kept as a record) or delete it (added by mistake).
  api.confirmDelete = (id, del, afterOmit) => {
    const t = store.byId.get(id);
    if (!t || store.readOnly || !DL.hasAgreedRows(store, id)) { del(); return; }
    const chain = DL.omitChain(store, id), nm = (ids) => ids.map((x) => store.byId.get(x)?.name).filter(Boolean).join(', ');
    const rows = store.info.get(id).summary ? 'These rows have agreed dates.' : `${esc(t.name)} has an agreed date (${fmtDate(t.agr.f)}).`;
    const m = openModal('Remove an agreed task', `<p class="help"><b>${esc(t.name)}</b>: ${rows} How should it leave the plan?</p>
      <label class="dly-choice on"><input type="radio" name="dlyrm" value="omit" checked><span><b>Omit from scope <i>(agreed)</i></b><em>Counts as an agreed scope reduction and stays in the Delay log as a record.</em></span></label>
      <div class="dly-omit"><label class="fld"><span>Reason</span><input data-f="reason" placeholder="Why the work is dropped" autocomplete="off" maxlength="500"></label><label class="fld"><span>Approved by</span><input data-f="approved" placeholder="Name" autocomplete="off" maxlength="120"></label>
      ${chain.preds.length && chain.succs.length ? `<label class="vcheck dly-chain"><input type="checkbox" data-f="relink" checked> Keep the chain: link ${esc(nm(chain.preds))} → ${esc(nm(chain.succs))}</label>` : ''}</div>
      <label class="dly-choice"><input type="radio" name="dlyrm" value="delete"><span><b>Delete <i>(added by mistake)</i></b><em>No record is kept, as if it had never been planned.</em></span></label>
      <p class="set-err" role="alert"></p><div class="rem-actions"><span class="grow"></span><button data-cancel>Cancel</button><button class="primary" data-ok>Remove task</button></div>`);
    const b = m.body, mode = () => b.querySelector('input[name=dlyrm]:checked').value;
    b.addEventListener('change', (e) => { if (e.target.name === 'dlyrm') { for (const c of b.querySelectorAll('.dly-choice')) c.classList.toggle('on', c.querySelector('input').checked); b.querySelector('.dly-omit').hidden = e.target.value !== 'omit'; } });
    b.querySelector('[data-cancel]').addEventListener('click', () => m.close());
    b.querySelector('[data-ok]').addEventListener('click', () => {
      if (mode() === 'omit') {
        const f = (k) => b.querySelector(`[data-f=${k}]`);
        const e = DL.omit(store, id, { reason: f('reason').value, approvedBy: f('approved').value, relink: f('relink') ? f('relink').checked : false });
        if (e) { b.querySelector('.set-err').textContent = e; return; }
        m.close(); afterOmit(); ctx.toast(`Omitted “${t.name}” from scope · kept in the Delay log`);
      } else { m.close(); del(); ctx.toast(`Deleted “${t.name}”`); }
      ctx.requestRender();
    });
  };

  // ---------------------------------------------------------------- versions
  api.typeChip = (v) => { const ty = DL.versionTypeOf(v); return ty ? `<i class="vtype ${ty === 'baseline' ? 'ag' : ty === 'draft' ? 'dr' : 'st'}">${esc(DL.VERSION_TYPES[ty])}</i>` : ''; };
  // The Version type field of the Save version dialog. An Agreed baseline gives every undated task its expected date; when it
  // would change agreed dates or agree waiting inclusions it asks for a reason and who approved it.
  api.typeFieldHtml = (selected = 'status', { baseline = true } = {}) => {
    const opts = TYPE_ORDER.filter((k) => baseline || k !== 'baseline' || selected === 'baseline').map((k) => `<option value="${k}"${k === selected ? ' selected' : ''}>${DL.VERSION_TYPES[k]}</option>`).join('');
    const none = baseline ? '' : `<option value=""${selected ? '' : ' selected'}>Not set</option>`;
    let extra = '';
    if (baseline) {
      const changes = DL.baselineChanges(store), pend = DL.pendingInclusions(store);
      extra = `<div class="dly-base" hidden>
        <p class="mut">${changes.length ? `${pl(changes.length, 'agreed date')} differ from the current plan and will be replaced (recorded as revisions).` : 'Every task without an agreed date gets its current expected date.'}${DL.hasAgreed(store) ? '' : ' Nothing is agreed yet.'}</p>
        <div class="dly-nocause" role="group" aria-label="Delays without a cause"></div>
        ${pend.length ? `<label class="vcheck"><input type="checkbox" id="dly-incl" checked> Agree ${pl(pend.length, 'pending inclusion')} with this baseline</label>` : ''}
        ${changes.length || pend.length ? '<div class="dly-omit"><label class="fld"><span>Reason</span><input id="dly-reason" placeholder="Why the agreed plan changes" autocomplete="off" maxlength="500"></label><label class="fld"><span>Approved by</span><input id="dly-appr" placeholder="Name" autocomplete="off" maxlength="120"></label></div>' : ''}
      </div>`;
    }
    return `<label class="fld"><span>Version type</span><select id="vtype">${none}${opts}</select></label>${extra}`;
  };
  api.bindTypeField = (body) => {
    const sel = body.querySelector('#vtype'), box = body.querySelector('.dly-base'); if (!box) return;
    const upd = () => { box.hidden = sel.value !== 'baseline'; };
    sel.addEventListener('change', upd); upd();
    renderUnclassified(box.querySelector('.dly-nocause'));
  };
  // A soft check, never a block: delays recorded with Skip reason are listed, each with its own cause select, so they can be
  // classified here without leaving (or losing the fields of) the Save version dialog. The list shrinks as causes are chosen.
  function renderUnclassified(host) {
    if (!host) return;
    const list = DL.unclassifiedDelays(store);
    if (!list.length) { setHTML(host, ''); host.hidden = true; return; }
    host.hidden = false;
    const name = (e) => esc(store.byId.get(e.taskId)?.name ?? e.taskName ?? '');
    setHTML(host, `<p class="vwarn">${pl(list.length, 'delay')} ${list.length === 1 ? 'has' : 'have'} no cause: ${list.map((e) => `${name(e)} ${sign(e.days)}`).join(', ')}. You can still save; classify them now or later.</p>
      <div class="dly-nocause-list">${list.map((e) => `<label class="fld dly-nocause-row"><span>${name(e)} ${sign(e.days)}d${e.kind ? ` · ${esc(e.kind)}` : ''}</span><select data-dly-classify="${e.id}" aria-label="Cause of ${name(e)} ${sign(e.days)}"><option value="">Classify…</option>${causes.list.filter((c) => !c.retired).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>`).join('')}</div>`);
    for (const sel of host.querySelectorAll('[data-dly-classify]')) sel.addEventListener('change', () => {
      if (!sel.value) return;
      const err = DL.reclassify(store, +sel.dataset.dlyClassify, { cause: sel.value });
      if (err) ctx.toast(err);
      renderUnclassified(host);
    });
  }
  api.readType = (body) => body.querySelector('#vtype')?.value || null;
  // Before an Agreed baseline is saved: agree the dates. Returns an error message, or null.
  api.agreeOnSave = (body) => {
    const changes = DL.baselineChanges(store).length;
    return DL.agreeBaseline(store, { replace: changes > 0, includePending: !!body.querySelector('#dly-incl')?.checked, reason: body.querySelector('#dly-reason')?.value ?? '', approvedBy: body.querySelector('#dly-appr')?.value ?? '' });
  };

  // ---------------------------------------------------------------- Settings -> Delay causes
  // Every delay entry of every project and saved version, once per project and entry id (a version holds copies of the
  // live log's entries). The live entry wins, so a cause changed since a version was saved counts for its new cause; a cause
  // that only an older version still uses is found as well, so removing it retires it instead.
  const allEntries = () => {
    const seen = new Map(), raw = new Set(), add = (sheetId, list) => { for (const e of list || []) { const k = `${sheetId}:${e.id}`; if (e.cause) raw.add(e.cause); if (!seen.has(k)) seen.set(k, e); } };
    for (const s of store.wb.sheets) {
      add(s.id, s.id === store.wb.active && !store.preview ? store.log : s.data?.log);
      for (const v of s.versions || []) { try { add(s.id, JSON.parse(v.data).log); } catch { /* unreadable version */ } }
    }
    return { entries: [...seen.values()], used: raw };
  };
  api.openSettings = () => {
    refreshCauses();
    const m = openModal('Settings', `<div class="dly-set"><h3>Delay causes</h3><p class="help">One list for all projects. Renaming updates existing delays. Removing a cause that is already used retires it: it disappears from the picker, old delays keep it.</p>
      <div class="dly-causes" id="dly-causes"></div>
      <div class="dly-addrow"><input id="dly-new" placeholder="Add a cause, e.g. Weather" maxlength="60" autocomplete="off"><button class="primary" id="dly-add">Add cause</button></div>
      <p class="set-err" role="alert"></p><p class="mut">Party is free text; it suggests people already in this workbook, like Owner.</p></div>`);
    const body = m.body, list = body.querySelector('#dly-causes'), err = body.querySelector('.set-err');
    const { entries, used } = allEntries(), uses = (id) => entries.filter((e) => e.cause === id).length;
    const save = () => { saveCauses(causes); ctx.requestRender(); };
    const paint = () => {
      setHTML(list, causes.list.map((c) => `<div class="dly-cause-row${c.retired ? ' retired' : ''}" data-id="${esc(c.id)}"><span class="dly-grip" role="button" tabindex="0" title="Drag to reorder (or use Alt+↑ / Alt+↓)" aria-label="Reorder ${esc(c.name)}">⠿</span><span class="dly-cname" data-rename="${esc(c.id)}" tabindex="0" role="button" title="Click to rename">${esc(c.name)}</span>${c.retired ? '<span class="dly-chip ret">Retired</span>' : ''}<span class="dly-use">${uses(c.id) ? `Used by ${pl(uses(c.id), 'delay')}` : used.has(c.id) ? 'Only in saved versions' : 'Not used'}</span><span class="grow"></span>${c.retired ? `<button data-restore="${esc(c.id)}">Restore</button>` : `<button data-remove="${esc(c.id)}" aria-label="${used.has(c.id) ? 'Retire' : 'Remove'} ${esc(c.name)}">${used.has(c.id) ? 'Retire' : 'Remove'}</button>`}</div>`).join(''));
    };
    paint();
    const add = () => {
      const inp = body.querySelector('#dly-new'), e = DL.addCause(causes, inp.value);
      if (e) { err.textContent = e; return; }
      inp.value = ''; err.textContent = ''; paint(); save();
    };
    body.querySelector('#dly-add').addEventListener('click', add);
    body.querySelector('#dly-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    const rename = (cid) => {
      const rn = list.querySelector(`[data-rename="${cid}"]`), c = causes.list.find((x) => x.id === cid); if (!rn || !c || rn.querySelector('input')) return;
      const inp = document.createElement('input'); inp.className = 'dly-rename'; inp.value = c.name; inp.maxLength = 60; rn.textContent = ''; rn.appendChild(inp); inp.focus(); inp.select();
      const done = (ok) => { if (!inp.isConnected) return; const e = ok ? DL.renameCause(causes, cid, inp.value) : null; if (e) err.textContent = e; paint(); if (ok && !e) { err.textContent = ''; save(); } };
      inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
    };
    list.addEventListener('click', (e) => {
      const rn = e.target.closest('[data-rename]'), rm = e.target.closest('[data-remove]'), rs = e.target.closest('[data-restore]');
      if (rm) { DL.removeCause(causes, rm.dataset.remove, used.has(rm.dataset.remove)); paint(); save(); }
      else if (rs) { causes.list.find((x) => x.id === rs.dataset.restore).retired = false; paint(); save(); }
      else if (rn) rename(rn.dataset.rename);
    });
    list.addEventListener('keydown', (e) => {
      const grip = e.target.closest('.dly-grip'), name = e.target.closest('[data-rename]');
      if (name && (e.key === 'Enter' || e.key === ' ') && !name.querySelector('input')) { e.preventDefault(); rename(name.dataset.rename); }
      if (grip && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault(); const id = grip.closest('.dly-cause-row').dataset.id, i = causes.list.findIndex((c) => c.id === id);
        DL.moveCause(causes, id, i + (e.key === 'ArrowUp' ? -1 : 1)); paint(); list.querySelector(`[data-id="${id}"] .dly-grip`)?.focus(); save();
      }
    });
    list.addEventListener('pointerdown', (e) => { // drag the grip to reorder
      const grip = e.target.closest('.dly-grip'); if (!grip) return;
      const id = grip.closest('.dly-cause-row').dataset.id; grip.closest('.dly-cause-row').classList.add('moving');
      const move = (ev) => {
        const over = [...list.children].find((r) => r.dataset.id !== id && ev.clientY < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2);
        const from = causes.list.findIndex((c) => c.id === id), c = causes.list.splice(from, 1)[0];
        const to = over ? causes.list.findIndex((x) => x.id === over.dataset.id) : causes.list.length; causes.list.splice(to, 0, c);
        paint(); list.querySelector(`[data-id="${id}"]`)?.classList.add('moving');
      };
      const up = () => { document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerup', up, true); paint(); save(); };
      document.addEventListener('pointermove', move, true); document.addEventListener('pointerup', up, true);
    });
  };
  $('#settingsbtn')?.addEventListener('click', () => api.openSettings());
  api.causes = () => causes;
  api.reloadCauses = refreshCauses;
  return api;
}
