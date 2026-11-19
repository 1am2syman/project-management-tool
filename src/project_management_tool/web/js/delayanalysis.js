// Delay accounting sections of the Analysis page: milestone table, impact grid, explain waterfall, agreed vs expected
// trend, own vs inherited by owner and the delay log. Every number comes from delays.js; this file only lays it out.
import { fmtDate } from './model.js';
import { esc, setHTML } from './dom.js';
import * as DL from './delays.js';
import { loadCauses } from './causes.js';

const { sign } = DL;
const PALETTE = ['#2b59e6', '#f59e0b', '#0d9488', '#7c3aed', '#e11d48', '#15803d'];
export const DELAY_SECTIONS = [['dmil', 'Milestone table'], ['dimp', 'Impact grid'], ['dexp', 'Explain a milestone'], ['dtrd', 'Agreed vs expected'], ['down', 'Own vs inherited'], ['dlog', 'Delay log']];
const TYPE_TITLE = { delay: 'Delay', revision: 'Revision', inclusion: 'Inclusion', omission: 'Omission', residual: 'Other / unexplained', pending: 'Pending inclusion' };

// The shape the finish waterfall draws, from the steps explaining one milestone.
export function toWaterfall(x) {
  const steps = x.steps.map((s) => ({
    title: s.title, type: s.type, from: s.from, to: s.to, days: s.days, work: s.days,
    items: [{ name: s.task || s.title, kind: TYPE_TITLE[s.type] || '', before: s.type === 'delay' ? `${s.cause || 'Unclassified'}${s.party ? ` · ${s.party}` : ''}` : s.reason || (s.type === 'residual' ? 'Not explained by a recorded change' : ''), after: s.type === 'delay' ? `own ${sign(s.own)}d` : s.approvedBy ? `approved by ${s.approvedBy}` : `${sign(s.days)}d` }],
    relationships: [], paths: [], driversBefore: [], driversAfter: [],
    reason: s.type === 'delay' ? 'The effect of this recorded delay on the milestone, measured by taking it out and scheduling the plan again. Delay inherited from earlier tasks is never a separate step: it is counted where it started.' : s.type === 'residual' ? 'What the recorded changes do not account for.' : s.type === 'pending' ? 'New work waiting to be agreed. It pushes this date but is not delay.' : s.reason || 'An agreed change to the plan.',
  }));
  // The agreed date after approved changes sits between the agreed changes and the delays.
  const firstOther = steps.findIndex((s) => !['revision', 'inclusion', 'omission'].includes(s.type));
  const agreedCount = firstOther < 0 ? steps.length : firstOther;
  if (agreedCount) steps.splice(agreedCount, 0, { title: 'Current agreed', type: 'subtotal', from: x.agreed, to: x.agreed, days: 0, work: 0, items: [], relationships: [], paths: [], driversBefore: [], driversAfter: [], reason: 'The agreed date after approved changes' });
  return {
    available: true, baseline: x.orig, compared: x.exp, days: x.total, work: x.total, steps, name: x.name,
    title: `Why ${x.name} moved`, startLabel: 'Original agreed', endLabel: 'Expected', shiftLabel: 'Total vs original',
    note: 'Each step is the effect of one recorded change on this milestone. Delay inherited from earlier tasks is never a separate step.',
    method: 'Original agreed → agreed changes → current agreed → delays → expected.',
  };
}

export function createDelayAnalysis(ctx, { onEdited } = {}) {
  const { store } = ctx;
  const ui = { showAll: false, showTrend: false, explain: null, step: 0, root: null, h: null, w: null, cur: null, versions: [], stars: new Set(), sheet: null, live: false };
  const sec = (id, title, inner, sub = '') => `<section class="an-sec dly-an" id="an-${id}" aria-labelledby="an-h-${id}"><h2 id="an-h-${id}">${title}${sub ? `<small>${esc(sub)}</small>` : ''}</h2>${inner}</section>`;
  const none = (t) => `<p class="an-none">${esc(t)}</p>`;
  const stCls = (s) => (s.startsWith('Late') ? 'dlyl' : s === 'Early' ? 'dlye' : 'dlyo');
  const causes = () => loadCauses();
  const table = () => DL.milestoneTable(ui.cur, causes(), ui.stars);

  function milestoneTable() {
    const t = table(); if (!t.length) return none('Nothing is agreed yet. Agree a baseline or set an agreed deadline to start tracking delay.');
    const rv = t.some((m) => m.rev);
    return `<table class="an-t dly-mt"><thead><tr><th>Milestone</th><th>Agreed</th>${rv ? '<th class="n">Revisions</th><th>Current agreed</th>' : ''}<th class="n" title="Working days expected later (+) or earlier (−) than the current agreed date">Delay</th><th>Expected</th><th>Status</th><th>Main causes</th></tr></thead><tbody>${t.map((m) => {
      const star = m.id !== 'end' ? `<button class="dly-star${m.starred ? ' on' : ''}" data-dly-star="${m.id}" aria-pressed="${m.starred}" title="${m.starred ? 'Key milestone: shown in the impact grid' : 'Mark as a key milestone'}" aria-label="Key milestone: ${esc(m.name)}">${m.starred ? '★' : '☆'}</button>` : '<span class="dly-star on" title="Always shown">★</span>';
      const causesText = m.causes.slice(0, 3).map((c) => `${esc(c.name)} ${sign(c.days)}`).join(' · ') || '<span class="mut">—</span>';
      return `<tr data-ms="${m.id}"><td>${star} <strong>${esc(m.name)}</strong></td><td>${fmtDate(m.orig)}</td>${rv ? `<td class="n ${m.rev ? 'dly-agr' : 'zero'}">${m.rev ? sign(m.rev) : '0'}</td><td>${fmtDate(m.cur)}</td>` : ''}<td class="n ${m.delay > 0 ? 'bad' : m.delay < 0 ? 'good' : 'zero'}">${m.delay ? sign(m.delay) : '0'}</td><td>${fmtDate(m.exp)}</td><td><span class="chip ${stCls(m.status)}">${esc(m.status)}</span></td><td>${causesText}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  function impactGrid() {
    const g = DL.impactGrid(ui.cur, causes(), ui.stars); if (!g.cols.length) return none('Nothing is agreed yet.');
    const cols = g.cols.filter((c) => ui.showAll || c.starred);
    const cell = (v) => (!v ? '<td class="n zero">—</td>' : `<td class="n ${v > 0 ? 'bad' : 'good'}">${sign(v)}</td>`);
    const rows = g.rows.filter((r) => cols.some((c) => r.effects[c.id]));
    const resid = cols.map((c) => g.unexplained[c.id] || 0);
    return `<div class="dly-tools"><button class="dly-sw${ui.showAll ? ' on' : ''}" data-dly-showall role="switch" aria-checked="${ui.showAll}"><i></i>Show all milestones</button><span>${ui.showAll ? 'All milestones' : 'Key milestones (★) and Project completion'}. Each column adds up to its total against the original agreed date.</span></div>
      <table class="an-t dly-grid"><thead><tr><th>What changed</th>${cols.map((c) => `<th class="col">${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td>${cols.map((c) => cell(r.effects[c.id])).join('')}</tr>`).join('')}${resid.some(Boolean) ? `<tr><td>Other / unexplained</td>${resid.map(cell).join('')}</tr>` : ''}<tr class="total"><td>Total vs original agreed</td>${cols.map((c) => `<td class="n ${c.total > 0 ? 'bad' : c.total < 0 ? 'good' : 'zero'}">${c.total ? sign(c.total) : '0'}</td>`).join('')}</tr></tbody></table>`;
  }

  function pickExplain() {
    const t = table(); if (!t.length) return null;
    if (ui.explain == null || !t.some((m) => m.id === ui.explain)) ui.explain = t.reduce((a, m) => (m.total > a.total ? m : a), t[0]).id; // opens on the most delayed
    return ui.explain;
  }
  const dwf = (s) => s.replaceAll('data-wf-', 'data-dwf-');
  function explainHtml() {
    const id = pickExplain(); if (id == null) return none('Nothing is agreed yet.');
    const t = table(), x = DL.explainSteps(ui.cur, causes(), id, ui.stars); if (!x) return none('No data.');
    const w = toWaterfall(x); ui.w = w; if (ui.step >= w.steps.length) ui.step = 0;
    return `<label class="dly-explain"><span>Explain:</span><select data-dly-explain aria-label="Milestone to explain">${t.map((m) => `<option value="${m.id}"${m.id === id ? ' selected' : ''}>${esc(m.name)}${m.total ? ` (${sign(m.total)}d)` : ''}</option>`).join('')}</select><span class="mut">Any milestone or Project completion.</span></label>${dwf(ui.h.waterfallMarkup(w))}`;
  }
  function renderExplain(full = false) {
    const box = ui.root?.querySelector('#an-dexp'); if (!box) return;
    if (full) setHTML(box.querySelector('.dly-explain-body'), explainHtml());
    const w = ui.w, chart = box.querySelector('.wf-chart'); if (!w?.steps.length || !chart) return;
    const st = getComputedStyle(chart.parentElement);
    const width = Math.max(320, Math.floor(chart.parentElement.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight)));
    const r = ui.h.waterfallChart(w, width, ui.step);
    chart.setAttribute('viewBox', `0 0 ${width} ${r.height}`); chart.setAttribute('width', width); chart.setAttribute('height', r.height);
    ui.h.setSVG(chart, dwf(r.svg));
    const open = box.querySelector('.wf-explain')?.open;
    setHTML(box.querySelector('.wf-detail'), dwf(ui.h.waterfallDetails(w, ui.step)));
    if (open) box.querySelector('.wf-explain').open = true;
    for (const row of box.querySelectorAll('[data-wf-row]')) row.classList.toggle('selected', +row.dataset.wfRow === ui.step);
  }

  // Agreed (solid) and expected (dashed) dates of the key milestones in every saved version that has agreed dates, then now.
  function trendData() {
    const labels = ui.versions.map((v) => v.label), tables = ui.versions.map((v) => v.table);
    const series = [];
    table().filter((m) => ui.showTrend || m.starred).forEach((m, i) => {
      const col = PALETTE[i % PALETTE.length], at = (rows) => rows?.find((x) => x.id === m.id);
      series.push({ name: `${m.name} · agreed`, color: col, values: tables.map((rows) => at(rows)?.cur ?? null), width: 2.4 }, { name: `${m.name} · expected`, color: col, values: tables.map((rows) => at(rows)?.exp ?? null), width: 2, dash: '5 4' });
    });
    return { labels, series };
  }
  function renderTrend() {
    const box = ui.root?.querySelector('#an-dtrd .dly-trend'); if (!box) return;
    const { labels, series } = trendData();
    if (!series.length) { setHTML(box, none('Agree a baseline to start the trend.')); return; }
    const width = Math.max(420, Math.round(box.clientWidth || 800)), svg = box.querySelector('svg');
    svg.setAttribute('viewBox', `0 0 ${width} 280`); svg.setAttribute('width', width); svg.setAttribute('height', 280);
    ui.h.setSVG(svg, ui.h.lineChart({ width, height: 280, labels, series, highlight: [ui.versions.findIndex((v) => v.compared)].filter((i) => i >= 0) }));
    setHTML(box.querySelector('.dly-legend'), series.filter((_s, i) => i % 2 === 0).map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name.replace(' · agreed', ''))}</span>`).join('') + '<span class="mut">solid = agreed, dashed = expected</span>');
  }

  function owners() {
    const o = DL.ownerTable(ui.cur); if (!o.length) return none('No delay or revision is charged to anyone yet.');
    const max = Math.max(1, ...o.map((x) => x.own));
    return `<table class="an-t"><thead><tr><th>Owner</th><th class="n">Tasks</th><th>Own delay <span class="mut">(started at their tasks)</span></th><th class="n" title="Delay received from earlier tasks, summed per task: the same delay is counted on every task it reaches, so do not add it to Own">Inherited <span class="mut">(received, per task)</span></th><th class="n" title="Revisions recorded at this owner's own tasks">Revisions <span class="mut">(own tasks)</span></th><th class="n" title="Part of Own delay with no cause chosen">Unclassified <span class="mut">(of Own)</span></th></tr></thead><tbody>${o.map((x) => `<tr><td><strong>${esc(x.owner)}</strong></td><td class="n">${x.tasks}</td><td><span class="dly-ownbar" style="width:${Math.round((x.own / max) * 90)}px;background:#f43f5e"></span> ${x.own ? sign(x.own) : '0'}</td><td class="n">${x.inherited ? sign(x.inherited) : '0'}</td><td class="n">${x.revisions ? sign(x.revisions) : '0'}</td><td class="n">${x.unclassified ? sign(x.unclassified) : '0'}</td></tr>`).join('')}</tbody></table>`;
  }

  function log() {
    const rows = DL.delayLog(ui.cur, causes());
    if (!rows.length) return none('No delays, revisions, inclusions or omissions recorded yet.');
    return `<table class="an-t"><thead><tr><th>Date</th><th>Task</th><th>Type</th><th>Kind</th><th class="n">Days</th><th>Cause</th><th>Party / approved by</th><th>Reason / note</th>${ui.live ? '<th><span class="sr-only">Edit</span></th>' : ''}</tr></thead><tbody>${rows.map((e) => `<tr><td>${esc(new Date(e.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}</td><td>${e.type === 'omission' ? `<s>${esc(e.taskName || '')}</s>` : esc(e.taskName || '')}</td><td>${esc(e.typeLabel)}</td><td>${esc(e.kind || '')}</td><td class="n">${e.days ? sign(e.days) : ''}</td><td>${esc(e.causeLabel || '')}</td><td>${esc(e.type === 'delay' ? e.party || '' : e.approvedBy || '')}</td><td>${esc([e.reason, e.note].filter(Boolean).join(' · '))}</td>${ui.live ? `<td>${e.type === 'delay' ? `<button class="dly-logedit" data-dly-edit="${e.id}" aria-label="Edit delay record: ${esc(e.taskName || '')} ${sign(e.days)}">Edit…</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table>`;
  }

  // The sections describe the compared plan `cur`. plans: [{ label, view, compared }] oldest first, for the trend.
  // h: { waterfallMarkup, waterfallChart, waterfallDetails, lineChart, setSVG }
  function html(cur, plans, h) {
    ui.h = h || ui.h; ui.cur = cur; ui.live = plans.some((p) => p.compared && p.live) && !store.preview; ui.sheet = store.wb.active; ui.stars = new Set(store.keyMilestones());
    ui.versions = plans.filter((p) => DL.hasAgreed(p.view)).map((p) => ({ label: p.label, compared: !!p.compared, table: DL.milestoneTable(p.view, causes(), ui.stars) }));
    return sec('dmil', 'Milestone table', milestoneTable(), 'Agreed, delay and expected for every milestone') +
      sec('dimp', 'Impact grid', impactGrid(), 'Which change moved which milestone') +
      sec('dexp', 'Explain a milestone', `<div class="dly-explain-body">${explainHtml()}</div>`) +
      sec('dtrd', 'Agreed vs expected', `<div class="dly-tools"><button class="dly-sw${ui.showTrend ? ' on' : ''}" data-dly-showtrend role="switch" aria-checked="${ui.showTrend}"><i></i>Show all milestones</button><span>${ui.showTrend ? 'All milestones' : 'Key milestones (★) and Project completion'}.</span></div><div class="dly-trend"><svg class="an-chart" role="img" aria-label="Agreed and expected dates across versions"></svg><div class="dly-legend"></div></div>`) +
      sec('down', 'Own vs inherited, by owner', owners()) +
      sec('dlog', 'Delay log', log(), 'Also the Delay log sheet of the Excel export');
  }
  function mount(root) {
    ui.root = root;
    renderExplain(); renderTrend();
    if (root._dly) return;
    root._dly = true;
    const refresh = (ids) => {
      for (const id of ids) {
        const el = root.querySelector(`#an-${id}`); if (!el) continue;
        const wrap = document.createElement('div'); setHTML(wrap, { dmil: milestoneSection, dimp: impactSection, dtrd: trendSection }[id]());
        el.replaceWith(wrap.firstElementChild);
      }
      renderExplain(true); renderTrend();
    };
    const milestoneSection = () => sec('dmil', 'Milestone table', milestoneTable(), 'Agreed, delay and expected for every milestone');
    const impactSection = () => sec('dimp', 'Impact grid', impactGrid(), 'Which change moved which milestone');
    const trendSection = () => sec('dtrd', 'Agreed vs expected', `<div class="dly-tools"><button class="dly-sw${ui.showTrend ? ' on' : ''}" data-dly-showtrend role="switch" aria-checked="${ui.showTrend}"><i></i>Show all milestones</button><span>${ui.showTrend ? 'All milestones' : 'Key milestones (★) and Project completion'}.</span></div><div class="dly-trend"><svg class="an-chart" role="img" aria-label="Agreed and expected dates across versions"></svg><div class="dly-legend"></div></div>`);
    root.addEventListener('click', (e) => {
      const edit = e.target.closest('[data-dly-edit]');
      if (edit) { ctx.delay.editRecord(null, +edit.dataset.dlyEdit, onEdited); return; }
      const star = e.target.closest('[data-dly-star]');
      if (star) { const id = +star.dataset.dlyStar; store.setKeyMilestone(id, !ui.stars.has(id)); ui.stars = new Set(store.keyMilestones()); refresh(['dmil', 'dimp', 'dtrd']); root.querySelector(`[data-dly-star="${id}"]`)?.focus({ preventScroll: true }); return; }
      if (e.target.closest('[data-dly-showtrend]')) { ui.showTrend = !ui.showTrend; refresh(['dtrd']); root.querySelector('[data-dly-showtrend]')?.focus({ preventScroll: true }); return; }
      if (e.target.closest('[data-dly-showall]')) { ui.showAll = !ui.showAll; refresh(['dimp']); root.querySelector('[data-dly-showall]')?.focus({ preventScroll: true }); return; }
      const step = e.target.closest('[data-dwf-step],[data-dwf-select]');
      if (step) { ui.step = +(step.dataset.dwfStep ?? step.dataset.dwfSelect); renderExplain(); return; }
      const nav = e.target.closest('[data-dwf-prev],[data-dwf-next]');
      if (nav) { ui.step = Math.max(0, Math.min(ui.w.steps.length - 1, ui.step + (nav.hasAttribute('data-dwf-next') ? 1 : -1))); renderExplain(); }
    });
    root.addEventListener('keydown', (e) => {
      const step = e.target.closest?.('[data-dwf-step]');
      if (step && ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); const n = ui.w.steps.length, cur = +step.dataset.dwfStep;
        ui.step = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0)));
        renderExplain(); root.querySelector(`[data-dwf-step="${ui.step}"]`)?.focus({ preventScroll: true });
      }
    });
    root.addEventListener('change', (e) => {
      if (e.target.hasAttribute('data-dly-explain')) { ui.explain = e.target.value === 'end' ? 'end' : +e.target.value; ui.step = 0; renderExplain(true); }
      else if (e.target.hasAttribute('data-dwf-pick')) { ui.step = +e.target.value; renderExplain(); }
    });
  }
  // Plain data for the PDF and Excel exports: the same numbers as the sections on screen.
  const data = (view) => { const stars = store.keyMilestones(), c = causes(); return { table: DL.milestoneTable(view, c, stars), grid: DL.impactGrid(view, c, stars), log: DL.delayLog(view, c) }; };
  return { html, mount, data, has: (view) => DL.hasAgreed(view), resize: () => { renderExplain(); renderTrend(); }, stars: () => ui.stars, table };
}
