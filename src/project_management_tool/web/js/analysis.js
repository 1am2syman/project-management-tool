// Version analysis: a full-screen overlay comparing two plans of the active project (a saved
// version or the current plan): headline figures, trends, milestones, a baseline Gantt with
// ghost bars, the change log, slips, critical-path changes and owners, with PDF/Excel export.
import { esc, setHTML, setSVG } from './dom.js';
import { MONTHS, today, ymd, fmtDate } from './model.js';
import { compareViews, trends, changeLog, changeCategory, summaryCards, fmtDay, signed, CHANGE_FILTERS, MILESTONE_STATUS } from './versiondiff.js';
import { buildAnalysisPdf, buildAnalysisXlsx } from './analysisexport.js';
import { finishWaterfall } from './finishwaterfall.js';
import { waterfallChart, waterfallMarkup, waterfallDetails, nameLines } from './waterfallui.js';
import * as DL from './delays.js';
import { createDelayAnalysis, DELAY_SECTIONS } from './delayanalysis.js';
import { diagnostics } from './diagnosticlog.js';

const PALETTE = ['#2b59e6', '#f59e0b', '#0d9488', '#7c3aed', '#e11d48', '#15803d', '#0891b2', '#c2410c', '#64748b', '#db2777'];
const MAX_TREND_MILESTONES = 10;
const SECTIONS = [['summary', 'Summary'], ['trends', 'Trends'], ['milestones', 'Milestones'], ['gantt', 'Gantt comparison'], ['changes', 'Change log'], ['slips', 'Biggest slips'], ['critical', 'Critical path'], ['owners', 'By owner']];
const when = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fname = (s) => String(s).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'project';
const tone = (n, worse = 1) => (!n ? '' : n * worse > 0 ? ' bad' : ' good');

// Milestones whose forecast moved the most are the ones worth a line on the chart.
export function trendSeries(trend, limit = MAX_TREND_MILESTONES) {
  const spread = (s) => { const v = s.dates.filter((x) => x != null); return v.length ? Math.max(...v) - Math.min(...v) : -1; };
  return [...trend.milestones].sort((x, y) => spread(y) - spread(x) || x.name.localeCompare(y.name)).slice(0, limit);
}

function dateTicks(min, max, count = 5) {
  const span = Math.max(1, max - min), step = [1, 2, 3, 7, 14, 28, 56, 91, 182, 365, 730].find((s) => span / s <= count) || 1461;
  const out = []; for (let d = Math.ceil(min / step) * step; d <= max; d += step) out.push(d);
  return out;
}
const tickLabel = (d, span) => { const [y, m, day] = ymd(d); return span > 300 ? `${MONTHS[m]} ${y}` : `${MONTHS[m]} ${day}`; };

// SVG line chart of dates (y) across plans (x).
export function lineChart({ width, height = 250, labels, series, highlight = [], pointLabels = false }) {
  const values = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!values.length) return '';
  let lo = Math.min(...values), hi = Math.max(...values); const pad = Math.max(2, Math.round((hi - lo) * 0.12)); lo -= pad; hi += pad;
  const pl = 70, pr = 18, pt = 18, pb = 36, pw = width - pl - pr, ph = height - pt - pb, n = labels.length;
  const X = (i) => pl + (n === 1 ? pw / 2 : (i * pw) / (n - 1)), Y = (v) => pt + ph - ((v - lo) / (hi - lo)) * ph;
  let s = `<rect class="ch-bg" x="${pl}" y="${pt}" width="${pw}" height="${ph}"/>`;
  for (const t of dateTicks(lo, hi)) s += `<line class="ch-grid" x1="${pl}" x2="${pl + pw}" y1="${Y(t)}" y2="${Y(t)}"/><text class="ch-ax" x="${pl - 8}" y="${Y(t) + 4}" text-anchor="end">${esc(tickLabel(t, hi - lo))}</text>`;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
  labels.forEach((l, i) => {
    const on = highlight.includes(i);
    if (on) s += `<line class="ch-hl" x1="${X(i)}" x2="${X(i)}" y1="${pt}" y2="${pt + ph}"/>`;
    if (i % every === 0 || i === n - 1 || on) s += `<text class="ch-ax${on ? ' on' : ''}" x="${X(i)}" y="${height - pb + 16}" text-anchor="middle">${esc(l)}</text>`;
  });
  for (const se of series) {
    s += `<g class="ch-series" opacity="${se.muted ? .16 : 1}">`;
    let d = '', pen = false;
    se.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; });
    s += `<path class="ch-line" d="${d}" stroke="${se.color}" stroke-width="${se.width || 2}"${se.dash ? ` stroke-dasharray="${se.dash}"` : ''}/>`;
    se.values.forEach((v, i) => {
      if (v == null) return;
      const on = highlight.includes(i);
      s += `<circle cx="${X(i)}" cy="${Y(v)}" r="${on ? 4.5 : 3}" fill="${on ? '#fff' : se.color}" stroke="${se.color}" stroke-width="2"><title>${esc(`${se.name} · ${labels[i]}: ${fmtDay(v)}`)}</title></circle>`;
      // End labels anchor inward so they never run into the date axis or off the chart.
      const anchor = n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle', lx = X(i) + (anchor === 'start' ? -4 : anchor === 'end' ? 4 : 0);
      if (pointLabels && (n <= 14 || on)) s += `<text class="ch-pt" x="${lx}" y="${Y(v) - 9}" text-anchor="${anchor}">${esc(fmtDate(v))}</text>`;
    });
    s += '</g>';
  }
  return s;
}

// Baseline Gantt: each row shows the compared plan as a solid bar over the baseline's ghost bar.
export function ganttChart(d, width, rows, fullNames = false) {
  const LW = Math.round(Math.min(360, Math.max(230, width * .28))), RW = 64, top = 30, x0 = LW, x1 = width - RW;
  const spans = rows.flatMap((r) => [r.a, r.b].filter(Boolean)).flatMap((f) => [f.start, f.end]);
  if (!spans.length) return { svg: '', height: 60 };
  const t0 = Math.min(...spans) - 2, t1 = Math.max(...spans) + 3, sc = (x1 - x0) / (t1 - t0), X = (v) => x0 + (v - t0) * sc;
  let cursor = top;
  const layout = rows.map((r) => {
    const f = r.b || r.a, indent = Math.min(f.level * 12, LW / 3), max = Math.max(12, Math.floor((LW - indent - 24) / 6.6));
    const lines = nameLines(f.name, max, fullNames ? 1000 : 2), h = Math.max(28, lines.length * 16 + 10), y = cursor;
    cursor += h; return { r, f, indent, lines, y, h };
  });
  const height = cursor + 8;
  let s = `<defs><clipPath id="an-lbl"><rect x="0" y="0" width="${LW - 10}" height="${height}"/></clipPath></defs>`;
  s += `<rect class="g-head" x="0" y="0" width="${width}" height="${top - 4}"/>`;
  for (let v = t0; v < t1;) {
    const [y, m] = ymd(v), next = Math.min(Math.floor(Date.UTC(y, m + 1, 1) / 86400000), t1), w = X(next) - X(v);
    s += `<line class="g-month" x1="${X(v)}" x2="${X(v)}" y1="0" y2="${height}"/>`;
    if (w > 30) s += `<text class="g-ax" x="${X(v) + 5}" y="17">${esc(w > 64 ? `${MONTHS[m]} ${y}` : MONTHS[m])}</text>`;
    v = next;
  }
  s += `<text class="g-ax b" x="10" y="17">Task</text><text class="g-ax b" x="${width - 8}" y="17" text-anchor="end">Finish Δ</text>`;
  layout.forEach(({ r, f, indent, lines, y, h }, i) => {
    const cy = y + h / 2, cls = r.status === 'removed' ? ' removed' : r.status === 'added' ? ' added' : '';
    if (i % 2) s += `<rect class="g-alt" x="0" y="${y}" width="${width}" height="${h}"/>`;
    s += `<g role="img" aria-label="${esc(f.name)}"><title>${esc(f.name)}</title><text class="g-name${f.summary ? ' sum' : ''}${cls}" clip-path="url(#an-lbl)">${lines.map((line, k) => `<tspan x="${10 + indent}" y="${cy - (lines.length - 1) * 8 + 4 + k * 16}">${esc(line)}</tspan>`).join('')}</text></g>`;
    const tip = `${r.name}: ${r.a ? `${fmtDay(r.a.start)} – ${fmtDay(r.a.finish)}` : 'not in baseline'} → ${r.b ? `${fmtDay(r.b.start)} – ${fmtDay(r.b.finish)}` : 'removed'}`;
    s += `<g><title>${esc(tip)}</title>`;
    if (r.a) {
      const a = r.a;
      if (a.ms) { const cx = X(a.start), q = 4; s += `<path class="g-ghost" d="M${cx} ${cy + 5 - q}L${cx + q} ${cy + 5}L${cx} ${cy + 5 + q}L${cx - q} ${cy + 5}Z"/>`; }
      else s += `<rect class="g-ghost" x="${X(a.start)}" y="${cy + 3}" width="${Math.max(2, (a.end - a.start) * sc)}" height="6" rx="1.5"/>`;
    }
    if (r.b) {
      const b = r.b, c = r.status === 'added' ? 'add' : r.finishDelta > 0 ? 'late' : r.finishDelta < 0 ? 'early' : b.summary ? 'sum' : 'same';
      if (b.ms) { const cx = X(b.start), q = 6; s += `<path class="g-bar ${c}" d="M${cx} ${cy - 3 - q}L${cx + q} ${cy - 3}L${cx} ${cy - 3 + q}L${cx - q} ${cy - 3}Z"/>`; }
      else s += `<rect class="g-bar ${c}" x="${X(b.start)}" y="${cy - 8}" width="${Math.max(2, (b.end - b.start) * sc)}" height="${b.summary ? 6 : 9}" rx="${b.summary ? 1 : 2.5}"/>`;
    }
    s += '</g>';
    const delta = r.status === 'added' ? 'new' : r.status === 'removed' ? 'removed' : r.finishDeltaWork ? signed(r.finishDeltaWork) : '';
    if (delta) s += `<text class="g-delta${r.finishDeltaWork > 0 ? ' late' : r.finishDeltaWork < 0 ? ' early' : ''}" x="${width - 8}" y="${cy + 4}" text-anchor="end">${esc(delta)}</text>`;
  });
  if (today >= t0 && today <= t1) s += `<line class="g-today" x1="${X(today) + sc / 2}" x2="${X(today) + sc / 2}" y1="${top - 4}" y2="${height}"><title>Today</title></line>`;
  s += `<line class="g-fin a" x1="${X(d.a.end)}" x2="${X(d.a.end)}" y1="${top - 4}" y2="${height}"><title>Baseline finish: ${esc(fmtDay(d.a.finish))}</title></line><line class="g-fin b" x1="${X(d.b.end)}" x2="${X(d.b.end)}" y1="${top - 4}" y2="${height}"><title>Compared finish: ${esc(fmtDay(d.b.finish))}</title></line>`;
  return { svg: s, height };
}

const HELPERS = { waterfallMarkup, waterfallChart, waterfallDetails, lineChart, setSVG };

export function createAnalysis(ctx) {
  const { store } = ctx;
  const root = document.querySelector('#analysis');
  const cache = new Map();
  const delay = createDelayAnalysis(ctx, { onEdited: () => {
    // A cause was set from the Delay log: rebuild the sections from the current plan, keeping the scroll position.
    if (!isOpen()) return;
    const body = root.querySelector('.an-body'), top = body.scrollTop;
    state.current = null; update(); body.scrollTop = top;
  } });
  let state = null, prevFocus = null;

  const viewOf = (v) => {
    const key = `${store.wb.active}:${v.id}:${v.at}`;
    if (!cache.has(key)) { try { cache.set(key, store.versionView(v.id)); } catch { cache.set(key, null); } }
    return cache.get(key);
  };
  function plans() {
    const list = store.versions().map((v) => ({ id: v.id, short: `v${v.n}`, label: `v${v.n} · ${v.name}`, at: v.at, by: v.by, note: v.note, view: viewOf(v) })).filter((p) => p.view);
    if (!state.current) { if (!store.preview) store.save(); state.current = store.view(store.wb.active); }
    list.push({ id: '', short: 'Now', label: 'Current plan', at: Date.now(), view: state.current });
    return list;
  }
  const isOpen = () => !root.hidden;

  function open(from, to = '') {
    const versions = store.versions();
    state = { a: from ?? DL.latestBaseline(versions)?.id ?? versions.at(-1)?.id ?? '', b: to, filter: 'all', search: '', onlyChanged: false, fullNames: false, trendSelected: null, waterfallSelected: 0, current: null, sheet: store.wb.active };
    if (state.a === state.b && versions.length > 1 && !from) state.a = versions.at(-2).id;
    prevFocus = document.activeElement;
    ctx.versions?.closeMenu();
    root.hidden = false; document.body.classList.add('analysis-open');
    skeleton(); update();
    diagnostics.record('analysis.open', { versionCount: versions.length, hasDelay: !!state.hasDelay });
    root.querySelector('.an-x').focus();
  }
  function close() {
    if (!isOpen()) return;
    root.hidden = true; document.body.classList.remove('analysis-open'); state = null;
    setHTML(root, '');
    diagnostics.record('analysis.close');
    if (prevFocus?.isConnected) prevFocus.focus();
  }

  function skeleton() {
    setHTML(root, `<div class="an-head">
        <div class="an-title"><b id="an-title">Version analysis</b><span title="${esc(store.sheet().name)}">${esc(store.sheet().name)}</span></div>
        <div class="an-pick"><label>Baseline <select id="an-a" aria-label="Baseline plan"></select></label>
          <button class="an-swap" data-an="swap" title="Swap baseline and comparison" aria-label="Swap baseline and comparison">⇄</button>
          <label>Compare <select id="an-b" aria-label="Compared plan"></select></label></div>
        <div class="an-actions"><button data-an="pdf" title="Download this analysis as PDF">PDF</button><button data-an="xlsx" title="Download this analysis as an Excel workbook">Excel</button>
        <button class="an-x" data-an="close" aria-label="Close version analysis" title="Close (Esc)">×</button></div>
      </div>
      <nav class="an-nav" aria-label="Analysis sections"></nav>
      <div class="an-body" tabindex="-1"></div>`);
    root.querySelector('.an-body').addEventListener('scroll', queueSection, { passive: true });
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'an-title');
  }

  function update() {
    const list = plans(), body = root.querySelector('.an-body');
    const opt = (p, sel) => `<option value="${esc(p.id)}"${p.id === sel ? ' selected' : ''}>${esc(p.label)}${p.id ? ` — ${esc(when(p.at))}` : ''}</option>`;
    const options = (sel) => [...list].reverse().map((p) => opt(p, sel)).join('');
    if (!list.some((p) => p.id === state.a)) state.a = list.at(-2)?.id ?? '';
    if (!list.some((p) => p.id === state.b)) state.b = '';
    setHTML(root.querySelector('#an-a'), options(state.a)); setHTML(root.querySelector('#an-b'), options(state.b));
    const exportable = list.length > 1 && state.a !== state.b;
    for (const b of root.querySelectorAll('[data-an=pdf],[data-an=xlsx]')) b.disabled = !exportable;
    // A plan with agreed dates (for example a duplicate) has delay analysis of its own, so it does not need a saved version first.
    const now = list.at(-1), alone = list.length < 2, aloneDelay = alone && delay.has(now.view);
    root.querySelector('.an-nav').hidden = alone && !aloneDelay;
    root.classList.toggle('an-is-empty', alone);
    if (alone) {
      state.d = null; state.hasDelay = aloneDelay;
      const empty = `<div class="an-empty${aloneDelay ? " with-delay" : ""}"><b>No versions yet</b><p>Save a snapshot to start comparing plans.${aloneDelay ? ' The delay analysis of the current plan is below.' : ''}</p><button class="primary" data-an="snap">Take snapshot…</button></div>`;
      if (aloneDelay) setHTML(root.querySelector('.an-nav'), DELAY_SECTIONS.map(([id, label]) => `<button data-go="${id}">${label}</button>`).join(''));
      setHTML(body, empty + (aloneDelay ? delay.html(now.view, [{ label: now.short, view: now.view, compared: true, live: true }], HELPERS) : ''));
      if (aloneDelay) delay.mount(root);
      return;
    }
    const A = list.find((p) => p.id === state.a), B = list.find((p) => p.id === state.b);
    const d = compareViews(A.view, B.view), log = changeLog(d), trend = trends(list.map((p) => ({ label: p.short, at: p.at, view: p.view })));
    d.waterfall = finishWaterfall(A.view, B.view);
    state.waterfallSelected = 0;
    root.querySelector('#an-a').title = `${A.label} · ${when(A.at)}`;
    root.querySelector('#an-b').title = B.id ? `${B.label} · ${when(B.at)}` : B.label;
    state.d = d; state.log = log; state.trend = trend; state.A = A; state.B = B;
    const hasDelay = delay.has(B.view);
    state.hasDelay = hasDelay;
    setHTML(root.querySelector('.an-nav'), [...SECTIONS, ...(hasDelay ? DELAY_SECTIONS : [])].map(([id, label]) => `<button data-go="${id}">${label}</button>`).join(''));
    setHTML(body, (state.a === state.b ? '<p class="an-same">Same plan selected.</p>' : '') +
      section('summary', 'Summary', summary(d)) +
      section('trends', 'Trends', `<div class="an-charts"><figure><figcaption>Finish history</figcaption><svg class="an-chart" data-chart="finish" role="img" aria-label="Forecast finish date for each version"></svg></figure><figure><figcaption>Milestone history</figcaption><svg class="an-chart" data-chart="ms" role="img" aria-label="Forecast date of each milestone for each version"></svg><div class="an-legend" data-legend="ms"></div></figure></div>`) +
      section('milestones', 'Milestones', milestones(d)) +
      section('gantt', 'Gantt comparison', `${waterfallMarkup(d.waterfall)}<div class="an-gtools"><span class="lg" title="${esc(A.label)}"><i class="ghost"></i>Baseline</span><span class="lg" title="${esc(B.label)}"><i class="same"></i>Compared</span><span class="lg"><i class="late"></i>Later</span><span class="lg"><i class="early"></i>Earlier</span><span class="lg"><i class="add"></i>New</span><span class="grow"></span><label class="vcheck"><input type="checkbox" data-an="only"${state.onlyChanged ? ' checked' : ''}> Changed only</label><label class="vcheck"><input type="checkbox" data-an="names"${state.fullNames ? ' checked' : ''}> Full names</label></div><div class="an-gwrap"><svg class="an-gantt" role="img" aria-label="Baseline Gantt comparison"></svg></div>`) +
      section('changes', 'Change log', `<div class="an-filters" role="group" aria-label="Filter changes"></div><div class="an-logwrap"></div>`) +
      section('slips', 'Biggest slips', slips(d)) +
      section('critical', 'Critical path', critical(d)) +
      section('owners', 'By owner', owners(d)) + (hasDelay ? delay.html(B.view, list.map((p) => ({ label: p.short, view: p.view, compared: p.id === B.id, live: p.id === '' })), HELPERS) : ''));
    if (hasDelay) delay.mount(root);
    renderCharts(); renderLog(); syncSection();
  }
  const section = (id, title, inner) => `<section class="an-sec" id="an-${id}" aria-labelledby="an-h-${id}"><h2 id="an-h-${id}">${title}</h2>${inner}</section>`;

  function summary(d) {
    const cards = summaryCards(d), finish = cards.find((c) => c.key === 'finish');
    const supporting = ['duration', 'progress', 'milestones', 'changes'].map((key) => cards.find((c) => c.key === key));
    return `<div class="an-outcome ${finish.tone}" data-kpi="finish"><div><span class="k-l">Project finish</span><b class="k-v">${esc(finish.value)}</b><span class="k-b">Baseline ${esc(finish.before)}</span></div><span class="k-d">${esc(finish.delta)}</span></div>
      <div class="an-kpis">${supporting.map((c) => {
        const value = c.key === 'duration' ? `${d.b.workDays}d` : c.value;
        const sub = c.key === 'milestones' ? (d.milestones.some((m) => m.status === 'slipped') ? c.sub : 'None slipped') : c.key === 'changes' ? `${d.counts.changed} items changed` : c.delta === 'No change' ? 'Unchanged' : c.key === 'duration' ? signed(d.b.workDays - d.a.workDays) : c.delta;
        return `<div class="kpi ${c.tone}" data-kpi="${c.key}"><span class="k-l">${esc(c.label)}</span><b class="k-v">${esc(value)}</b><span class="k-d">${esc(sub)}</span></div>`;
      }).join('')}</div><details class="an-more an-metrics"><summary>All metrics</summary><table class="an-t"><thead><tr><th>Metric</th><th>Baseline</th><th>Compared</th><th>Change</th></tr></thead><tbody>${cards.map((c) => `<tr><td>${esc(c.label)}</td><td>${esc(c.before || '—')}</td><td>${esc(c.value)}</td><td>${esc(c.delta)}${c.sub ? `<span class="an-sub">${esc(c.sub)}</span>` : ''}</td></tr>`).join('')}</tbody></table><p>Dates follow each saved plan. Working-day shifts use the compared calendar.</p></details>`;
  }
  function milestones(d) {
    if (!d.milestones.length) return '<p class="an-none">No milestones.</p>';
    return `<table class="an-t"><thead><tr><th>Milestone</th><th>Baseline</th><th>Compared</th><th class="n" title="Working days; calendar days shown when different">Shift</th><th>Status</th></tr></thead><tbody>${d.milestones.map((m) => `<tr><td>${esc(m.name)}${m.done ? ' <span class="chip done">Done</span>' : ''}</td><td>${esc(fmtDay(m.a))}</td><td>${esc(fmtDay(m.b))}</td><td class="n${tone(m.delta)}">${m.delta == null ? '—' : esc(`${signed(m.delta)}${m.days !== m.delta ? ` (${signed(m.days)} cal)` : ''}`)}</td><td><span class="chip st-${m.status.replace(' ', '-')}">${MILESTONE_STATUS[m.status]}</span></td></tr>`).join('')}</tbody></table>`;
  }
  function slips(d) {
    const top = d.slips.slice(0, 10);
    if (!top.length) return '<p class="an-none">No tasks slipped.</p>';
    const short = (cause) => cause.replace(/ working days?/g, 'd').replace(/^Predecessor /, '').replace(' slipped ', ' +').replace('++', '+');
    return `<table class="an-t"><thead><tr><th>Task</th><th>Owner</th><th>Baseline</th><th>Compared</th><th class="n" title="Working days">Slip</th><th>Likely cause</th></tr></thead><tbody>${top.map((s) => `<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.owner || '—')}</td><td>${esc(fmtDay(s.a))}</td><td>${esc(fmtDay(s.b))}</td><td class="n bad">${esc(signed(s.work))}</td><td>${esc(short(s.causes[0] || '—'))}${s.causes.length > 1 ? `<details class="an-inline-more"><summary>+${s.causes.length - 1} more</summary>${s.causes.slice(1).map((c) => `<p>${esc(short(c))}</p>`).join('')}</details>` : ''}</td></tr>`).join('')}</tbody></table>`;
  }
  function critical(d) {
    const c = d.critical, slack = c.slack.slice(0, 15);
    const membership = (label, rows, cls) => `<div class="an-members"><span class="an-members-label">${label} <b>${rows.length}</b></span>${rows.map((r) => `<span class="an-task-chip ${cls}" title="${esc(r.name)}">${esc(r.name)}${r.added ? ' · new' : r.removed ? ' · removed' : ''}</span>`).join('')}</div>`;
    const target = d.a.target !== d.b.target ? `${d.a.target || 'Project completion'} → ${d.b.target || 'Project completion'}` : d.b.target || 'Project completion';
    return `<div class="an-path-scope"><span title="Critical-path target">${esc(target)}</span><span>${esc(d.a.criticalMethod === d.b.criticalMethod ? d.b.criticalMethod : `${d.a.criticalMethod} → ${d.b.criticalMethod}`)}</span><span>${d.a.critical} → ${d.b.critical} critical tasks</span></div><div class="an-membership">${membership('Joined', c.became, 'bad')}${membership('Left', c.left, 'good')}</div>` +
      (slack.length ? `<h3>Slack changes${c.slack.length > slack.length ? ` · top ${slack.length}` : ''}</h3><table class="an-t"><thead><tr><th>Task</th><th class="n">Baseline</th><th class="n">Compared</th><th class="n">Change</th></tr></thead><tbody>${slack.map((s) => `<tr><td>${esc(s.name)}</td><td class="n">${s.a}d</td><td class="n">${s.b}d</td><td class="n${tone(s.delta, -1)}">${esc(signed(s.delta))}</td></tr>`).join('')}</tbody></table>` : '');
  }
  function owners(d) {
    if (!d.owners.length) return '<p class="an-none">No tasks to compare.</p>';
    const count = (n, cls = '') => `<td class="n${n ? cls : ' an-zero'}">${n}</td>`;
    return `<table class="an-t"><thead><tr><th>Owner</th><th class="n">Tasks</th><th class="n">Slipped</th><th class="n">Earlier</th><th class="n" title="Working days added or removed, excluding summaries">Work Δ</th><th class="n">Worst slip</th></tr></thead><tbody>${d.owners.map((o) => `<tr><td><strong>${esc(o.owner)}</strong>${o.added || o.removed ? `<span class="an-sub">${[o.added ? `+${o.added} added` : '', o.removed ? `−${o.removed} removed` : ''].filter(Boolean).join(' · ')}</span>` : ''}</td>${count(o.tasks)}${count(o.slipped, ' bad')}${count(o.earlier, ' good')}<td class="n${o.workDelta ? tone(o.workDelta) : ' an-zero'}">${esc(signed(o.workDelta))}</td><td class="n${o.maxSlip ? ' bad' : ' an-zero'}">${o.maxSlip ? esc(signed(o.maxSlip)) : '—'}</td></tr>`).join('')}</tbody></table><details class="an-more"><summary>About work Δ</summary><p>Working days added (+) or removed (−) through duration and scope changes. Summary rows are excluded.</p></details>`;
  }

  function setSection(id) {
    for (const button of root.querySelectorAll('[data-go]')) {
      if (button.dataset.go === id) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }
  function syncSection() {
    if (!state?.d) return;
    const body = root.querySelector('.an-body'), style = getComputedStyle(body);
    const top = body.getBoundingClientRect().top + parseFloat(style.scrollPaddingTop) + parseFloat(style.paddingTop) + 4;
    const sections = [...body.querySelectorAll('.an-sec')];
    let active = sections[0];
    for (const section of sections) if (section.getBoundingClientRect().top <= top) active = section;
    if (body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2) active = sections.at(-1);
    if (active) setSection(active.id.slice(3));
  }
  let sectionRaf = 0;
  function queueSection() {
    if (sectionRaf) return;
    sectionRaf = requestAnimationFrame(() => { sectionRaf = 0; syncSection(); });
  }

  function renderCharts() {
    if (!state?.d) return;
    const list = plans(), hl = [list.findIndex((p) => p.id === state.a), list.findIndex((p) => p.id === state.b)], labels = state.trend.labels;
    const fin = root.querySelector('[data-chart=finish]'), ms = root.querySelector('[data-chart=ms]');
    const w1 = Math.max(320, Math.round(fin.parentElement.clientWidth || 560));
    fin.setAttribute('viewBox', `0 0 ${w1} 250`); fin.setAttribute('width', w1); fin.setAttribute('height', 250);
    setSVG(fin, lineChart({ width: w1, labels, highlight: hl, pointLabels: true, series: [{ name: 'Finish', color: '#161513', values: state.trend.finish, width: 2.5 }] }));
    const series = trendSeries(state.trend).map((s, i) => ({ name: s.name, color: PALETTE[i % PALETTE.length], values: s.dates, muted: state.trendSelected != null && state.trendSelected !== i }));
    const w2 = Math.max(320, Math.round(ms.parentElement.clientWidth || 560));
    ms.setAttribute('viewBox', `0 0 ${w2} 250`); ms.setAttribute('width', w2); ms.setAttribute('height', 250);
    setSVG(ms, series.length ? lineChart({ width: w2, labels, highlight: hl, series }) : `<text class="ch-ax" x="${w2 / 2}" y="125" text-anchor="middle">No milestones in any version</text>`);
    setHTML(root.querySelector('[data-legend=ms]'), series.map((s, i) => `<button data-series="${i}" aria-pressed="${state.trendSelected === i}" title="${esc(s.name)}"><i style="background:${s.color}"></i><span>${esc(s.name)}</span></button>`).join('') + (state.trend.milestones.length > series.length ? `<span class="mut">${series.length} of ${state.trend.milestones.length} milestones</span>` : ''));
    renderWaterfall(); if (state.hasDelay) delay.resize();
    const g = root.querySelector('.an-gantt'), rows = state.onlyChanged ? state.d.rows.filter((r) => r.status !== 'same' || r.startDelta || r.finishDelta) : state.d.rows;
    const gw = Math.max(720, Math.round(g.parentElement.clientWidth || 900)), chart = ganttChart(state.d, gw, rows, state.fullNames);
    g.setAttribute('viewBox', `0 0 ${gw} ${chart.height}`); g.setAttribute('width', gw); g.setAttribute('height', chart.height);
    setSVG(g, rows.length ? chart.svg : `<text class="g-ax" x="${gw / 2}" y="34" text-anchor="middle">No rows changed</text>`);
  }

  function renderWaterfall() {
    const w = state?.d?.waterfall, chart = root.querySelector('.wf-chart');
    if (!w?.available || !chart) return;
    const style = getComputedStyle(chart.parentElement);
    const width = Math.max(320, Math.floor(chart.parentElement.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    const result = waterfallChart(w, width, state.waterfallSelected);
    chart.setAttribute('viewBox', `0 0 ${width} ${result.height}`); chart.setAttribute('width', width); chart.setAttribute('height', result.height);
    setSVG(chart, result.svg);
    const expanded = root.querySelector('.wf-explain')?.open;
    setHTML(root.querySelector('.wf-detail'), waterfallDetails(w, state.waterfallSelected));
    if (expanded) root.querySelector('.wf-explain').open = true;
    for (const row of root.querySelectorAll('[data-wf-row]')) row.classList.toggle('selected', +row.dataset.wfRow === state.waterfallSelected);
    for (const button of root.querySelectorAll('[data-wf-select]')) button.setAttribute('aria-pressed', String(+button.dataset.wfSelect === state.waterfallSelected));
  }
  function selectWaterfall(index, focusChart = false) {
    if (!state?.d?.waterfall?.steps.length) return;
    state.waterfallSelected = Math.max(0, Math.min(state.d.waterfall.steps.length - 1, index));
    renderWaterfall();
    if (focusChart) {
      const selected = root.querySelector(`[data-wf-step="${state.waterfallSelected}"]`);
      selected?.focus({ preventScroll: true }); selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function renderLog() {
    if (!state?.d) return;
    const counts = { all: state.log.length };
    for (const r of state.log) { const c = changeCategory(r); counts[c] = (counts[c] || 0) + 1; }
    if (!counts[state.filter] && state.filter !== 'all') state.filter = 'all';
    setHTML(root.querySelector('.an-filters'), [['all', 'All'], ...CHANGE_FILTERS].filter(([k]) => k === 'all' || counts[k]).map(([k, label]) => `<button class="chip2${state.filter === k ? ' on' : ''}" data-filter="${k}" aria-pressed="${state.filter === k}">${label} <em>${counts[k] || 0}</em></button>`).join('') +
      `<input type="search" class="an-search" placeholder="Search changes" aria-label="Search changes" value="${esc(state.search)}">`);
    const q = state.search.trim().toLowerCase();
    const rows = state.log.filter((r) => (state.filter === 'all' || changeCategory(r) === state.filter) && (!q || `${r.item} ${r.change} ${r.before} ${r.after}`.toLowerCase().includes(q)));
    const groups = new Map();
    for (const row of rows) {
      const key = row.area === 'Task' ? `task:${row.id}` : `${row.area}:${row.item}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const field = (r) => r.change.replace(/^(Start|Finish) moved/, '$1').replace(' changed', '').replace(/^(Task|Milestone|Summary|Relationship) /, '').replace(/^./, (c) => c.toUpperCase());
    setHTML(root.querySelector('.an-logwrap'), !state.log.length ? '<p class="an-none">No differences.</p>' : !rows.length ? '<p class="an-none">No matching changes.</p>' :
      `<table class="an-t log"><thead><tr><th>Item</th><th>Change</th><th>Baseline</th><th>Compared</th></tr></thead><tbody>${[...groups.values()].map((group) => group.map((r, i) => `<tr class="k-${r.kind}${i === 0 ? ' an-group-start' : ''}">${i === 0 ? `<td rowspan="${group.length}" class="an-log-item"><strong>${esc(r.item)}</strong>${r.area !== 'Task' ? `<span class="an-sub">${r.area === 'Relationship' ? 'Dependency' : esc(r.area)}</span>` : ''}</td>` : ''}<td>${esc(field(r))}</td><td>${esc(r.before || '—')}</td><td>${esc(r.after || '—')}</td></tr>`).join('')).join('')}</tbody></table>`);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  async function exportAs(kind) {
    if (!state?.d || state.a === state.b) return;
    const meta = { project: store.sheet().name, a: state.A, b: state.B, trend: state.trend, milestones: trendSeries(state.trend), log: state.log, delay: state.hasDelay ? delay.data(state.B.view) : null };
    const base = `${fname(meta.project)}-analysis-${state.A.short}-vs-${state.B.short}-${new Date().toISOString().slice(0, 10)}`;
    const op = diagnostics.begin('analysis.export', { kind, hasDelay: !!state.hasDelay });
    try {
      if (kind === 'pdf') download(buildAnalysisPdf(state.d, meta), `${base}.pdf`);
      else download(await buildAnalysisXlsx(state.d, meta), `${base}.xlsx`);
      op.end();
      ctx.toast(`Exported the version analysis as ${kind === 'pdf' ? 'PDF' : 'Excel'}`);
    } catch (error) { op.fail(error); console.error(error); ctx.toast(`Export failed: ${error.message}`); }
  }

  root.addEventListener('change', (e) => {
    if (e.target.id === 'an-a') { state.a = e.target.value; update(); }
    else if (e.target.id === 'an-b') { state.b = e.target.value; update(); }
    else if (e.target.dataset.an === 'only') { state.onlyChanged = e.target.checked; renderCharts(); }
    else if (e.target.dataset.an === 'names') { state.fullNames = e.target.checked; renderCharts(); }
    else if (e.target.hasAttribute('data-wf-pick')) { selectWaterfall(+e.target.value); root.querySelector('[data-wf-pick]').focus({ preventScroll: true }); }
  });
  root.addEventListener('input', (e) => { if (e.target.classList.contains('an-search')) { state.search = e.target.value; const pos = e.target.selectionStart; renderLog(); const s = root.querySelector('.an-search'); s.focus(); s.setSelectionRange(pos, pos); } });
  root.addEventListener('click', (e) => {
    const step = e.target.closest('[data-wf-step],[data-wf-select]');
    if (step) { const chart = step.hasAttribute('data-wf-step'); selectWaterfall(+(chart ? step.dataset.wfStep : step.dataset.wfSelect), chart); if (!chart) { const heading = root.querySelector('.wf-detail h3'); heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'nearest' }); } return; }
    if (e.target.closest('[data-wf-prev],[data-wf-next]')) { const next = !!e.target.closest('[data-wf-next]'); selectWaterfall(state.waterfallSelected + (next ? 1 : -1)); root.querySelector(next ? '[data-wf-next]:not(:disabled),[data-wf-prev]:not(:disabled)' : '[data-wf-prev]:not(:disabled),[data-wf-next]:not(:disabled)')?.focus({ preventScroll: true }); return; }
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.hasAttribute('data-series')) { const index = +b.dataset.series; state.trendSelected = state.trendSelected === index ? null : index; renderCharts(); root.querySelector(`[data-series="${index}"]`)?.focus({ preventScroll: true }); return; }
    if (b.dataset.filter) { state.filter = b.dataset.filter; renderLog(); root.querySelector(`[data-filter="${b.dataset.filter}"]`)?.focus(); return; }
    if (b.dataset.go) { root.querySelector(`#an-${b.dataset.go}`)?.scrollIntoView({ behavior: 'instant', block: 'start' }); syncSection(); return; }
    const a = b.dataset.an;
    if (a === 'close') close();
    else if (a === 'swap') { [state.a, state.b] = [state.b, state.a]; update(); }
    else if (a === 'pdf' || a === 'xlsx') exportAs(a);
    else if (a === 'snap') { close(); ctx.versions.snapshot(); }
  });
  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the overlay owns the keyboard while open
    const step = e.target.closest('[data-wf-step]');
    if (step && ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const current = +step.dataset.wfStep;
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? state.d.waterfall.steps.length - 1 : current + (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
      selectWaterfall(index, true); return;
    }
    if (e.key === 'Escape' && !document.querySelector('.modal-back')) { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const f = [...root.querySelectorAll('button,select,input,summary,[tabindex="0"]')].filter((x) => !x.disabled && x.getClientRects().length > 0);
      if (!f.length) return;
      const first = f[0], last = f.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  let resizeRaf = 0;
  addEventListener('resize', () => { if (!isOpen() || resizeRaf) return; resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; renderCharts(); }); });
  store.on((kind) => {
    if (!isOpen()) return;
    if (kind === 'sheet' || store.wb.active !== state.sheet) close();
    else if (kind === 'versions') update();
  });
  return { open, close, isOpen };
}
