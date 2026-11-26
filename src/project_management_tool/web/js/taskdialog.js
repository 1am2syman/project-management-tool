// Gantt item inspector & editor dialog (opened by double-clicking any Gantt bar, milestone, or summary).
// Shows and edits identity, schedule, progress & actuals, connections (predecessors/successors/hierarchy),
// slack & critical path, and agreed dates / delay accounting.
import { LINK_TYPES, fmtDate, fmtISO, parseDate, today } from './model.js';
import { esc, openModal, setHTML } from './dom.js';
import { appState } from './appstate.js';
import { slackLabel } from './slackui.js';
import { loadCauses } from './causes.js';
import * as DL from './delays.js';
import { diagnostics } from './diagnosticlog.js';

const TYPE_LABEL = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish', SF: 'Start → Finish' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SCHED_DETAIL = {
  auto: 'Earliest date from connections and effective working calendar.',
  manual: 'Dates set by you; connections will not move this item.',
  anchor: 'Keeps its chosen date; Auto-schedule can only push it later.',
};
const pl = (n, w) => `${n} ${w}${Math.abs(n) === 1 ? '' : 's'}`;
const signD = (n) => (n > 0 ? `+${n}d` : n < 0 ? `−${-n}d` : 'On time');

function calendarSummary(cal) {
  const days = [...cal.workdays].sort((a, b) => a - b);
  let week;
  if (days.length === 7) week = 'Every day';
  else if (days.length > 2 && days.every((d, i) => !i || d === days[i - 1] + 1)) week = `${DAYS[days[0]]}–${DAYS[days.at(-1)]}`;
  else week = days.map((d) => DAYS[d]).join(', ');
  const h = cal.holidays.length;
  return `${week} · ${h} holiday${h === 1 ? '' : 's'}`;
}

export function createTaskDialog(ctx, grid) {
  const { store, ui } = ctx;
  let dialog = null, taskId = null, tab = 'overview', navStack = [], sheetId = null;
  let dirty = false, peopleCleanup = null, pending = false;

  async function mutate(command) {
    if (pending) throw new Error('Wait for the pending change');
    const current = dialog;
    pending = true; current?.setPending(true);
    const state = current?.el.querySelector('[data-td-dirty]');
    if (state) state.textContent = 'Pending…';
    try {
      const result = await command();
      if (result?.cancelled) throw new Error('Action cancelled; edits have not been saved');
      return result;
    }
    finally {
      pending = false; current?.setPending(false);
      if (state) state.textContent = dirty ? 'Unsaved edits' : '';
    }
  }
  function showFailure(error, selector = '[data-td-err]') {
    const box = dialog?.body.querySelector(selector);
    if (box) box.textContent = error.message || String(error);
    else ctx.toast(error.message || String(error));
  }

  function close() {
    if (pending) return;
    peopleCleanup?.(); peopleCleanup = null;
    const active = dialog; dialog = null; taskId = null; navStack = []; dirty = false;
    active?.close();
  }

  function ancestorsOf(id) {
    const f = store.info.get(id); if (!f) return [];
    const out = [];
    for (let i = f.i - 1, lv = store.tasks[f.i].level; i >= 0 && lv > 0; i--) {
      if (store.tasks[i].level < lv) { out.unshift(store.tasks[i]); lv = store.tasks[i].level; }
    }
    return out;
  }

  function childrenOf(id) {
    const f = store.info.get(id); if (!f || !f.summary) return [];
    return store.tasks.slice(f.i + 1, f.sub + 1);
  }

  function summaryActuals(id) {
    const kids = childrenOf(id).filter((k) => !store.info.get(k.id).summary);
    const starts = kids.map((k) => k.actualStart).filter((v) => v != null);
    const ends = kids.map((k) => (k.ms ? k.actualStart : k.actualEnd)).filter((v) => v != null);
    const doneCount = kids.filter((k) => k.progress >= 100).length;
    return {
      total: kids.length,
      doneCount,
      startedCount: starts.length,
      actualStart: starts.length ? Math.min(...starts) : null,
      actualEnd: kids.length && ends.length === kids.length ? Math.max(...ends) : null,
    };
  }

  async function open(id, initialTab = 'overview', { pushHistory = false } = {}) {
    if (pending) return;
    try { if (await grid.commitEdit() === false) return; } catch (error) { ctx.toast(error.message || String(error)); return; }
    if (pending || !store.byId.has(id)) return;
    if (ui.selId !== id || ui.linkId) ctx.select(id, ui.col);
    if (dialog) {
      if (pushHistory && taskId != null && taskId !== id) navStack.push(taskId);
      taskId = id;
      tab = initialTab || tab;
      dirty = false;
      renderAll();
      return;
    }
    taskId = id;
    tab = initialTab || 'overview';
    navStack = [];
    sheetId = store.wb.active;
    dirty = false;

    const current = openModal('Item details', '', {
      wide: true,
      onClose: () => {
        peopleCleanup?.(); peopleCleanup = null;
        if (dialog === current) { dialog = null; taskId = null; navStack = []; dirty = false; }
      },
    });
    dialog = current;
    const modal = current.el.querySelector('[role=dialog]');
    modal.classList.add('task-dialog');

    const head = modal.querySelector('.m-head');
    head.classList.add('td-head');
    const footer = document.createElement('div');
    footer.className = 'td-footer rem-actions';
    modal.appendChild(footer);

    bindModalEvents(modal, current.body);
    const openedTask = store.byId.get(id), openedInfo = store.info.get(id);
    diagnostics.record('taskDialog.open', { kind: openedInfo?.summary ? 'summary' : openedTask?.ms ? 'milestone' : 'task', readOnly: !!store.structureError() });
    renderAll();
  }

  function readForm(body) {
    const q = (sel) => body.querySelector(sel);
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    if (!t || !f) return null;
    const summary = f.summary;
    const name = q('[name=name]')?.value ?? t.name;
    const owner = q('[name=owner]')?.value ?? t.owner;
    const email = q('[name=email]')?.value ?? t.email;
    const notes = q('[name=notes]')?.value ?? (t.notes || '');
    const msInput = q('input[name=kind]:checked');
    const ms = summary ? false : msInput ? msInput.value === 'ms' : t.ms;
    const schedInput = q('input[name=scheduling]:checked');
    const scheduling = summary ? 'auto' : schedInput ? schedInput.value : t.scheduling;
    const startRaw = q('[name=start]')?.value ?? '';
    const endRaw = q('[name=end]')?.value ?? '';
    const durRaw = q('[name=dur]')?.value ?? '';
    const progRaw = q('[name=progress]')?.value ?? String(t.progress);
    const asRaw = q('[name=actualStart]')?.value ?? '';
    const aeRaw = q('[name=actualEnd]')?.value ?? '';
    return {
      name, owner, email, notes, ms, scheduling,
      start: startRaw ? parseDate(startRaw, f.start) : null,
      end: endRaw ? parseDate(endRaw, f.end - 1) : null,
      dur: durRaw === '' ? null : Number(durRaw),
      progress: Number(progRaw),
      actualStart: asRaw ? parseDate(asRaw, f.start) : null,
      actualEnd: aeRaw ? parseDate(aeRaw, f.end - 1) : null,
      raw: { startRaw, endRaw, durRaw, asRaw, aeRaw },
    };
  }

  function computeDirty(body) {
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    if (!t || !f || store.structureError()) return false;
    const v = readForm(body); if (!v) return false;
    const summary = f.summary;
    if (v.name.trim() !== t.name) return true;
    if (v.owner.trim() !== (t.owner || '')) return true;
    if (v.email.trim() !== (t.email || '')) return true;
    if (v.notes.trim() !== (t.notes || '')) return true;
    if (v.start !== f.start) return true;
    if (!summary) {
      if (v.ms !== t.ms) return true;
      if (v.scheduling !== t.scheduling) return true;
      if (!v.ms) {
        if (v.dur !== t.dur) return true;
        if (v.end !== f.end - 1) return true;
      }
      if (Math.round(v.progress) !== t.progress) return true;
      if ((v.actualStart ?? null) !== (t.actualStart ?? null)) return true;
      if (!v.ms && (v.actualEnd ?? null) !== (t.actualEnd ?? null)) return true;
    }
    return false;
  }

  function syncDirtyUI() {
    if (!dialog) return;
    const modal = dialog.el.querySelector('.task-dialog');
    const body = dialog.body, footer = modal.querySelector('.td-footer');
    dirty = computeDirty(body);
    const saveBtn = footer.querySelector('[data-td-save]');
    if (saveBtn) saveBtn.disabled = !dirty || !!store.structureError();
    const resetBtn = footer.querySelector('[data-td-reset]');
    if (resetBtn) resetBtn.hidden = !dirty;
    const state = footer.querySelector('[data-td-dirty]');
    if (state) state.textContent = dirty ? 'Unsaved edits' : '';
    const t = store.byId.get(taskId), f = store.info.get(taskId), v = readForm(body);
    let ovDirty = false, prDirty = false;
    if (dirty && t && f && v) {
      ovDirty = v.name.trim() !== t.name || v.owner.trim() !== (t.owner || '') || v.email.trim() !== (t.email || '') ||
        v.notes.trim() !== (t.notes || '') || v.start !== f.start ||
        (!f.summary && (v.ms !== t.ms || v.scheduling !== t.scheduling || (!v.ms && (v.dur !== t.dur || v.end !== f.end - 1))));
      prDirty = !f.summary && (Math.round(v.progress) !== t.progress || (v.actualStart ?? null) !== (t.actualStart ?? null) || (!v.ms && (v.actualEnd ?? null) !== (t.actualEnd ?? null)));
    }
    body.querySelector('[data-td-tab="overview"]')?.classList.toggle('has-dot', ovDirty);
    body.querySelector('[data-td-tab="progress"]')?.classList.toggle('has-dot', prDirty);
  }

  function updateActualsComparison(body) {
    const box = body.querySelector('[data-td-actual-cmp]');
    if (!box) return;
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    if (!t || !f || f.summary) return;
    const v = readForm(body); if (!v) return;
    const work = store.workFor(t);
    const planStart = v.start ?? f.start;
    const planEnd = v.ms ? planStart : (v.end ?? f.end - 1);
    const as = v.actualStart, ae = v.ms ? as : v.actualEnd;
    if (as == null && ae == null) {
      setHTML(box, '<span class="mut td-cmp-empty">No actual dates recorded</span>');
      return;
    }
    const items = [];
    if (as != null && !v.ms && ae != null) {
      if (ae < as) {
        setHTML(box, '<span class="td-badge bad">Actual finish is before actual start</span>');
        return;
      }
      const actDur = Math.max(1, work.count(as, ae + 1));
      items.push(`<span class="td-stat-pill"><b>${actDur}d</b> actual working days</span>`);
    }
    if (as != null) {
      const ds = DL.wd(store, planStart, as, t.id);
      const cls = ds > 0 ? 'bad' : ds < 0 ? 'ok' : 'neu';
      items.push(`<span class="td-stat-pill ${cls}">${v.ms ? 'Date' : 'Start'}: <b>${signD(ds)}</b> vs plan</span>`);
    }
    if (!v.ms && ae != null) {
      const de = DL.wd(store, planEnd, ae, t.id);
      const cls = de > 0 ? 'bad' : de < 0 ? 'ok' : 'neu';
      items.push(`<span class="td-stat-pill ${cls}">Finish: <b>${signD(de)}</b> vs plan</span>`);
    }
    setHTML(box, items.join(''));
  }

  async function saveOverview() {
    if (pending || !dialog || taskId == null) return false;
    const body = dialog.body, errBox = body.querySelector('[data-td-err]');
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    if (!t || !f) return false;
    const ro = store.structureError();
    if (ro) { if (errBox) errBox.textContent = ro; return false; }
    const v = readForm(body); if (!v) return false;
    const summary = f.summary;

    if (!v.name.trim()) { if (errBox) errBox.textContent = 'Name cannot be empty'; body.querySelector('[name=name]')?.focus(); return false; }
    if (v.start == null) { if (errBox) errBox.textContent = 'Enter a valid start date'; body.querySelector('[name=start]')?.focus(); return false; }
    if (!summary && !v.ms && (v.dur == null || !Number.isFinite(v.dur) || v.dur < 1)) {
      if (errBox) errBox.textContent = 'Duration must be at least 1 working day'; body.querySelector('[name=dur]')?.focus(); return false;
    }
    if (!summary && v.raw.asRaw && v.actualStart == null) {
      if (errBox) errBox.textContent = 'Enter a valid actual start date'; return false;
    }
    if (!summary && !v.ms && v.raw.aeRaw && v.actualEnd == null) {
      if (errBox) errBox.textContent = 'Enter a valid actual finish date'; return false;
    }

    const patch = { name: v.name, owner: v.owner, email: v.email, notes: v.notes };
    if (v.start !== f.start) patch.start = v.start;
    if (!summary) {
      if (v.ms !== t.ms) patch.ms = v.ms;
      if (v.scheduling !== t.scheduling) patch.scheduling = v.scheduling;
      if (!v.ms) {
        if (v.dur !== t.dur || v.ms !== t.ms) patch.dur = v.dur;
        else if (v.end != null && v.end !== f.end - 1) patch.end = v.end;
      }
      if (Math.round(v.progress) !== t.progress) patch.progress = Math.round(v.progress);
      if ((v.actualStart ?? null) !== (t.actualStart ?? null)) patch.actualStart = v.actualStart;
      if (!v.ms && (v.actualEnd ?? null) !== (t.actualEnd ?? null)) patch.actualEnd = v.actualEnd;
    }

    let err;
    try { err = await mutate(() => store.updateTask(taskId, patch)); }
    catch (error) { showFailure(error); return false; }
    if (err) {
      diagnostics.record('taskDialog.save', { ok: false });
      if (errBox) errBox.textContent = err;
      return false;
    }
    diagnostics.record('taskDialog.save', { ok: true, fields: Object.keys(patch).length });
    dirty = false;
    const savedName = store.byId.get(taskId)?.name || v.name;
    // If the schedule edit opened the delay-accounting popover, close this modal so the popover sits unobstructed beside the bar.
    if (ctx.delay?.popOpen?.()) { close(); return true; }
    ctx.toast(`Saved “${savedName}”`);
    renderAll();
    return true;
  }

  function renderHead(modal) {
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    const ms = t.ms && !f.summary;
    const kind = f.summary ? 'Summary' : ms ? 'Milestone' : 'Task';
    const ancs = ancestorsOf(taskId);
    const od = !f.summary ? DL.overdue(store, taskId) : 0;
    const ro = store.structureError();
    const prevId = navStack.at(-1), prevTask = prevId != null ? store.byId.get(prevId) : null;

    const badges = [];
    badges.push(`<span class="td-kind ${f.summary ? 'sum' : ms ? 'ms' : 'task'}">${kind}</span>`);
    if (f.critical && store.critical) badges.push(`<span class="td-badge crit">${store.criticalOptions().method === 'longest' ? 'Longest path' : 'Critical'}</span>`);
    if (t.inc && !f.summary) badges.push('<span class="td-badge warn">Pending inclusion</span>');
    if (od > 0) badges.push(`<span class="td-badge crit">Overdue ${od}d</span>`);
    if (t.calendar && !f.summary) badges.push('<span class="td-badge warn">Custom calendar</span>');
    if (ro) badges.push(`<span class="td-badge neu">${store.preview ? 'Saved version · read-only' : 'Read-only'}</span>`);

    const crumbs = ancs.map((a) => `<button type="button" class="lnk td-crumb" data-td-jump="${a.id}">${esc(a.name)}</button>`).join('<span class="td-sep">›</span>');
    const backBtn = prevTask ? `<button type="button" class="td-back" data-td-back title="Return to ${esc(prevTask.name)}">← ${esc(prevTask.name)}</button>` : '';

    modal.setAttribute('aria-label', `${kind} details: ${t.name}`);
    setHTML(modal.querySelector('.m-head'), `
      <div class="td-head-main">
        <div class="td-meta-row">
          ${backBtn}
          <span class="td-row-num">Row ${store.rowNum(taskId)}</span>
          ${crumbs ? `<span class="td-crumbs">${crumbs}</span>` : ''}
          <span class="td-badges">${badges.join('')}</span>
        </div>
        <b class="td-title">${esc(t.name)}</b>
      </div>
      <button class="m-x" data-td-close aria-label="Close">×</button>
    `);
  }

  function kpiHtml() {
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    const ms = t.ms && !f.summary;
    const dur = store.duration(taskId);
    const sched = store.scheduling(taskId);
    const pct = Math.round(f.progress);
    const dly = DL.row(store, taskId);
    const kids = f.summary ? summaryActuals(taskId) : null;

    // 1. Schedule KPI
    const dateRange = ms ? fmtDate(f.start) : `${fmtDate(f.start)} → ${fmtDate(f.end - 1)}`;
    const schedSub = f.summary ? `${pl(dur, 'working day')} · ${pl(kids.total, 'item')}` : ms ? `${sched.label}` : `${pl(dur, 'working day')} · ${sched.label}`;

    // 2. Progress & Actuals KPI
    let actSub = pct >= 100 ? 'Completed' : pct > 0 ? 'In progress' : 'Not started';
    if (!f.summary) {
      if (t.actualStart != null && !ms && t.actualEnd != null) actSub = `Actual ${fmtDate(t.actualStart)} → ${fmtDate(t.actualEnd)}`;
      else if (t.actualStart != null) actSub = ms ? `Actual ${fmtDate(t.actualStart)}` : `Started ${fmtDate(t.actualStart)}`;
      else if (!ms && t.actualEnd != null) actSub = `Finished ${fmtDate(t.actualEnd)}`;
    } else if (kids.actualStart != null) {
      actSub = `${kids.doneCount}/${kids.total} done · started ${fmtDate(kids.actualStart)}`;
    } else {
      actSub = `${kids.doneCount}/${kids.total} items done`;
    }

    // 3. Slack KPI
    let slackVal = '—', slackCls = '', slackSub = f.summary ? 'Calculated on child tasks' : 'Outside selected target';
    if (!f.summary && (f.float != null || f.freeFloat != null)) {
      const tot = f.float != null ? `${f.float}d` : '—';
      const fr = f.freeFloat != null ? `${f.freeFloat}d` : '—';
      slackVal = `${tot} total · ${fr} free`;
      slackCls = (f.float != null && f.float <= 0) || (f.freeFloat != null && f.freeFloat < 0) ? 'crit' : 'ok';
      slackSub = f.critical ? (store.criticalOptions().method === 'longest' ? 'On Longest Path' : 'On Critical Path') : (f.float > 0 ? 'Buffer before target slips' : 'No total slack');
    }

    // 4. Agreed & Delay KPI
    let dlyVal = 'Not baselined', dlyCls = '', dlySub = f.summary ? 'Agree baseline to track' : 'No agreed deadline set';
    if (t.inc && !f.summary) {
      dlyVal = 'Pending inclusion'; dlyCls = 'warn'; dlySub = 'Added after agreement';
    } else if (dly) {
      dlyVal = dly.v === 0 ? 'On time' : `${DL.sign(dly.v)}d`;
      dlyCls = dly.v > 0 ? 'crit' : dly.v < 0 ? 'ok' : 'ok';
      const bits = [];
      if (dly.own > 0) bits.push(`Own ${DL.sign(dly.own)}d`);
      else if (dly.own < 0) bits.push(`Recovered ${DL.sign(-dly.own)}d`);
      if (dly.inherited > 0) bits.push(`Inherited ${DL.sign(dly.inherited)}d`);
      if (dly.pend > 0) bits.push(`Pending ${DL.sign(dly.pend)}d`);
      dlySub = `Agreed ${fmtDate(dly.agreed)}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
    }

    return `<div class="td-kpis">
      <div class="td-kpi"><span class="td-kpi-l">Schedule</span><strong class="td-kpi-v">${esc(dateRange)}</strong><span class="td-kpi-s">${esc(schedSub)}</span></div>
      <div class="td-kpi"><span class="td-kpi-l">Progress &amp; Actuals</span><strong class="td-kpi-v">${pct}%</strong><div class="td-pbar"><i style="width:${pct}%" class="${pct >= 100 ? 'done' : ''}"></i></div><span class="td-kpi-s">${esc(actSub)}</span></div>
      <div class="td-kpi"><span class="td-kpi-l">Slack</span><strong class="td-kpi-v ${slackCls}">${esc(slackVal)}</strong><span class="td-kpi-s">${esc(slackSub)}</span></div>
      <div class="td-kpi"><span class="td-kpi-l">Agreed &amp; Delay</span><strong class="td-kpi-v ${dlyCls}">${esc(dlyVal)}</strong><span class="td-kpi-s">${esc(dlySub)}</span></div>
    </div>`;
  }

  function overviewHtml() {
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    const summary = f.summary, ms = t.ms && !summary, ro = !!store.structureError();
    const dis = ro ? ' disabled' : '';
    const dur = store.duration(taskId);
    const cal = !summary && t.calendar ? t.calendar : store.calendar;
    const kids = summary ? childrenOf(taskId) : [];

    return `<div class="td-form" data-td-form>
      <div class="td-grid">
        <section class="td-card">
          <h4>Identity &amp; team</h4>
          <div class="${summary ? '' : 'td-name-row'}">
            <label class="fld"><span>Name</span><input name="name" value="${esc(t.name)}" maxlength="200" required autocomplete="off"${dis}></label>
            ${!summary ? `<div class="fld"><span>Type</span><div class="td-seg" role="radiogroup" aria-label="Item type">
              <label><input type="radio" name="kind" value="task"${!ms ? ' checked' : ''}${dis}><span>Task</span></label>
              <label><input type="radio" name="kind" value="ms"${ms ? ' checked' : ''}${dis}><span>Milestone</span></label>
            </div></div>` : ''}
          </div>
          <div class="td-row2">
            <label class="fld"><span>Owner</span><input name="owner" value="${esc(t.owner || '')}" maxlength="80" placeholder="Unassigned" autocomplete="off"${dis}></label>
            <label class="fld"><span>Email</span><input name="email" type="email" value="${esc(t.email || '')}" maxlength="254" placeholder="name@company.com" autocomplete="off"${dis}></label>
          </div>
          <label class="fld"><span>Notes</span><textarea name="notes" rows="2" maxlength="2000" placeholder="Scope notes, assumptions, handover details…"${dis}>${esc(t.notes || '')}</textarea></label>
        </section>

        <section class="td-card">
          <div class="td-card-h"><h4>Planned schedule</h4>${!summary && !ms ? `<span class="td-cal-pill" data-td-caldays>${Math.max(1, f.end - f.start)} cal day${f.end - f.start === 1 ? '' : 's'}</span>` : ''}</div>
          ${summary
            ? `<div class="td-row2">
                <label class="fld"><span data-td-start-lbl>Group start</span><input name="start" type="date" value="${fmtISO(f.start)}"${dis}></label>
                <label class="fld"><span>Group finish</span><input type="date" value="${fmtISO(f.end - 1)}" disabled></label>
              </div>
              <p class="mut">Rolled up from child tasks (${pl(dur, 'working day')}). Changing Group start shifts all children together.</p>`
            : `<div class="td-sched-row">
                <label class="fld"><span data-td-start-lbl>${ms ? 'Milestone date' : 'Start'}</span><input name="start" type="date" value="${fmtISO(f.start)}"${dis}></label>
                <label class="fld" data-td-end-wrap${ms ? ' hidden' : ''}><span>Finish</span><input name="end" type="date" value="${fmtISO(f.end - 1)}"${dis}></label>
                <label class="fld td-dur-fld" data-td-dur-wrap${ms ? ' hidden' : ''}><span>Days</span><input name="dur" type="number" min="1" max="99999999" step="1" value="${dur}"${dis}></label>
              </div>
              <div class="td-fld-sched fld"><span>Scheduling mode</span><div class="td-seg" role="radiogroup" aria-label="Scheduling mode">
                <label><input type="radio" name="scheduling" value="auto"${t.scheduling === 'auto' ? ' checked' : ''}${dis}><span>Auto</span></label>
                <label><input type="radio" name="scheduling" value="manual"${t.scheduling === 'manual' ? ' checked' : ''}${dis}><span>Manual</span></label>
                <label><input type="radio" name="scheduling" value="anchor"${t.scheduling === 'anchor' ? ' checked' : ''}${dis}><span>Date anchor</span></label>
              </div><span class="mut td-sched-note" data-td-sched-note>${esc(SCHED_DETAIL[t.scheduling] || SCHED_DETAIL.auto)}</span></div>
              <div class="td-inline-bar">
                <div class="td-cal-val"><span class="td-sub-inline">Calendar:</span> <b>${t.calendar ? 'Custom' : 'Global'}</b> · ${esc(calendarSummary(cal))}</div>
                <button type="button" data-td-calendar>${ro ? 'Inspect…' : 'Configure…'}</button>
              </div>`}
        </section>
      </div>

      ${summary ? `<section class="td-card td-children-card">
        <div class="td-card-h"><h4>Child items (${kids.length})</h4>${!ro ? '<div class="td-card-acts"><button type="button" data-td-add-child="task">+ Child task</button><button type="button" data-td-add-child="ms">+ Child milestone</button></div>' : ''}</div>
        <div class="td-table-wrap"><table class="td-table"><thead><tr><th>Row</th><th>Name</th><th>Schedule</th><th>Done</th><th>Slack</th></tr></thead><tbody>
          ${kids.map((k) => {
            const kf = store.info.get(k.id);
            return `<tr><td class="mono">${store.rowNum(k.id)}</td><td><button type="button" class="lnk td-jump-name" data-td-jump="${k.id}">${'· '.repeat(Math.max(0, k.level - t.level - 1))}${esc(k.name)}</button></td><td class="mono">${k.ms && !kf.summary ? fmtDate(kf.start) : `${fmtDate(kf.start)} → ${fmtDate(kf.end - 1)}`}</td><td class="mono">${Math.round(kf.progress)}%</td><td class="mono">${kf.float == null ? '—' : `${kf.float}d`}</td></tr>`;
          }).join('')}
        </tbody></table></div>
      </section>` : ''}
    </div>`;
  }

  function progressHtml() {
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    const summary = f.summary, ms = t.ms && !summary, ro = !!store.structureError();
    const dis = ro ? ' disabled' : '';
    const pct = Math.round(f.progress);
    const kids = summary ? childrenOf(taskId).filter((k) => !store.info.get(k.id).summary) : [];
    const sumAct = summary ? summaryActuals(taskId) : null;

    if (summary) {
      return `<div class="td-stack">
        <section class="td-card">
          <h4>Summary progress &amp; rolled-up actuals</h4>
          <div class="td-sum-actuals">
            <div><span class="td-sub-l">Weighted completion</span><strong>${pct}%</strong> <span class="mut">(${sumAct.doneCount}/${sumAct.total} done)</span></div>
            <div><span class="td-sub-l">Actual start (earliest child)</span><strong>${sumAct.actualStart != null ? fmtDate(sumAct.actualStart) : '—'}</strong></div>
            <div><span class="td-sub-l">Actual finish (all children)</span><strong>${sumAct.actualEnd != null ? fmtDate(sumAct.actualEnd) : '—'}</strong></div>
          </div>
        </section>
        <section class="td-card">
          <h4>Child progress &amp; actuals (${kids.length})</h4>
          <div class="td-table-wrap"><table class="td-table"><thead><tr><th>Row</th><th>Name</th><th>Done</th><th>Actual start</th><th>Actual finish</th></tr></thead><tbody>
            ${kids.map((k) => `<tr><td class="mono">${store.rowNum(k.id)}</td><td><button type="button" class="lnk td-jump-name" data-td-jump="${k.id}">${esc(k.name)}</button></td><td class="mono">${Math.round(k.progress)}%</td><td class="mono">${k.actualStart != null ? fmtDate(k.actualStart) : '—'}</td><td class="mono">${k.ms ? (k.actualStart != null ? fmtDate(k.actualStart) : '—') : (k.actualEnd != null ? fmtDate(k.actualEnd) : '—')}</td></tr>`).join('')}
          </tbody></table></div>
        </section>
      </div>`;
    }

    return `<div class="td-form" data-td-form>
      <section class="td-card">
        <div class="td-card-h"><h4>Completion</h4><span class="mut">${pct >= 100 ? 'Completed' : pct > 0 ? 'In progress' : 'Not started'}</span></div>
        <div class="td-prog-row">
          <span class="td-prog-lbl">Done</span>
          <input class="td-range" type="range" name="progressRange" min="0" max="100" step="1" value="${pct}" aria-label="Completion percent"${dis}>
          <div class="td-pct-in"><input type="number" name="progress" min="0" max="100" step="1" value="${pct}" aria-label="Completion percent number"${dis}><span>%</span></div>
          <div class="td-presets" role="group" aria-label="Quick completion presets">
            ${[0, 25, 50, 75, 100].map((p) => `<button type="button" class="chip2${pct === p ? ' on' : ''}" data-td-pct="${p}"${dis}>${p}%</button>`).join('')}
          </div>
        </div>
      </section>
      <section class="td-card">
        <div class="td-card-h"><h4>Actual dates</h4><div class="td-actual-cmp" data-td-actual-cmp></div></div>
        <div class="td-row2 td-actual-dates">
          <div class="fld">
            <div class="td-fld-head"><span data-td-as-lbl>${ms ? 'Actual date' : 'Actual start'}</span>${!ro ? '<span class="td-quick"><button type="button" class="lnk" data-td-fill="actualStart:today">Today</button><button type="button" class="lnk" data-td-fill="actualStart:plan">= Plan</button><button type="button" class="lnk" data-td-fill="actualStart:clear">Clear</button></span>' : ''}</div>
            <input name="actualStart" type="date" value="${t.actualStart != null ? fmtISO(t.actualStart) : ''}"${dis}>
          </div>
          <div class="fld" data-td-ae-wrap${ms ? ' hidden' : ''}>
            <div class="td-fld-head"><span>Actual finish</span>${!ro ? '<span class="td-quick"><button type="button" class="lnk" data-td-fill="actualEnd:today">Today</button><button type="button" class="lnk" data-td-fill="actualEnd:plan">= Plan</button><button type="button" class="lnk" data-td-fill="actualEnd:clear">Clear</button></span>' : ''}</div>
            <input name="actualEnd" type="date" value="${!ms && t.actualEnd != null ? fmtISO(t.actualEnd) : ''}"${dis}>
          </div>
        </div>
      </section>
    </div>`;
  }

  function linkStatusBadge(l) {
    if (l.violated) return '<span class="td-badge warn" title="Constraint violated by manual date or disabled Auto-schedule">Violated</span>';
    if (l.critical && store.critical) return '<span class="td-badge crit">Critical</span>';
    if (l.slack === 0) return '<span class="td-badge neu">Driving</span>';
    return `<span class="td-badge ok">+${l.slack}d gap</span>`;
  }

  function linkRowHtml(l, dir, ro) {
    const otherId = dir === 'in' ? l.from : l.to;
    const other = store.byId.get(otherId), of = store.info.get(otherId);
    const dis = ro ? ' disabled' : '';
    const dateStr = other.ms ? fmtDate(of.start) : `${fmtDate(of.start)} → ${fmtDate(of.end - 1)}`;
    return `<div class="td-link-row" data-link-id="${esc(l.id)}">
      <div class="td-link-who">
        <span class="td-row-num">#${store.rowNum(otherId)}</span>
        <button type="button" class="lnk td-jump-name" data-td-jump="${otherId}">${esc(other.name)}</button>
        <span class="td-link-dates">${esc(dateStr)}</span>
      </div>
      <div class="td-link-ctl">
        <select data-link-type aria-label="Link type"${dis}>${LINK_TYPES.map((tp) => `<option value="${tp}"${tp === l.type ? ' selected' : ''}>${tp}</option>`).join('')}</select>
        <label class="td-lag-wrap" title="Lag in working days"><input type="number" step="1" data-link-lag value="${l.lag}" aria-label="Lag days"${dis}><span>d</span></label>
        ${linkStatusBadge(l)}
        ${!ro ? `<button type="button" class="td-mini-btn" data-link-save="${esc(l.id)}" disabled>Update</button><button type="button" class="td-mini-x" data-link-del="${esc(l.id)}" aria-label="Remove connection with ${esc(other.name)}" title="Remove connection">×</button>` : ''}
      </div>
    </div>`;
  }

  function addLinkFormHtml(dir) {
    const existing = new Set((dir === 'in' ? store.incoming(taskId) : store.outgoing(taskId)).map((l) => (dir === 'in' ? l.from : l.to)));
    const options = store.tasks.filter((cand) => {
      if (cand.id === taskId || store.info.get(cand.id).summary || existing.has(cand.id)) return false;
      const err = dir === 'in' ? store.canLink(cand.id, taskId) : store.canLink(taskId, cand.id);
      return !err;
    });
    if (!options.length) return '<p class="mut">No additional eligible tasks or milestones can be linked without creating a cycle.</p>';
    return `<div class="td-add-link" data-add-link="${dir}">
      <select data-add-target aria-label="${dir === 'in' ? 'Choose predecessor' : 'Choose successor'}">
        <option value="">${dir === 'in' ? 'Add predecessor…' : 'Add successor…'}</option>
        ${options.map((c) => `<option value="${c.id}">Row ${store.rowNum(c.id)} · ${esc(c.name)}${c.ms ? ' ◆' : ''}</option>`).join('')}
      </select>
      <select data-add-type aria-label="Relationship type">${LINK_TYPES.map((tp) => `<option value="${tp}">${tp} · ${esc(TYPE_LABEL[tp])}</option>`).join('')}</select>
      <label class="td-lag-wrap"><input type="number" step="1" value="0" data-add-lag aria-label="Lag days"><span>d</span></label>
      <button type="button" class="primary" data-add-submit="${dir}">Add</button>
    </div>`;
  }

  function connectionsHtml() {
    const t = store.byId.get(taskId), f = store.info.get(taskId), ro = !!store.structureError();
    const rel = store.related(taskId);
    const ancs = ancestorsOf(taskId);
    const inPlan = store.indentPlan(taskId, 1), outPlan = store.indentPlan(taskId, -1);

    if (f.summary) {
      const upTasks = [...rel.up].map((id) => store.byId.get(id)).filter(Boolean);
      const downTasks = [...rel.down].map((id) => store.byId.get(id)).filter(Boolean);
      return `<div class="td-stack">
        <p class="help">Summary rows roll up their children and cannot hold direct links. Below are the external dependency chains connected to leaf tasks inside <b>${esc(t.name)}</b>.</p>
        <div class="td-grid">
          <section class="td-card"><h4>Upstream dependencies (${upTasks.length})</h4>
            ${upTasks.length ? `<div class="td-chip-list">${upTasks.map((x) => `<button type="button" class="chip2" data-td-jump="${x.id}">#${store.rowNum(x.id)} ${esc(x.name)}</button>`).join('')}</div>` : '<p class="mut">No external upstream dependencies.</p>'}
          </section>
          <section class="td-card"><h4>Downstream dependents (${downTasks.length})</h4>
            ${downTasks.length ? `<div class="td-chip-list">${downTasks.map((x) => `<button type="button" class="chip2" data-td-jump="${x.id}">#${store.rowNum(x.id)} ${esc(x.name)}</button>`).join('')}</div>` : '<p class="mut">No external downstream dependents.</p>'}
          </section>
        </div>
        <section class="td-card">
          <div class="td-card-h"><h4>Hierarchy (WBS)</h4>${!ro ? `<div class="td-card-acts"><button type="button" data-td-indent="-1"${outPlan.error ? ` disabled title="${esc(outPlan.error)}"` : ''}>Outdent</button><button type="button" data-td-indent="1"${inPlan.error ? ` disabled title="${esc(inPlan.error)}"` : ''}>Indent</button></div>` : ''}</div>
          <p class="mut">${ancs.length ? `Inside: ${ancs.map((a) => `<button type="button" class="lnk" data-td-jump="${a.id}">${esc(a.name)}</button>`).join(' › ')}` : 'Top-level summary.'} Contains ${pl(rel.desc.size, 'descendant')}.</p>
        </section>
      </div>`;
    }

    const ins = store.incoming(taskId), outs = store.outgoing(taskId);
    return `<div class="td-stack">
      <p class="set-err" role="alert" data-td-conn-err></p>
      <section class="td-card td-conn-card">
        <div class="td-card-h"><h4>Predecessors · depends on (${ins.length})</h4><span class="mut">Upstream chain: ${rel.up.size}</span></div>
        ${ins.length ? `<div class="td-link-list">${ins.map((l) => linkRowHtml(l, 'in', ro)).join('')}</div>` : '<p class="mut td-conn-empty">No predecessors.</p>'}
        ${!ro ? addLinkFormHtml('in') : ''}
      </section>
      <section class="td-card td-conn-card">
        <div class="td-card-h"><h4>Successors · drives (${outs.length})</h4><span class="mut">Downstream chain: ${rel.down.size}</span></div>
        ${outs.length ? `<div class="td-link-list">${outs.map((l) => linkRowHtml(l, 'out', ro)).join('')}</div>` : '<p class="mut td-conn-empty">No successors.</p>'}
        ${!ro ? addLinkFormHtml('out') : ''}
      </section>
      <div class="td-inline-bar td-wbs-bar">
        <div class="td-cal-val"><span class="td-sub-inline">Hierarchy:</span> ${ancs.length ? ancs.map((a) => `<button type="button" class="lnk td-crumb" data-td-jump="${a.id}">${esc(a.name)}</button>`).join('<span class="td-sep"> › </span>') : '<span class="mut">Top-level item</span>'}</div>
        ${!ro ? `<div class="td-card-acts"><button type="button" data-td-indent="-1"${outPlan.error ? ` disabled title="${esc(outPlan.error)}"` : ''}>Outdent</button><button type="button" data-td-indent="1"${inPlan.error ? ` disabled title="${esc(inPlan.error)}"` : ''}>Indent</button></div>` : ''}
      </div>
    </div>`;
  }

  function limitersHtml(ids, fallback) {
    if (!ids.length) return esc(fallback);
    return ids.map((id) => {
      const link = store.links.find((l) => l.id === id), task = store.byId.get(link?.to);
      if (!task) return esc('Successor');
      const tag = `${link.type}${link.lag ? ` ${link.lag > 0 ? '+' : ''}${link.lag}d` : ''}`;
      return `<button type="button" class="lnk" data-td-jump="${task.id}">${esc(task.name)}</button> <span class="mut">(${esc(tag)})</span>`;
    }).join(', ');
  }

  function slackHtml() {
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    const target = store.criticalTarget(), targetName = target?.name || 'Project completion';
    const opts = store.criticalOptions();
    const methodText = opts.method === 'longest' ? 'Longest Path' : `Total Float ≤ ${opts.threshold}d`;
    const isTarget = target?.id === taskId;
    const msTargetBtn = t.ms && !f.summary && !store.preview
      ? `<button type="button" data-td-crittarget="${isTarget ? 'clear' : 'set'}"${store.stale ? ' disabled' : ''}>${isTarget ? 'Reset target to Project completion' : 'Use as critical-path target'}</button>`
      : '';

    const overlayBar = `<div class="td-inline-bar">
      <div><span class="td-sub-l">Gantt slack tails</span><div class="mut">Thick tail = free slack · dashed tail = total slack</div></div>
      <select data-td-slack-mode aria-label="Show slack on Gantt">
        <option value="off"${ui.slackMode === 'off' ? ' selected' : ''}>Off</option>
        <option value="selected"${ui.slackMode === 'selected' ? ' selected' : ''}>Selected task</option>
        <option value="all"${ui.slackMode === 'all' ? ' selected' : ''}>All tasks</option>
      </select>
    </div>`;

    if (f.summary) {
      const critKids = childrenOf(taskId).filter((k) => !store.info.get(k.id).summary && store.info.get(k.id).critical);
      return `<div class="td-stack">
        <section class="td-card">
          <div class="td-card-h"><h4>Critical path · ${esc(methodText)}</h4><span class="mut">Target: <b>${esc(targetName)}</b></span></div>
          <p class="help">Slack is not calculated for summary rows; dates and float belong to individual leaf tasks and milestones.</p>
          ${critKids.length ? `<div><span class="td-sub-l">Critical child items (${critKids.length})</span><div class="td-chip-list">${critKids.map((k) => `<button type="button" class="chip2" data-td-jump="${k.id}">#${store.rowNum(k.id)} ${esc(k.name)}</button>`).join('')}</div></div>` : '<p class="mut">None of the child items are currently on the critical path.</p>'}
        </section>
        ${overlayBar}
      </div>`;
    }

    const violations = store.links.filter((l) => l.violated).length;
    const dates = (s, e) => (s == null ? 'Outside selected target' : `${fmtISO(s)} → ${fmtISO(t.ms ? s : e - 1)}`);
    const totalLimit = f.float == null ? 'Outside selected target' : limitersHtml(f.totalLimiters, targetName);
    const freeLimit = limitersHtml(f.freeLimiters, isTarget ? targetName : 'Project completion (no immediate successors)');
    const note = (val, label) => (val == null ? '' : val < 0 ? `<p class="slack-warning">${label} is negative: move ${-val} working day${val === -1 ? '' : 's'} earlier to meet this limit.</p>` : val === 0 ? `<p class="mut">No ${label.toLowerCase()} remains.</p>` : '');

    return `<div class="td-stack">
      <section class="td-card">
        <div class="td-card-h">
          <div><h4>Critical path · ${esc(methodText)}</h4><p class="mut">Target: <b>${esc(targetName)}</b>${opts.method === 'longest' && f.longestPath ? ' · On Longest Path' : ''}${t.progress >= 100 ? ' · Completed items are not highlighted critical' : ''}</p></div>
          ${msTargetBtn}
        </div>
        ${violations ? `<p class="slack-warning" role="status">This schedule has ${violations} violated dependenc${violations === 1 ? 'y' : 'ies'}. Resolve conflicts before treating positive slack as a safe allowance.</p>` : ''}
      </section>
      <div class="slack-metrics">
        <section>
          <h4>Total slack</h4>
          <strong>${esc(slackLabel(f))}</strong>
          <p>Delay allowed before <b>${esc(targetName)}</b> moves.</p>
          <dl><dt>Latest start → finish</dt><dd>${esc(dates(f.latestStart, f.latestEnd))}</dd><dt>Limited by</dt><dd>${totalLimit}</dd></dl>
          ${note(f.float, 'Total slack')}
        </section>
        <section>
          <h4>Free slack</h4>
          <strong>${esc(slackLabel(f, true))}</strong>
          <p>Delay allowed before any immediate successor’s current dates move.</p>
          <dl><dt>Latest start → finish</dt><dd>${esc(dates(f.freeStart, f.freeEnd))}</dd><dt>Limited by</dt><dd>${freeLimit}</dd></dl>
          ${note(f.freeFloat, 'Free slack')}
        </section>
      </div>
      ${overlayBar}
    </div>`;
  }

  function delaysHtml() {
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    const ro = !!store.structureError();
    const causes = loadCauses();
    const r = DL.row(store, taskId);
    const od = !f.summary ? DL.overdue(store, taskId) : 0;
    const unrec = !f.summary ? DL.unrecordedDays(store, taskId) : 0;
    const entries = DL.delayLog(store, causes).filter((e) => e.taskId === taskId).reverse();

    let summaryBlock = '';
    if (t.inc && !f.summary) {
      summaryBlock = `<section class="td-card td-warn-card">
        <div class="td-card-h"><div><h4>Pending inclusion</h4><p class="help">Added after the baseline was agreed. Agree this inclusion to give it an agreed date and shift downstream agreed dates accordingly.</p></div>
        ${!ro ? '<button type="button" class="primary" data-td-dly="agree-inclusion">Agree inclusion…</button>' : ''}</div>
      </section>`;
    } else if (r) {
      const originId = r.inherited && r.source != null ? DL.originOf(store, r.source) : null;
      const pills = [];
      if (r.own > 0) pills.push(`<span class="dly-chip own">Own ${DL.sign(r.own)}d</span>`);
      else if (r.own < 0) pills.push(`<span class="td-stat-pill ok">Recovered ${DL.sign(-r.own)}d</span>`);
      if (r.inherited > 0) pills.push(`<span class="dly-chip inh">Inherited ${DL.sign(r.inherited)}d${originId != null ? ` from <button type="button" class="lnk" data-td-jump="${originId}">${esc(DL.nameOf(store, originId))}</button>` : ''}</span>`);
      if (r.pend > 0) pills.push(`<span class="dly-chip pend">Pending inclusion ${DL.sign(r.pend)}d${r.pendSource != null ? ` from <button type="button" class="lnk" data-td-jump="${r.pendSource}">${esc(DL.nameOf(store, r.pendSource))}</button>` : ''}</span>`);
      if (r.rev) pills.push(`<span class="td-stat-pill neu">Agreed revision ${DL.sign(r.rev)}d</span>`);

      summaryBlock = `<section class="td-card">
        <div class="td-card-h"><h4>Agreed baseline &amp; variance</h4>
          ${!f.summary && !ro ? `<div class="td-card-acts">
            ${unrec > 0 ? '<button type="button" class="primary" data-td-dly="record-missing">Record delay…</button>' : ''}
            <button type="button" data-td-dly="agree-deadline">Change agreed deadline…</button>
          </div>` : ''}
        </div>
        <div class="td-dly-grid">
          <div><span class="td-sub-l">Original agreed</span><strong>${fmtDate(r.orig)}</strong></div>
          <div><span class="td-sub-l">Current agreed</span><strong>${fmtDate(r.agreed)}</strong></div>
          <div><span class="td-sub-l">Expected ${t.ms && !f.summary ? 'date' : 'finish'}</span><strong>${fmtDate(r.expected)}</strong></div>
          <div><span class="td-sub-l">Variance vs agreed</span><strong class="${r.v > 0 ? 'td-c-crit' : r.v < 0 ? 'td-c-ok' : ''}">${r.v ? `${DL.sign(r.v)}d` : '0d (On time)'}</strong></div>
        </div>
        ${pills.length ? `<div class="td-chip-list">${pills.join('')}</div>` : '<p class="mut">This item is tracking to its agreed date.</p>'}
      </section>`;
    } else {
      summaryBlock = `<section class="td-card">
        <div class="td-card-h"><div><h4>No agreed deadline</h4><p class="help">${f.summary ? 'Summary rows acquire agreed dates once a project Agreed baseline is saved.' : 'Set an agreed deadline on this item (or save an Agreed baseline snapshot) to track own vs inherited delays.'}</p></div>
        ${!f.summary && !ro ? '<button type="button" class="primary" data-td-dly="agree-deadline">Set agreed deadline…</button>' : ''}</div>
      </section>`;
    }

    const overdueBlock = od > 0 ? `<section class="td-card td-crit-card">
      <div class="td-card-h"><div><h4>Overdue by ${pl(od, 'working day')}</h4><p class="help">Unfinished and past its agreed and expected date. Nothing moves automatically — record a new expected finish when ready.</p></div>
      ${!ro ? '<button type="button" class="primary" data-td-dly="overdue">Update expected finish…</button>' : ''}</div>
    </section>` : '';

    const logBlock = `<section class="td-card">
      <h4>Item delay &amp; change log (${entries.length})</h4>
      ${entries.length ? `<div class="td-table-wrap"><table class="td-table"><thead><tr><th>When</th><th>Type</th><th>Days</th><th>Details</th><th></th></tr></thead><tbody>
        ${entries.map((e) => {
          const dt = e.at ? new Date(e.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
          const detailBits = [];
          if (e.kind) detailBits.push(esc(e.kind));
          if (e.causeLabel) detailBits.push(`<b>${esc(e.causeLabel)}</b>`);
          if (e.party) detailBits.push(esc(e.party));
          if (e.reason) detailBits.push(esc(e.reason));
          if (e.approvedBy) detailBits.push(`Approved by ${esc(e.approvedBy)}`);
          if (e.note) detailBits.push(`<em>${esc(e.note)}</em>`);
          const canEdit = !ro && e.type === 'delay' && e.days > 0;
          return `<tr>
            <td class="mono">${esc(dt)}</td>
            <td><span class="td-badge ${e.type === 'delay' && e.days > 0 ? 'crit' : e.days < 0 ? 'ok' : 'neu'}">${esc(e.typeLabel)}</span></td>
            <td class="mono">${e.days ? `${DL.sign(e.days)}d` : '0d'}</td>
            <td>${detailBits.join(' · ') || '<span class="mut">—</span>'}</td>
            <td>${canEdit ? `<button type="button" class="lnk" data-td-edit-log="${e.id}">Edit</button>` : ''}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>` : '<p class="mut">No delay, revision, or scope changes recorded for this item yet.</p>'}
    </section>`;

    return `<div class="td-stack">${overdueBlock}${summaryBlock}${logBlock}</div>`;
  }

  function renderTabsAndBody(preserveOverview = false) {
    if (!dialog) return;
    const body = dialog.body;
    const t = store.byId.get(taskId), f = store.info.get(taskId);
    const connCount = f.summary ? childrenOf(taskId).length : store.incoming(taskId).length + store.outgoing(taskId).length;
    const dly = DL.row(store, taskId);
    const dlyAlert = !!(t.inc || (dly && dly.v > 0) || (!f.summary && DL.overdue(store, taskId) > 0));

    if (preserveOverview && body.querySelector('[data-td-panel="overview"]')) {
      // Keep unsaved Overview inputs intact; refresh KPIs and secondary panels in place.
      const kpiHost = body.querySelector('.td-kpi-host');
      if (kpiHost) setHTML(kpiHost, kpiHtml());
      const connTab = body.querySelector('[data-td-tab="connections"]');
      if (connTab) connTab.textContent = `Connections (${connCount})`;
      const dlyTab = body.querySelector('[data-td-tab="delays"]');
      if (dlyTab) dlyTab.classList.toggle('has-alert', dlyAlert);
      const cp = body.querySelector('[data-td-panel="connections"]'); if (cp) setHTML(cp, connectionsHtml());
      const sp = body.querySelector('[data-td-panel="slack"]'); if (sp) setHTML(sp, slackHtml());
      const dp = body.querySelector('[data-td-panel="delays"]'); if (dp) setHTML(dp, delaysHtml());
      return;
    }

    peopleCleanup?.(); peopleCleanup = null;
    const tabBtn = (id, label, extraCls = '') => `<button type="button" role="tab" id="td-tab-${id}" aria-controls="td-panel-${id}" aria-selected="${tab === id}" tabindex="${tab === id ? '0' : '-1'}" class="${tab === id ? 'on' : ''}${extraCls ? ` ${extraCls}` : ''}" data-td-tab="${id}">${label}</button>`;

    setHTML(body, `
      <div class="td-kpi-host">${kpiHtml()}</div>
      <div class="tabs td-tabs" role="tablist" aria-label="Item details sections">
        ${tabBtn('overview', 'Overview')}
        ${tabBtn('progress', 'Progress')}
        ${tabBtn('connections', `Connections (${connCount})`)}
        ${tabBtn('slack', 'Slack &amp; Path')}
        ${tabBtn('delays', 'Delays &amp; Agreed', dlyAlert ? 'has-alert' : '')}
      </div>
      <section id="td-panel-overview" data-td-panel="overview" role="tabpanel" aria-labelledby="td-tab-overview"${tab !== 'overview' ? ' hidden' : ''}>${overviewHtml()}</section>
      <section id="td-panel-progress" data-td-panel="progress" role="tabpanel" aria-labelledby="td-tab-progress"${tab !== 'progress' ? ' hidden' : ''}>${progressHtml()}</section>
      <section id="td-panel-connections" data-td-panel="connections" role="tabpanel" aria-labelledby="td-tab-connections"${tab !== 'connections' ? ' hidden' : ''}>${connectionsHtml()}</section>
      <section id="td-panel-slack" data-td-panel="slack" role="tabpanel" aria-labelledby="td-tab-slack"${tab !== 'slack' ? ' hidden' : ''}>${slackHtml()}</section>
      <section id="td-panel-delays" data-td-panel="delays" role="tabpanel" aria-labelledby="td-tab-delays"${tab !== 'delays' ? ' hidden' : ''}>${delaysHtml()}</section>
      <p class="set-err" role="alert" data-td-err></p>
    `);

    const ownerInput = body.querySelector('input[name=owner]');
    if (ownerInput && ctx.people && !store.structureError()) {
      ownerInput.addEventListener('focus', () => {
        peopleCleanup?.();
        peopleCleanup = ctx.people.attach(ownerInput, (p) => {
          ownerInput.value = p.name;
          const emailInput = body.querySelector('input[name=email]');
          if (emailInput) emailInput.value = p.email || '';
          syncDirtyUI();
        });
      });
    }
    updateActualsComparison(body);
  }

  function renderFooter(modal) {
    const footer = modal.querySelector('.td-footer');
    const ro = !!store.structureError();
    const hasAgreed = DL.hasAgreedRows(store, taskId);
    setHTML(footer, `
      ${!ro ? `<button type="button" class="lnk red" data-td-delete>${hasAgreed ? 'Remove / Omit…' : 'Delete item'}</button>` : ''}
      <button type="button" class="lnk" data-td-reveal>Reveal on Gantt</button>
      <span class="grow"></span>
      <span class="mut td-dirty-lbl" data-td-dirty>${dirty ? 'Unsaved edits' : ''}</span>
      ${!ro ? `<button type="button" class="lnk" data-td-reset${dirty ? '' : ' hidden'}>Reset</button>` : ''}
      <button type="button" data-td-close>${ro ? 'Close' : 'Cancel'}</button>
      ${!ro ? `<button type="button" class="primary" data-td-save${dirty ? '' : ' disabled'}>Save changes</button>` : ''}
    `);
  }

  function renderAll(preserveOverview = false) {
    if (pending || !dialog || taskId == null || !store.byId.has(taskId)) return;
    if (store.wb.active !== sheetId) { close(); return; }
    const modal = dialog.el.querySelector('.task-dialog');
    renderHead(modal);
    renderTabsAndBody(preserveOverview);
    renderFooter(modal);
    syncDirtyUI();
  }

  function switchTab(next) {
    if (!dialog || !next || next === tab) return;
    tab = next;
    const body = dialog.body;
    body.querySelectorAll('[role=tab]').forEach((b) => {
      const on = b.dataset.tdTab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    body.querySelectorAll('[data-td-panel]').forEach((p) => { p.hidden = p.dataset.tdPanel !== tab; });
  }

  function jumpTo(otherId) {
    if (!store.byId.has(otherId) || otherId === taskId) return;
    if (dirty) {
      ctx.toast('Save or reset unsaved edits before switching items');
      return;
    }
    open(otherId, tab, { pushHistory: true });
  }

  function bindModalEvents(modal, body) {
    // Tab keyboard navigation + Ctrl/Cmd+Enter save + Enter in single-line Overview inputs
    modal.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !store.structureError()) {
        if (dirty) { e.preventDefault(); saveOverview(); }
        return;
      }
      if (e.target.matches('[role=tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const order = ['overview', 'progress', 'connections', 'slack', 'delays'];
        const i = order.indexOf(tab);
        const next = e.key === 'Home' ? order[0] : e.key === 'End' ? order.at(-1) : order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
        switchTab(next);
        body.querySelector(`[data-td-tab="${next}"]`)?.focus();
        return;
      }
      if (e.key === 'Enter' && e.target.closest('[data-td-form]') && e.target.matches('input:not([type=radio]):not([type=checkbox])') && !document.querySelector('.pplist')) {
        e.preventDefault();
        if (dirty) saveOverview();
      }
    });

    // Live Overview form interactions (date/duration sync, progress sync, type toggle, scheduling helper, actuals comparison)
    body.addEventListener('input', (e) => {
      const target = e.target;
      if (target.closest('.td-link-row')) {
        const row = target.closest('.td-link-row'), link = store.links.find((l) => l.id === row.dataset.linkId);
        const btn = row.querySelector('[data-link-save]');
        if (btn && link) {
          const tp = row.querySelector('[data-link-type]').value, lg = Number(row.querySelector('[data-link-lag]').value);
          btn.disabled = tp === link.type && lg === link.lag;
        }
        return;
      }
      if (!target.closest('[data-td-form]')) return;
      const t = store.byId.get(taskId), f = store.info.get(taskId);
      if (!t || !f) return;
      const work = store.workFor(t);
      const errBox = body.querySelector('[data-td-err]'); if (errBox) errBox.textContent = '';

      if (target.name === 'progressRange' || target.name === 'progress') {
        const val = Math.max(0, Math.min(100, Math.round(Number(target.value) || 0)));
        const r = body.querySelector('[name=progressRange]'), n = body.querySelector('[name=progress]');
        if (target.name === 'progressRange' && n) n.value = String(val);
        if (target.name === 'progress' && r) r.value = String(val);
        body.querySelectorAll('[data-td-pct]').forEach((b) => b.classList.toggle('on', +b.dataset.tdPct === val));
      } else if (!f.summary && (target.name === 'start' || target.name === 'dur' || target.name === 'end')) {
        const sIn = body.querySelector('[name=start]'), eIn = body.querySelector('[name=end]'), dIn = body.querySelector('[name=dur]');
        const msChecked = body.querySelector('input[name=kind]:checked')?.value === 'ms';
        const s = parseDate(sIn?.value, f.start);
        if (!msChecked && s != null && eIn && dIn) {
          const sn = work.next(s);
          if (target.name === 'start' || target.name === 'dur') {
            const d = Math.max(1, Math.round(Number(dIn.value) || 1));
            const finExcl = work.finish(sn, d);
            eIn.value = fmtISO(finExcl - 1);
            const cd = body.querySelector('[data-td-caldays]');
            if (cd) cd.textContent = `${Math.max(1, finExcl - sn)} cal day${finExcl - sn === 1 ? '' : 's'}`;
          } else if (target.name === 'end') {
            const eDay = parseDate(eIn.value, f.end - 1);
            if (eDay != null && eDay >= sn) {
              const d = Math.max(1, work.count(sn, eDay + 1));
              dIn.value = String(d);
              const cd = body.querySelector('[data-td-caldays]');
              if (cd) cd.textContent = `${Math.max(1, eDay + 1 - sn)} cal day${eDay + 1 - sn === 1 ? '' : 's'}`;
            }
          }
        }
      }
      if (['start', 'end', 'dur', 'actualStart', 'actualEnd'].includes(target.name)) updateActualsComparison(body);
      syncDirtyUI();
    });

    body.addEventListener('change', async (e) => {
      if (pending) return;
      const target = e.target;
      if (target.matches('[data-td-slack-mode]')) {
        const mode = target.value, previous = ui.slackMode;
        target.value = previous;
        try { await mutate(() => appState.setItem('pm-slack-mode', mode)); ui.slackMode = mode; target.value = mode; ctx.requestRender(); }
        catch (error) { target.value = previous; showFailure(error); }
        return;
      }
      if (target.closest('.td-link-row')) {
        const row = target.closest('.td-link-row'), link = store.links.find((l) => l.id === row.dataset.linkId);
        const btn = row.querySelector('[data-link-save]');
        if (btn && link) {
          const tp = row.querySelector('[data-link-type]').value, lg = Number(row.querySelector('[data-link-lag]').value);
          btn.disabled = tp === link.type && lg === link.lag;
        }
        return;
      }
      if (target.name === 'kind') {
        const isMs = target.value === 'ms';
        body.querySelector('[data-td-end-wrap]')?.toggleAttribute('hidden', isMs);
        body.querySelector('[data-td-dur-wrap]')?.toggleAttribute('hidden', isMs);
        body.querySelector('[data-td-ae-wrap]')?.toggleAttribute('hidden', isMs);
        const sl = body.querySelector('[data-td-start-lbl]'); if (sl) sl.textContent = isMs ? 'Milestone date' : 'Start date';
        const asl = body.querySelector('[data-td-as-lbl]'); if (asl) asl.textContent = isMs ? 'Actual date' : 'Actual start';
        const dIn = body.querySelector('[name=dur]');
        if (!isMs && dIn && (!Number(dIn.value) || Number(dIn.value) < 1)) {
          dIn.value = '1';
          const t = store.byId.get(taskId), f = store.info.get(taskId), s = parseDate(body.querySelector('[name=start]')?.value, f.start);
          const eIn = body.querySelector('[name=end]');
          if (s != null && eIn) eIn.value = fmtISO(store.workFor(t).finish(store.workFor(t).next(s), 1) - 1);
        }
        updateActualsComparison(body);
        syncDirtyUI();
      } else if (target.name === 'scheduling') {
        const note = body.querySelector('[data-td-sched-note]');
        if (note) note.textContent = SCHED_DETAIL[target.value] || '';
        syncDirtyUI();
      }
    });

    // Click handler across head, body, and footer
    modal.addEventListener('click', async (e) => {
      if (pending) return;
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      try {

        if (btn.hasAttribute('data-td-close')) { close(); return; }
        if (btn.hasAttribute('data-td-back')) {
          if (dirty) { ctx.toast('Save or reset unsaved edits before going back'); return; }
          const prev = navStack.pop();
          if (prev != null && store.byId.has(prev)) open(prev, tab);
          return;
        }
        if (btn.dataset.tdTab) { switchTab(btn.dataset.tdTab); return; }
        if (btn.dataset.tdJump) { jumpTo(+btn.dataset.tdJump); return; }
        if (btn.hasAttribute('data-td-save')) { saveOverview(); return; }
        if (btn.hasAttribute('data-td-reset')) { dirty = false; renderAll(); return; }
        if (btn.hasAttribute('data-td-reveal')) { ctx.select(taskId, ui.col, true); return; }
        if (btn.hasAttribute('data-td-calendar')) { ctx.calendar.open(taskId); return; }

        if (btn.hasAttribute('data-td-delete')) {
          const id = taskId, name = store.byId.get(id)?.name || 'Item';
          const done = () => { close(); };
          await ctx.delay.confirmDelete(id, async () => { await mutate(() => store.deleteTask(id)); ctx.toast(`Deleted “${name}”`); done(); }, done);
          return;
        }

        if (btn.dataset.tdPct != null) {
          const val = +btn.dataset.tdPct;
          const r = body.querySelector('[name=progressRange]'), n = body.querySelector('[name=progress]');
          if (r) r.value = String(val);
          if (n) n.value = String(val);
          body.querySelectorAll('[data-td-pct]').forEach((b) => b.classList.toggle('on', +b.dataset.tdPct === val));
          syncDirtyUI();
          return;
        }

        if (btn.dataset.tdFill) {
          const [field, what] = btn.dataset.tdFill.split(':');
          const inp = body.querySelector(`[name="${field}"]`);
          const f = store.info.get(taskId);
          if (!inp || !f) return;
          if (what === 'clear') inp.value = '';
          else if (what === 'today') inp.value = fmtISO(today);
          else if (what === 'plan') {
            const s = parseDate(body.querySelector('[name=start]')?.value, f.start) ?? f.start;
            const eDay = parseDate(body.querySelector('[name=end]')?.value, f.end - 1) ?? (f.end - 1);
            inp.value = fmtISO(field === 'actualStart' ? s : eDay);
          }
          updateActualsComparison(body);
          syncDirtyUI();
          return;
        }

        if (btn.dataset.tdAddChild) {
          if (dirty) { ctx.toast('Save or reset unsaved edits before adding a child'); return; }
          const res = await mutate(() => store.insertTask(taskId, btn.dataset.tdAddChild === 'ms', 'child'));
          if (res.error) { ctx.toast(res.error); return; }
          ctx.toast(`Added child ${btn.dataset.tdAddChild === 'ms' ? 'milestone' : 'task'}`);
          open(res.id, 'overview', { pushHistory: true });
          return;
        }

        if (btn.dataset.tdIndent) {
          const err = await mutate(() => store.indent(taskId, +btn.dataset.tdIndent));
          if (err) ctx.toast(err);
          else renderAll(dirty);
          return;
        }

        if (btn.dataset.linkSave) {
          const row = btn.closest('.td-link-row'), errBox = body.querySelector('[data-td-conn-err]');
          const type = row.querySelector('[data-link-type]').value, lag = Number(row.querySelector('[data-link-lag]').value);
          const err = await mutate(() => store.updateLink(btn.dataset.linkSave, { type, lag }));
          if (err) { if (errBox) errBox.textContent = err; return; }
          if (ctx.delay?.popOpen?.()) { close(); return; }
          ctx.toast('Connection updated');
          renderAll(dirty);
          return;
        }

        if (btn.dataset.linkDel) {
          const err = await mutate(() => store.removeLink(btn.dataset.linkDel));
          if (err) { showFailure(new Error(err), '[data-td-conn-err]'); return; }
          ctx.toast('Connection removed');
          renderAll(dirty);
          return;
        }

        if (btn.dataset.addSubmit) {
          const dir = btn.dataset.addSubmit, box = btn.closest('[data-add-link]'), errBox = body.querySelector('[data-td-conn-err]');
          const other = +box.querySelector('[data-add-target]').value;
          const type = box.querySelector('[data-add-type]').value;
          const lag = Number(box.querySelector('[data-add-lag]').value || 0);
          if (!other) { if (errBox) errBox.textContent = `Choose a ${dir === 'in' ? 'predecessor' : 'successor'} first.`; return; }
          const fromId = dir === 'in' ? other : taskId, toId = dir === 'in' ? taskId : other;
          const err = await mutate(() => store.addLink(fromId, type[0].toLowerCase(), toId, type[1].toLowerCase(), lag));
          if (err) { if (errBox) errBox.textContent = err; return; }
          if (ctx.delay?.popOpen?.()) { close(); return; }
          ctx.toast('Connection added');
          renderAll(dirty);
          return;
        }

        if (btn.dataset.tdCrittarget) {
          const err = await mutate(() => store.setCriticalTarget(btn.dataset.tdCrittarget === 'clear' ? null : taskId));
          if (err) ctx.toast(err);
          else renderAll(dirty);
          return;
        }

        if (btn.dataset.tdDly) {
          const a = btn.dataset.tdDly, id = taskId;
          if (dirty && (a === 'overdue' || a === 'record-missing')) { ctx.toast('Save or reset unsaved edits before recording a delay'); return; }
          if (a === 'overdue') { close(); ctx.delay.openOverdue(id); }
          else if (a === 'record-missing') { close(); ctx.delay.recordMissing(id); }
          else ctx.delay.menuAction(a, id);
          return;
        }

        if (btn.dataset.tdEditLog) {
          ctx.delay.editRecord(taskId, +btn.dataset.tdEditLog, () => renderAll(dirty));
          return;
        }
      } catch (error) { showFailure(error, btn.dataset.linkSave || btn.dataset.linkDel || btn.dataset.addSubmit ? '[data-td-conn-err]' : '[data-td-err]'); }
    });
  }

  store.on((kind) => {
    if (!dialog || pending) return;
    if (kind === 'sheet' || kind === 'version' || store.wb.active !== sheetId) { close(); return; }
    if (!store.byId.has(taskId)) { close(); return; }
    if (kind === 'drag') return;
    renderAll(dirty);
  });

  return { open, close, isOpen: () => !!dialog, refresh: () => renderAll(dirty) };
}
