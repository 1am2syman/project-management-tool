// Version analysis exports: an A4-landscape PDF and an Excel workbook built from the same
// comparison the overlay shows, using the dependency-free PDF and XLSX writers.
import { Page, PW, PH, M, fit, tw, pdfDocument } from './pdf.js';
import { Styles, Sheet, pack, delayLogSheet } from './xlsx.js';
import { MONTHS, ymd, today } from './model.js';
import { waterfallLayout, nameLines, contribution, stepColor } from './waterfallui.js';
import { WATERFALL_TYPES } from './finishwaterfall.js';
import { summaryCards, fmtDay, signed, MILESTONE_STATUS } from './versiondiff.js';

const COLORS = ['2B59E6', 'F59E0B', '0D9488', '7C3AED', 'E11D48', '15803D', '0891B2', 'C2410C', '64748B', 'DB2777'];
const TONE = { bad: 'BE123C', good: '15803D', same: '475569' };
const serial = (d) => (d == null ? '' : d + 25569);
const stamp = () => new Date().toISOString().slice(0, 10);
const label = (p) => (p.id ? `${p.label} (${new Date(p.at).toISOString().slice(0, 10)})` : p.label);

// ---------- PDF ----------
class Flow {
  constructor(title, sub) { this.title = title; this.sub = sub; this.pages = []; this.add(); }
  add() {
    const p = new Page(); this.pages.push(p); this.p = p;
    p.text(fit(this.title, PW - 2 * M - 120, 15, true), M, M + 12, 15, '0F172A', true);
    p.text(fit(this.sub, PW - 2 * M, 8.5), M, M + 26, 8.5, '64748B');
    this.y = M + 42; return p;
  }
  room(h) { if (this.y + h > PH - M - 16) this.add(); }
  heading(text, note = '') {
    this.room(46);
    this.p.text(text, M, this.y + 11, 11.5, '1E293B', true);
    if (note) this.p.text(fit(note, PW - 2 * M - tw(text, 11.5, true) - 12, 8), M + tw(text, 11.5, true) + 12, this.y + 11, 8, '64748B');
    this.y += 19;
  }
  note(text, col = '64748B') { this.room(14); this.p.text(fit(text, PW - 2 * M, 8), M, this.y + 9, 8, col); this.y += 14; }
  // cols: [title, width, align]; rows: [{ cells, colors?, bold? }]
  table(cols, rows, x = M) {
    const W = cols.reduce((s, c) => s + c[1], 0), rowH = 14;
    const head = () => {
      this.p.rect(x, this.y, W, 15, '1E293B'); let cx = x;
      for (const [h, w, a] of cols) { this.p.text(fit(h, w - 6, 7.5, true), a === 'r' ? cx + w - 4 : cx + 4, this.y + 10.5, 7.5, 'FFFFFF', true, a === 'r' ? 'r' : 'l'); cx += w; }
      this.y += 15;
    };
    this.room(15 + rowH); head();
    rows.forEach((r, i) => {
      if (this.y + rowH > PH - M - 16) { this.add(); head(); }
      if (i % 2) this.p.rect(x, this.y, W, rowH, 'F8F9FC');
      let cx = x;
      cols.forEach(([, w, a], c) => {
        const s = fit(String(r.cells[c] ?? ''), w - 8, 7.8, r.bold);
        this.p.text(s, a === 'r' ? cx + w - 4 : cx + 4, this.y + 9.8, 7.8, r.colors?.[c] || '0F172A', r.bold, a === 'r' ? 'r' : 'l'); cx += w;
      });
      this.p.line(x, this.y + rowH, x + W, this.y + rowH, 'EEF1F6', 0.3);
      this.y += rowH;
    });
    this.y += 10;
  }
  finish(name) {
    this.pages.forEach((p, i) => p.text(`${name}  -  version analysis  -  page ${i + 1} of ${this.pages.length}  -  exported ${stamp()}`, PW - M, PH - M + 6, 6.8, '64748B', false, 'r'));
    return this.pages;
  }
}

function pdfChart(p, x, y, w, h, title, labels, series, highlight) {
  p.rect(x, y, w, h, 'FFFFFF'); p.text(title, x, y + 9, 9, '1E293B', true);
  const values = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!values.length) { p.text('No data', x + w / 2, y + h / 2, 8, '94A3B8', false, 'c'); return; }
  let lo = Math.min(...values), hi = Math.max(...values); const pad = Math.max(2, Math.round((hi - lo) * 0.12)); lo -= pad; hi += pad;
  const pl = x + 48, pt = y + 18, pw = w - 58, ph = h - 40, n = labels.length;
  const X = (i) => pl + (n === 1 ? pw / 2 : (i * pw) / (n - 1)), Y = (v) => pt + ph - ((v - lo) / (hi - lo)) * ph;
  p.rect(pl, pt, pw, ph, 'F8FAFC');
  const span = hi - lo, step = [1, 2, 3, 7, 14, 28, 56, 91, 182, 365, 730].find((s) => span / s <= 5) || 1461;
  for (let d = Math.ceil(lo / step) * step; d <= hi; d += step) {
    const [yy, m, day] = ymd(d);
    p.line(pl, Y(d), pl + pw, Y(d), 'E2E8F0', 0.4); p.text(span > 300 ? `${MONTHS[m]} ${yy}` : `${MONTHS[m]} ${day}`, pl - 4, Y(d) + 2.5, 6.8, '64748B', false, 'r');
  }
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 30))));
  labels.forEach((l, i) => {
    const on = highlight.includes(i);
    if (on) p.line(X(i), pt, X(i), pt + ph, '94A3B8', 0.5, '2 2');
    if (i % every === 0 || i === n - 1 || on) p.text(l, X(i), pt + ph + 11, 6.8, on ? '0F172A' : '64748B', on, 'c');
  });
  for (const s of series) {
    const pts = []; let run = [];
    s.values.forEach((v, i) => { if (v == null) { if (run.length) pts.push(run); run = []; } else run.push([X(i), Y(v)]); });
    if (run.length) pts.push(run);
    for (const r of pts) if (r.length > 1) p.path(r, s.color, 1.3);
    s.values.forEach((v, i) => { if (v != null) { const cx = X(i), cy = Y(v), q = highlight.includes(i) ? 2.8 : 1.9; p.poly([[cx, cy - q], [cx + q, cy], [cx, cy + q], [cx - q, cy]], s.color); } });
  }
}

function ganttPages(flow, d, aName, bName) {
  const rows = d.rows, LW = 210, RW = 44, x0 = M + LW, x1 = PW - M - RW, rowH = 13;
  const spans = rows.flatMap((r) => [r.a, r.b].filter(Boolean)).flatMap((f) => [f.start, f.end]);
  if (!spans.length) return;
  const t0 = Math.min(...spans) - 2, t1 = Math.max(...spans) + 3, sc = (x1 - x0) / (t1 - t0), X = (v) => x0 + (v - t0) * sc;
  flow.heading('Gantt comparison', `Grey: ${aName} (baseline) · bars: ${bName} · red = finishes later, green = earlier, teal = new`);
  const head = () => {
    const p = flow.p, y = flow.y;
    p.rect(M, y, PW - 2 * M, 14, 'F1F5F9');
    for (let v = t0; v < t1;) { const [yy, m] = ymd(v), nx = Math.min(Math.floor(Date.UTC(yy, m + 1, 1) / 86400000), t1); p.line(X(v), y, X(v), y + 14, 'CBD5E1', 0.4); if (X(nx) - X(v) > 26) p.text(X(nx) - X(v) > 50 ? `${MONTHS[m]} ${yy}` : MONTHS[m], X(v) + 3, y + 10, 7, '2B59E6', true); v = nx; }
    p.text('Task', M + 4, y + 10, 7.5, '1E293B', true); p.text('Finish', PW - M - 4, y + 10, 7.5, '1E293B', true, 'r');
    flow.y += 14;
  };
  flow.room(14 + rowH * 3); head();
  let start = flow.y;
  const lines = () => { const p = flow.p; for (const fin of [d.a.end, d.b.end]) p.line(X(fin), start, X(fin), flow.y, fin === d.a.end ? '94A3B8' : 'E11D48', 0.6, '3 2'); if (today >= t0 && today <= t1) p.line(X(today), start, X(today), flow.y, '2B59E6', 0.5, '1 2'); };
  rows.forEach((r, i) => {
    if (flow.y + rowH > PH - M - 16) { lines(); flow.add(); head(); start = flow.y; }
    const p = flow.p, y = flow.y, f = r.b || r.a;
    if (i % 2) p.rect(M, y, PW - 2 * M, rowH, 'F8F9FC');
    p.text(fit(f.name, LW - 10 - f.level * 7, 7.5, f.summary), M + 4 + f.level * 7, y + 9.3, 7.5, r.status === 'removed' ? '94A3B8' : '0F172A', f.summary);
    if (r.a) { const a = r.a; if (a.ms) { const cx = X(a.start), cy = y + 9.5, q = 2.6; p.poly([[cx, cy - q], [cx + q, cy], [cx, cy + q], [cx - q, cy]], 'CBD5E1'); } else p.rect(X(a.start), y + 8.5, Math.max(1.2, (a.end - a.start) * sc), 3, 'CBD5E1'); }
    if (r.b) {
      const b = r.b, col = r.status === 'added' ? '0D9488' : r.finishDelta > 0 ? 'F43F5E' : r.finishDelta < 0 ? '15803D' : b.summary ? '334155' : '5B7CFA';
      if (b.ms) { const cx = X(b.start), cy = y + 5.5, q = 3.6; p.poly([[cx, cy - q], [cx + q, cy], [cx, cy + q], [cx - q, cy]], col); }
      else p.rect(X(b.start), y + (b.summary ? 3.5 : 2.5), Math.max(1.2, (b.end - b.start) * sc), b.summary ? 3 : 5.5, col);
    }
    const delta = r.status === 'added' ? 'new' : r.status === 'removed' ? 'removed' : r.finishDeltaWork ? signed(r.finishDeltaWork) : '';
    if (delta) p.text(delta, PW - M - 4, y + 9.3, 7.5, r.finishDeltaWork > 0 ? 'BE123C' : r.finishDeltaWork < 0 ? '15803D' : '475569', true, 'r');
    flow.y += rowH;
  });
  lines(); flow.y += 10;
}

// Keep long groups and item names intact in export tables by wrapping into continuation rows.
function wrapExport(text, max) {
  const lines = []; let rest = String(text);
  while (rest.length > max) { let at = rest.lastIndexOf(' ', max); if (at < max / 2) at = max; lines.push(rest.slice(0, at)); rest = rest.slice(at).trimStart(); }
  if (rest) lines.push(rest); return lines;
}
function waterfallRows(w) {
  return w.steps.flatMap((s) => {
    const descriptions = [...s.items.map((i) => `${i.name}${i.kind ? ` (${i.kind})` : ''}: ${i.before} > ${i.after}`), ...s.relationships.map((l) => `${l.name}: ${l.before} > ${l.after}`), s.reason, ...s.paths.map((p) => `Chain: ${p.join(' > ')}`)];
    const lines = descriptions.flatMap((text) => wrapExport(text, 60));
    const names = wrapExport(s.title, 32);
    return Array.from({ length: Math.max(names.length, lines.length, 1) }, (_, i) => ({ cells: [names[i] || '', i ? '' : WATERFALL_TYPES[s.type], lines[i] || '', i ? '' : fmtDay(s.to), i ? '' : contribution(s)], colors: [null, null, null, null, stepColor(s).slice(1)] }));
  });
}
function waterfallPages(flow, w) {
  if (!w) return;
  flow.add(); flow.heading('Why the project finish changed');
  if (!w.available) { flow.note(w.note); return; }
  flow.note(`${fmtDay(w.baseline)} > ${fmtDay(w.compared)}: ${contribution(w)} net. Working days use the compared calendar.`);
  const perPage = 5, chunks = Math.max(1, Math.ceil(w.steps.length / perPage));
  for (let page = 0; page < chunks; page++) {
    if (page) { flow.add(); flow.heading('Project finish waterfall (continued)'); }
    const steps = w.steps.slice(page * perPage, (page + 1) * perPage), start = steps[0]?.from ?? w.baseline, end = steps.at(-1)?.to ?? w.compared;
    const width = PW - 2 * M, height = 240, origin = flow.y;
    const { left, right, bottom, bar, X, Y, ticks } = waterfallLayout(w, width, height, steps, start, end), p = flow.p;
    for (const tick of ticks) { p.line(M + left, origin + Y(tick), M + width - right, origin + Y(tick), 'E2E8F0', .4); p.text(fmtDay(tick), M + left - 5, origin + Y(tick) + 3, 7, '64748B', false, 'r'); }
    const endpoint = (i, date, title) => { p.rect(M + X(i) - bar / 2, origin + Y(date), bar, Math.max(2, bottom - Y(date)), '2B59E6'); p.text(fmtDay(date), M + X(i), origin + Y(date) - 7, 8, '0F172A', true, 'c'); p.text(title, M + X(i), origin + bottom + 16, 7.5, '334155', true, 'c'); };
    endpoint(0, start, page ? 'Carried forward' : 'Baseline finish');
    let previous = start, lastX = X(0) + bar / 2;
    steps.forEach((s, i) => {
      const x = X(i + 1), top = Y(Math.max(s.from, s.to)), h = Math.abs(Y(s.from) - Y(s.to)), color = stepColor(s).slice(1);
      p.line(M + lastX, origin + Y(previous), M + x - bar / 2, origin + Y(previous), '94A3B8', .5, '3 3');
      p.rect(M + x - bar / 2, origin + top - (h ? 0 : 1), bar, Math.max(2, h), color);
      p.text(signed(s.work), M + x, origin + top - 7, 10, color, true, 'c');
      if (h > 18) p.text(fmtDay(s.to), M + x, origin + top + h / 2 + 2, 6.8, 'FFFFFF', false, 'c');
      nameLines(s.title, 19, 3).forEach((line, k) => p.text(line, M + x, origin + bottom + 16 + 11 * k, 7.2, '0F172A', true, 'c'));
      p.text(WATERFALL_TYPES[s.type], M + x, origin + height - 24, 6.7, '64748B', false, 'c');
      previous = s.to; lastX = x + bar / 2;
    });
    p.line(M + lastX, origin + Y(previous), M + X(steps.length + 1) - bar / 2, origin + Y(previous), '94A3B8', .5, '3 3');
    endpoint(steps.length + 1, end, page === chunks - 1 ? 'Compared finish' : 'Carried forward');
    flow.y += height;
  }
  flow.note('Red: delay; green: recovered time; amber: unexplained difference. Zero-effect changes are retained.');
  for (const line of wrapExport(w.method, 150)) flow.note(line);
  for (const line of wrapExport(w.note, 150)) flow.note(line);
  if (!w.steps.length) flow.note('No scheduling inputs or finish dates changed between these plans.');
  else { flow.heading('Finish contributions'); flow.table([['Item / change group', 170, 'l'], ['Change', 108, 'l'], ['Revision / explanation', 330, 'l'], ['Resulting finish', 90, 'l'], ['Project impact', 88, 'r']], waterfallRows(w)); }
}

// Delay accounting: milestone table, impact grid (key milestones) and the delay log.
const dsign = (n) => (n > 0 ? `+${n}` : n < 0 ? `-${-n}` : '0');
function delayPages(flow, dl) {
  flow.add();
  flow.heading('Delay accounting - milestones', 'Agreed, delay (working days) and expected');
  flow.table([['Milestone', 190, 'l'], ['Agreed', 80, 'l'], ['Revisions', 60, 'r'], ['Current agreed', 84, 'l'], ['Delay', 50, 'r'], ['Expected', 80, 'l'], ['Status', 100, 'l'], ['Main causes', 142, 'l']],
    dl.table.map((m) => ({ cells: [m.name, fmtDay(m.orig), m.rev ? dsign(m.rev) : '0', fmtDay(m.cur), m.delay ? dsign(m.delay) : '0', fmtDay(m.exp), m.status, m.causes.slice(0, 3).map((c) => `${c.name} ${dsign(c.days)}`).join('; ') || '-'], colors: [null, null, null, null, m.delay > 0 ? 'BE123C' : m.delay < 0 ? '15803D' : null, null, m.status.startsWith('Late') ? 'BE123C' : m.status === 'Early' ? '15803D' : null] })));
  const cols = dl.grid.cols.filter((c) => c.starred), first = Math.max(180, 786 - cols.length * 88);
  flow.heading('Impact grid', 'Each column adds up to its total against the original agreed date');
  if (cols.length) flow.table([['What changed', first, 'l'], ...cols.map((c) => [c.name, 88, 'r'])], [
    ...dl.grid.rows.filter((r) => cols.some((c) => r.effects[c.id])).map((r) => ({ cells: [r.label, ...cols.map((c) => (r.effects[c.id] ? dsign(r.effects[c.id]) : '-'))] })),
    ...(cols.some((c) => dl.grid.unexplained[c.id]) ? [{ cells: ['Other / unexplained', ...cols.map((c) => (dl.grid.unexplained[c.id] ? dsign(dl.grid.unexplained[c.id]) : '-'))] }] : []),
    { cells: ['Total vs original agreed', ...cols.map((c) => dsign(c.total))], bold: true },
  ]);
  flow.heading('Delay log', `${dl.log.length} entries`);
  if (dl.log.length) flow.table([['Date', 64, 'l'], ['Task', 150, 'l'], ['Type', 60, 'l'], ['Days', 40, 'r'], ['Cause', 110, 'l'], ['Party / approved by', 110, 'l'], ['Reason / note', 252, 'l']],
    dl.log.map((e) => ({ cells: [new Date(e.at).toISOString().slice(0, 10), e.taskName || '', e.typeLabel, e.days ? dsign(e.days) : '', e.causeLabel || '', (e.type === 'delay' ? e.party : e.approvedBy) || '', [e.reason, e.note].filter(Boolean).join(' - ')] })));
  else flow.note('No delays, revisions, inclusions or omissions recorded.');
}

export function buildAnalysisPdf(d, meta) {
  const aName = meta.a.label, bName = meta.b.label;
  const flow = new Flow(`Version analysis - ${meta.project}`, `Baseline ${label(meta.a)}  >  compared ${label(meta.b)}. Working days use the compared plan's calendar.`);
  // headline cards: two rows of five
  const cards = summaryCards(d), cw = (PW - 2 * M - 4 * 8) / 5, ch = 54;
  cards.forEach((c, i) => {
    const x = M + (i % 5) * (cw + 8), y = flow.y + Math.floor(i / 5) * (ch + 8), p = flow.p;
    p.rect(x, y, cw, ch, 'F8FAFC'); p.rect(x, y, 2.5, ch, TONE[c.tone]);
    p.text(c.label.toUpperCase(), x + 9, y + 11, 6.8, '64748B', true);
    p.text(fit(c.value, cw - 14, 12, true), x + 9, y + 26, 12, '0F172A', true);
    p.text(fit(c.delta, cw - 14, 7.8, true), x + 9, y + 37.5, 7.8, TONE[c.tone], true);
    p.text(fit(c.before ? `Baseline ${c.before}` : c.sub, cw - 14, 7), x + 9, y + 48, 7, '64748B');
  });
  flow.y += 2 * ch + 22;
  const hl = [meta.trend.at.indexOf(meta.a.at), meta.trend.at.indexOf(meta.b.at)].filter((i) => i >= 0);
  const half = (PW - 2 * M - 16) / 2, chartH = Math.min(300, PH - M - 30 - flow.y);
  pdfChart(flow.p, M, flow.y, half, chartH, 'Forecast finish across versions', meta.trend.labels, [{ color: '2B59E6', values: meta.trend.finish }], hl);
  const ms = meta.milestones.map((s, i) => ({ name: s.name, color: COLORS[i % COLORS.length], values: s.dates }));
  pdfChart(flow.p, M + half + 16, flow.y, half, chartH - 16, 'Milestone trend', meta.trend.labels, ms, hl);
  let lx = M + half + 16; const ly = flow.y + chartH - 6;
  for (const s of ms) { const w = Math.min(110, tw(s.name, 6.5) + 14); if (lx + w > PW - M) break; flow.p.rect(lx, ly - 5, 7, 4, s.color); flow.p.text(fit(s.name, w - 12, 6.5), lx + 10, ly - 1, 6.5, '475569'); lx += w; }
  flow.y += chartH + 12;

  flow.add();
  flow.heading('Milestones');
  if (d.milestones.length) flow.table([['Milestone', 300, 'l'], ['Baseline', 110, 'l'], ['Compared', 110, 'l'], ['Change (working days)', 140, 'r'], ['Status', 126, 'l']],
    d.milestones.map((m) => ({ cells: [`${m.name}${m.done ? ' (done)' : ''}`, fmtDay(m.a), fmtDay(m.b), m.delta == null ? '-' : signed(m.delta), MILESTONE_STATUS[m.status]], colors: [null, null, null, m.delta > 0 ? 'BE123C' : m.delta < 0 ? '15803D' : null, m.status === 'slipped' ? 'BE123C' : m.status === 'early' ? '15803D' : null] })));
  else flow.note('Neither plan has milestones.');
  flow.heading('Biggest slips', `${d.slips.length} tasks finish later · ${d.earlier} finish earlier · top 10 by working days`);
  if (d.slips.length) flow.table([['Task', 210, 'l'], ['Owner', 90, 'l'], ['Baseline finish', 80, 'l'], ['Compared finish', 80, 'l'], ['Slip', 46, 'r'], ['Likely cause', 280, 'l']],
    d.slips.slice(0, 10).map((s) => ({ cells: [s.name, s.owner || '-', fmtDay(s.a), fmtDay(s.b), signed(s.work), s.causes.join('; ') || '-'], colors: [null, null, null, null, 'BE123C'] })));
  else flow.note('No task finishes later.');

  if (meta.delay) delayPages(flow, meta.delay);
  waterfallPages(flow, d.waterfall);
  flow.add();
  ganttPages(flow, d, aName, bName);

  flow.add();
  flow.heading('Change log', `${meta.log.length} changes`);
  if (meta.log.length) flow.table([['Area', 70, 'l'], ['Item', 220, 'l'], ['Change', 170, 'l'], ['Baseline', 163, 'l'], ['Compared', 163, 'l']],
    meta.log.map((r) => ({ cells: [r.area, r.item, r.change, r.before, r.after], colors: [null, null, r.kind === 'added' ? '0D9488' : r.kind === 'removed' ? 'BE123C' : null] })));
  else flow.note('No differences between these plans.');

  flow.heading('Critical path', d.a.target !== d.b.target ? `Target changed from ${d.a.target || 'Project completion'} to ${d.b.target || 'Project completion'}` : `Critical path to ${d.b.target || 'Project completion'}: ${d.a.critical} > ${d.b.critical} tasks`);
  const c = d.critical, n = Math.max(c.became.length, c.left.length);
  if (n) flow.table([['Joined the critical path', 393, 'l'], ['Left the critical path', 393, 'l']], Array.from({ length: n }, (_, i) => ({ cells: [c.became[i]?.name ?? '', c.left[i]?.name ?? ''] })));
  else flow.note('No task joined or left the critical path.');
  if (c.slack.length) flow.table([['Task', 420, 'l'], ['Baseline slack', 120, 'r'], ['Compared slack', 120, 'r'], ['Change', 126, 'r']], c.slack.slice(0, 25).map((s) => ({ cells: [s.name, `${s.a}d`, `${s.b}d`, signed(s.delta)], colors: [null, null, null, s.delta < 0 ? 'BE123C' : '15803D'] })));

  flow.heading('By owner');
  flow.table([['Owner', 216, 'l'], ['Tasks', 70, 'r'], ['Slipped', 70, 'r'], ['Earlier', 70, 'r'], ['Added', 70, 'r'], ['Removed', 70, 'r'], ['Task-days', 110, 'r'], ['Worst slip', 110, 'r']],
    d.owners.map((o) => ({ cells: [o.owner, o.tasks, o.slipped, o.earlier, o.added, o.removed, signed(o.workDelta), o.maxSlip ? signed(o.maxSlip) : '-'], colors: [null, null, o.slipped ? 'BE123C' : null, o.earlier ? '15803D' : null, null, null, o.workDelta > 0 ? 'BE123C' : o.workDelta < 0 ? '15803D' : null, o.maxSlip ? 'BE123C' : null] })));
  return pdfDocument(flow.finish(meta.project));
}

// Cell-painted waterfall, following the workbook's existing dependency-free Gantt approach.
// Six contributions per block keep wide comparisons readable without exceeding Excel columns.
function waterfallExcelChart(S, sheets, w) {
  if (!w.available) return;
  const sh = new Sheet('Finish waterfall chart', '2B59E6'); sh.grid = false;
  sh.widths = [18, ...Array.from({ length: 24 }, () => 5)];
  const text = S.get({ wrap: 1, h: 'center', v: 'center', sz: 9 }), heading = S.get({ b: 1, sz: 14 }), note = S.get({ wrap: 1, color: '64748B', sz: 9 });
  const merge = (r, c, end, value, style, height) => { sh.set(r, c, value, style); sh.merges.push(`${excelColumn(c)}${r + 1}:${excelColumn(end)}${r + 1}`); if (height) sh.heights.set(r, height); };
  merge(0, 0, 24, 'Why the project finish changed', heading, 24);
  merge(1, 0, 24, `${fmtDay(w.baseline)} → ${fmtDay(w.compared)} · ${contribution(w)} net. Red = delay; green = time recovered; amber = unexplained.`, note, 28);
  const chunks = Math.max(1, Math.ceil(w.steps.length / 6));
  for (let chunk = 0; chunk < chunks; chunk++) {
    const steps = w.steps.slice(chunk * 6, (chunk + 1) * 6), start = steps[0]?.from ?? w.baseline, end = steps.at(-1)?.to ?? w.compared;
    const { lo, hi } = waterfallLayout(w, 1000, 390, steps, start, end), baseRow = 4 + chunk * 35, bins = 24;
    const stages = [{ title: chunk ? 'Carried forward' : 'Baseline finish', from: lo, to: start, color: '2B59E6' }, ...steps.map((s) => ({ title: s.title, from: s.from, to: s.to, color: stepColor(s).slice(1), step: s })), { title: chunk === chunks - 1 ? 'Compared finish' : 'Carried forward', from: lo, to: end, color: '2B59E6' }];
    for (let row = 0; row <= bins; row++) {
      const date = hi - row / bins * (hi - lo);
      sh.heights.set(baseRow + row, 11);
      if (row % 4 === 0) sh.set(baseRow + row, 0, fmtDay(Math.round(date)), S.get({ color: '64748B', sz: 8, h: 'right' }));
    }
    stages.forEach((s, i) => {
      const col = 1 + i * 3, fill = S.get({ fill: s.color });
      merge(baseRow - 1, col, col + 1, s.step ? contribution(s.step) : fmtDay(s.to), S.get({ color: s.color, b: 1, h: 'center', wrap: 1 }), 27);
      for (let row = 0; row <= bins; row++) {
        const a = hi - (row + .5) / bins * (hi - lo), b = hi - (row - .5) / bins * (hi - lo);
        if (Math.min(s.from, s.to) <= b && Math.max(s.from, s.to) >= a) { sh.set(baseRow + row, col, '', fill); sh.set(baseRow + row, col + 1, '', fill); }
      }
      merge(baseRow + bins + 1, col, col + 2, s.title, text, 62);
      merge(baseRow + bins + 2, col, col + 2, s.step ? WATERFALL_TYPES[s.step.type] : fmtDay(s.to), note, 30);
    });
  }
  merge(4 + chunks * 35, 0, 24, w.method, note, 38);
  sheets.push(sh);
}
function excelColumn(index) { let label = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label; return label; }

// ---------- Excel ----------
export async function buildAnalysisXlsx(d, meta) {
  const S = new Styles(), sheets = [];
  const head = S.get({ b: 1, color: 'FFFFFF', fill: '1E293B', h: 'center', v: 'center', wrap: 1, bb: '0F172A' });
  const title = S.get({ b: 1, sz: 14 }), sub = S.get({ color: '64748B' }), txt = S.get({}), bold = S.get({ b: 1 });
  const date = S.get({ fmt: 'mmm d, yyyy', h: 'center' }), num = S.get({ fmt: '0', h: 'center' }), pct = S.get({ fmt: '0%', h: 'center' });
  const bad = S.get({ fmt: '+0;-0;0', h: 'center', color: 'BE123C', b: 1 }), good = S.get({ fmt: '+0;-0;0', h: 'center', color: '15803D', b: 1 }), flat = S.get({ fmt: '+0;-0;0', h: 'center' });
  const deltaStyle = (n, worse = 1) => (!n ? flat : n * worse > 0 ? bad : good);
  const table = (name, tab, widths, cols, rows, top = []) => {
    const sh = new Sheet(name, tab); sh.widths = widths; let r = 0;
    for (const [v, s] of top) sh.set(r++, 0, v, s);
    if (top.length) r++;
    cols.forEach((h, c) => sh.set(r, c, h, head)); sh.heights.set(r, 22);
    sh.freeze = [0, r + 1]; const first = r;
    for (const row of rows) { r++; row.forEach(([v, s], c) => sh.set(r, c, v, s ?? txt)); }
    if (rows.length) sh.filter = `A${first + 1}:${String.fromCharCode(64 + cols.length)}${r + 1}`;
    sheets.push(sh); return sh;
  };
  const intro = [[`Version analysis · ${meta.project}`, title], [`Baseline ${label(meta.a)} → compared ${label(meta.b)} · exported ${stamp()}`, sub]];

  const a = d.a, b = d.b;
  table('Summary', '2B59E6', [26, 18, 18, 16, 40], ['Measure', 'Baseline', 'Compared', 'Change', 'Note'], [
    [['Start', bold], [serial(a.start), date], [serial(b.start), date], [d.start.days, flat], ['Calendar days']],
    [['Finish', bold], [serial(a.finish), date], [serial(b.finish), date], [d.finish.work, deltaStyle(d.finish.work)], [`Working days (${signed(d.finish.days, '')} calendar days)`]],
    [['Duration (working days)', bold], [a.workDays, num], [b.workDays, num], [b.workDays - a.workDays, deltaStyle(b.workDays - a.workDays)], ['']],
    [['Duration (calendar days)', bold], [a.calendarDays, num], [b.calendarDays, num], [b.calendarDays - a.calendarDays, deltaStyle(b.calendarDays - a.calendarDays)], ['']],
    [['Tasks', bold], [a.tasks, num], [b.tasks, num], [b.tasks - a.tasks, flat], [`${d.counts.added} row${d.counts.added === 1 ? '' : 's'} added, ${d.counts.removed} removed`]],
    [['Milestones', bold], [a.milestones, num], [b.milestones, num], [b.milestones - a.milestones, flat], ['']],
    [['Relationships', bold], [a.links, num], [b.links, num], [b.links - a.links, flat], [`${d.counts.links} relationship changes`]],
    [['Complete', bold], [a.progress / 100, pct], [b.progress / 100, pct], [b.progress - a.progress, deltaStyle(b.progress - a.progress, -1)], ['Percentage points, duration-weighted']],
    [['Critical tasks', bold], [a.critical, num], [b.critical, num], [b.critical - a.critical, flat], [`Target: ${b.target || 'Project completion'}`]],
    [['Violated links', bold], [a.violated, num], [b.violated, num], [b.violated - a.violated, deltaStyle(b.violated - a.violated)], ['']],
    [['Changes', bold], ['', txt], [meta.log.length, num], ['', txt], [`${d.counts.changed} tasks changed, ${d.counts.calendar} calendar changes`]],
  ], intro).filter = null;

  const trendCols = ['Version', 'Saved', 'Forecast finish', ...meta.milestones.map((m) => m.name.slice(0, 60))];
  table('Trends', 'F59E0B', [12, 18, 16, ...meta.milestones.map(() => 18)], trendCols,
    meta.trend.labels.map((l, i) => [[l, bold], [new Date(meta.trend.at[i]).toISOString().slice(0, 10)], [serial(meta.trend.finish[i]), date], ...meta.milestones.map((m) => [serial(m.dates[i]), date])]));

  table('Milestones', 'F59E0B', [40, 16, 16, 14, 14, 12], ['Milestone', 'Baseline', 'Compared', 'Working days', 'Calendar days', 'Status'],
    d.milestones.map((m) => [[m.name], [serial(m.a), date], [serial(m.b), date], [m.delta ?? '', m.delta == null ? txt : deltaStyle(m.delta)], [m.days ?? '', m.days == null ? txt : flat], [MILESTONE_STATUS[m.status]]]));

  table('Gantt comparison', '5B7CFA', [6, 44, 10, 14, 14, 14, 14, 12, 12, 12], ['ID', 'Task', 'Status', 'Baseline start', 'Baseline finish', 'Compared start', 'Compared finish', 'Start Δ days', 'Finish Δ days', 'Finish Δ work'],
    d.rows.map((r) => { const f = r.b || r.a; return [[r.id, num], [`${'   '.repeat(f.level)}${f.name}`, f.summary ? bold : txt], [r.status], [serial(r.a?.start), date], [serial(r.a?.finish), date], [serial(r.b?.start), date], [serial(r.b?.finish), date], [r.startDelta ?? '', flat], [r.finishDelta ?? '', r.finishDelta == null ? txt : deltaStyle(r.finishDelta)], [r.finishDeltaWork ?? '', r.finishDeltaWork == null ? txt : deltaStyle(r.finishDeltaWork)]]; }));

  table('Change log', '7C3AED', [14, 40, 30, 32, 32], ['Area', 'Item', 'Change', 'Baseline', 'Compared'], meta.log.map((r) => [[r.area], [r.item], [r.change], [r.before], [r.after]]));

  table('Biggest slips', 'E11D48', [36, 18, 16, 16, 12, 60], ['Task', 'Owner', 'Baseline finish', 'Compared finish', 'Slip (working days)', 'Likely cause'],
    d.slips.map((s) => [[s.name], [s.owner], [serial(s.a), date], [serial(s.b), date], [s.work, bad], [s.causes.join('; ')]]));

  const c = d.critical;
  table('Critical path', 'F43F5E', [40, 14, 16, 16, 12], ['Task', 'Change', 'Baseline slack', 'Compared slack', 'Slack Δ'], [
    ...c.became.map((r) => [[r.name], [r.added ? 'Joined (new task)' : 'Joined']]),
    ...c.left.map((r) => [[r.name], [r.removed ? 'Left (removed)' : 'Left']]),
    ...c.slack.map((s) => [[s.name], ['Slack changed'], [s.a, num], [s.b, num], [s.delta, deltaStyle(s.delta, -1)]]),
  ]);

  table('By owner', '0D9488', [28, 10, 10, 10, 10, 10, 12, 12], ['Owner', 'Tasks', 'Slipped', 'Earlier', 'Added', 'Removed', 'Task-days Δ', 'Worst slip'],
    d.owners.map((o) => [[o.owner], [o.tasks, num], [o.slipped, num], [o.earlier, num], [o.added, num], [o.removed, num], [o.workDelta, deltaStyle(o.workDelta)], [o.maxSlip || '', o.maxSlip ? bad : txt]]));
  if (meta.delay) {
    const dl = meta.delay, nd = (n) => (n ? n : 0);
    table('Delay milestones', 'F43F5E', [34, 16, 12, 16, 12, 16, 22, 50], ['Milestone', 'Agreed', 'Revisions', 'Current agreed', 'Delay', 'Expected', 'Status', 'Main causes'],
      dl.table.map((m) => [[m.name, bold], [serial(m.orig), date], [nd(m.rev), flat], [serial(m.cur), date], [nd(m.delay), deltaStyle(m.delay)], [serial(m.exp), date], [m.status], [m.causes.map((c) => `${c.name} ${signed(c.days)}`).join('; ')]]));
    const cols = dl.grid.cols;
    table('Impact grid', 'F43F5E', [46, ...cols.map(() => 16)], ['What changed', ...cols.map((c) => c.name)], [
      ...dl.grid.rows.map((r) => [[r.label], ...cols.map((c) => [r.effects[c.id] || 0, deltaStyle(r.effects[c.id] || 0)])]),
      [['Other / unexplained'], ...cols.map((c) => [dl.grid.unexplained[c.id] || 0, deltaStyle(dl.grid.unexplained[c.id] || 0)])],
      [['Total vs original agreed', bold], ...cols.map((c) => [c.total, deltaStyle(c.total)])],
    ]);
    sheets.push(delayLogSheet(S, dl.log, 'Delay log', 'F43F5E'));
  }
  if (d.waterfall) {
    const w = d.waterfall;
    const wrap = S.get({ wrap: 1, v: 'top' });
    const sh = table('Finish waterfall', '2B59E6', [8, 42, 24, 55, 55, 18, 18, 15, 15, 80, 80], ['Step', 'Item / change group', 'Change', 'Baseline value', 'Compared value', 'Finish before', 'Finish after', 'Working days', 'Calendar days', 'Explanation', 'Affected chains'],
      w.steps.map((s, i) => [[i + 1, num], [s.title, wrap], [WATERFALL_TYPES[s.type], wrap], [[...s.items.map((item) => `${item.name}: ${item.before}`), ...s.relationships.map((l) => `${l.name}: ${l.before}`)].join('\n'), wrap], [[...s.items.map((item) => `${item.name}: ${item.after}`), ...s.relationships.map((l) => `${l.name}: ${l.after}`)].join('\n'), wrap], [serial(s.from), date], [serial(s.to), date], [s.work, deltaStyle(s.work)], [s.days, deltaStyle(s.days)], [s.reason, wrap], [s.paths.map((path) => path.join(' → ')).join('\n'), wrap]]),
      [[`Project finish waterfall · ${meta.project}`, title], [`${fmtDay(w.baseline)} → ${fmtDay(w.compared)} · ${contribution(w)} net`, bold], [w.method, wrap], [w.note || '', wrap], [w.available ? (w.steps.length ? 'Contributions are ordered replay effects; each joint group is counted once.' : 'No scheduling inputs or finish dates changed.') : w.note, wrap]]);
    // Wrapped content and explicit row heights keep names and grouped changes readable in Excel.
    for (let r = 0; r < 5; r++) { sh.merges.push(`A${r + 1}:K${r + 1}`); sh.heights.set(r, r === 2 || r === 3 ? 32 : 23); }
    w.steps.forEach((s, i) => sh.heights.set(7 + i, Math.max(58, Math.min(409, 16 * Math.max(s.items.length * 3, s.relationships.length * 3, Math.ceil(s.reason.length / 80))))));
    waterfallExcelChart(S, sheets, w);
  }
  return pack(S, sheets);
}
