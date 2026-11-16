// Dependency-free vector PDF writer: A4 landscape, paginated task table + Gantt (bars, progress,
// summaries, milestones, FS/SS/FF/SF links, critical path, today line). Standard Helvetica fonts.
import { MONTHS, dow, fmtDate, today, ymd, DAY } from './model.js';

const PW = 842, PH = 595, M = 28;
const MAP = { 0x2013: 0x96, 0x2014: 0x97, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2192: 0x3E, 0x25C6: 0x2A };
const latin = (s) => {
  let o = '';
  for (const ch of String(s)) { const c = ch.codePointAt(0); const m = c <= 255 && !(c >= 128 && c <= 159) ? c : MAP[c] ?? 63; o += m < 32 ? ' ' : String.fromCharCode(m); }
  return o;
};
const pdfStr = (s) => `(${latin(s).replace(/([\\()])/g, '\\$1')})`;
const rgb = (hex) => [0, 2, 4].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
const n2 = (v) => (Math.round(v * 100) / 100).toString();

const NARROW = new Set("iljt.,;:'|!()[]/ I`".split('')), MID = new Set('frt-"*'.split('')), WIDE = new Set('mwMW@%'.split(''));
function tw(s, size, bold) {
  let w = 0;
  for (const ch of latin(s)) w += NARROW.has(ch) ? 0.27 : MID.has(ch) ? 0.34 : WIDE.has(ch) ? 0.86 : ch >= '0' && ch <= '9' ? 0.556 : ch >= 'A' && ch <= 'Z' ? 0.68 : 0.52;
  return w * size * (bold ? 1.06 : 1);
}
function fit(s, maxW, size, bold) {
  s = String(s); if (tw(s, size, bold) <= maxW) return s;
  while (s.length > 1 && tw(`${s}...`, size, bold) > maxW) s = s.slice(0, -1);
  return `${s}...`;
}
const monday = (d) => d - ((dow(d) + 6) % 7);

class Page {
  constructor() { this.o = []; }
  rect(x, y, w, h, fill) { if (w <= 0 || h <= 0) return; this.o.push(`${rgb(fill)} rg ${n2(x)} ${n2(PH - y - h)} ${n2(w)} ${n2(h)} re f`); }
  line(x1, y1, x2, y2, col, w = 0.5, dash) { this.o.push(`${dash ? `[${dash}] 0 d ` : ''}${rgb(col)} RG ${n2(w)} w ${n2(x1)} ${n2(PH - y1)} m ${n2(x2)} ${n2(PH - y2)} l S${dash ? ' [] 0 d' : ''}`); }
  poly(pts, fill) { this.o.push(`${rgb(fill)} rg ${pts.map(([x, y], i) => `${n2(x)} ${n2(PH - y)} ${i ? 'l' : 'm'}`).join(' ')} f`); }
  path(pts, col, w = 0.6, dash) { this.o.push(`${dash ? `[${dash}] 0 d ` : ''}${rgb(col)} RG ${n2(w)} w 1 j 1 J ${pts.map(([x, y], i) => `${n2(x)} ${n2(PH - y)} ${i ? 'l' : 'm'}`).join(' ')} S${dash ? ' [] 0 d' : ''}`); }
  text(s, x, baseY, size, col = '0F172A', bold = false, align = 'l') {
    s = String(s); if (!s) return;
    const w = tw(s, size, bold), xx = align === 'r' ? x - w : align === 'c' ? x - w / 2 : x;
    this.o.push(`BT /${bold ? 'F2' : 'F1'} ${n2(size)} Tf ${rgb(col)} rg ${n2(xx)} ${n2(PH - baseY)} Td ${pdfStr(s)} Tj ET`);
  }
  clip(x, y, w, h, fn) { this.o.push(`q ${n2(x)} ${n2(PH - y - h)} ${n2(w)} ${n2(h)} re W n`); fn(); this.o.push('Q'); }
  stream() { return this.o.join('\n'); }
}

function route(ax, ay, dA, bx, by, dF, g, rowH) {
  let lo = -Infinity, hi = Infinity;
  if (dA > 0) lo = Math.max(lo, ax + g); else hi = Math.min(hi, ax - g);
  if (dF > 0) hi = Math.min(hi, bx - g); else lo = Math.max(lo, bx + g);
  if (lo <= hi) { const xm = dA > 0 ? lo : hi; return [[ax, ay], [xm, ay], [xm, by], [bx, by]]; }
  const a1 = ax + dA * g, b1 = bx - dF * g, my = by >= ay ? ay + rowH / 2 : ay - rowH / 2;
  return [[ax, ay], [a1, ay], [a1, my], [b1, my], [b1, by], [bx, by]];
}

function projectPages(st, name, pages) {
  const crit = st.critical, P = st.project, tasks = st.tasks, n = tasks.length;
  const t0 = monday(P.start) - 1, t1 = P.end + 3, span = t1 - t0;
  const cols = [['#', 16, 'r'], ['Task', 170, 'l'], ['Start', 40, 'c'], ['End', 40, 'c'], ['Days', 24, 'r'], ['Done', 28, 'r']];
  const tableW = cols.reduce((a, c) => a + c[1], 0), gx0 = M + tableW + 8, gw = PW - M - gx0, sc = gw / span;
  const target = st.criticalTarget();
  const topBlock = M + (target ? 52 : 38), hdrH = 24, footH = 26, avail = PH - topBlock - hdrH - footH;
  const rowH = Math.max(11, Math.min(18, avail / Math.max(n, 1))), perPage = Math.max(1, Math.floor(avail / rowH));
  const count = Math.max(1, Math.ceil(n / perPage));
  const X = (d) => gx0 + (d - t0) * sc;
  const done = st.tasks.filter((t) => !st.info.get(t.id).summary && t.progress >= 100).length, leaves = st.tasks.filter((t) => !st.info.get(t.id).summary).length;

  for (let pg = 0; pg < count; pg++) {
    const p = new Page(), i0 = pg * perPage, i1 = Math.min(n, i0 + perPage), y0 = topBlock + hdrH;
    p.text(name, M, M + 12, 16, '0F172A', true);
    p.text(`${fmtDate(P.start)} \u2192 ${fmtDate(P.end - 1)}  \u00B7  ${st.work.count(P.start, P.end)} working days  \u00B7  ${leaves} tasks (${done} done)  \u00B7  critical path: ${st.critCount} tasks`.replace('\u2192', '>'), M, M + 26, 8.5, '64748B');
    p.text(`${ymd(P.start)[0]}${ymd(P.start)[0] !== ymd(P.end - 1)[0] ? `\u2013${ymd(P.end - 1)[0]}` : ''}`, PW - M, M + 12, 10, '94A3B8', true, 'r');

    if (target) p.text(fit(`Critical-path target: ${target.name}`, PW - 2 * M, 8.5), M, M + 39, 8.5, 'BE123C');

    // header band
    p.rect(M, topBlock, tableW, hdrH, '1E293B'); p.rect(gx0, topBlock, gw, hdrH, 'F6F7FA');
    let cx = M; cols.forEach(([h, w, a]) => { p.text(h, a === 'r' ? cx + w - 3 : a === 'c' ? cx + w / 2 : cx + 4, topBlock + 15, 7.5, 'FFFFFF', true, a); cx += w; });
    // month tier + week tier
    for (let d = t0; d < t1;) {
      const [y, m] = ymd(d), nb = Math.min(Date.UTC(y, m + 1, 1) / DAY, t1), xa = X(d), xb = X(nb), w = xb - xa;
      p.line(xa, topBlock, xa, PH - footH, 'D5DBE7', 0.35);
      p.clip(xa, topBlock, w, 11, () => p.text(w >= 52 ? `${MONTHS[m]} ${y}` : w >= 22 ? MONTHS[m] : '', xa + 3, topBlock + 8.5, 7.5, '2B59E6', true));
      d = nb;
    }
    p.line(gx0, topBlock + 11.5, gx0 + gw, topBlock + 11.5, 'D5DBE7', 0.4);
    if (sc * 7 >= 13) for (let d = monday(t0); d < t1; d += 7) { if (d >= t0) { p.line(X(d), topBlock + 11.5, X(d), PH - footH, 'EEF1F6', 0.3); p.text(ymd(d)[2], X(d) + 1.5, topBlock + 20, 6.5, '64748B', false); } }

    // rows
    for (let i = i0; i < i1; i++) {
      const t = tasks[i], f = st.info.get(t.id), y = y0 + (i - i0) * rowH, sum = f.summary, c = crit && f.critical && !sum;
      if (sum) p.rect(M, y, tableW, rowH, 'EEF1F6'); else if ((i - i0) % 2) p.rect(M, y, tableW, rowH, 'F8F9FC');
      if ((i - i0) % 2 || sum) p.rect(gx0, y, gw, rowH, sum ? 'F4F6FA' : 'F8F9FC');
      p.line(M, y + rowH, gx0 + gw, y + rowH, 'EEF1F6', 0.3);
      const fs = Math.min(8, rowH - 3.6), by = y + rowH / 2 + fs * 0.34, ms = t.ms && !sum;
      let x = M;
      const put = (s, w, a, col = '0F172A', b = false) => { const tx = a === 'r' ? x + w - 3 : a === 'c' ? x + w / 2 : x + 4; p.clip(x, y, w, rowH, () => p.text(s, tx, by, fs, col, b, a)); x += w; };
      put(i + 2, cols[0][1], 'r', '94A3B8');
      const ind = t.level * 7, tx = x + 4 + ind;
      p.clip(x, y, cols[1][1], rowH, () => p.text(fit(t.name, cols[1][1] - 8 - ind, fs, sum), tx, by, fs, c ? 'BE123C' : '0F172A', sum));
      x += cols[1][1];
      put(fmtDate(f.start), cols[2][1], 'c', '475569'); put(fmtDate(ms ? t.start : f.end - 1), cols[3][1], 'c', '475569');
      put(ms ? '-' : st.duration(t.id), cols[4][1], 'r', '475569'); put(`${Math.round(f.progress)}%`, cols[5][1], 'r', f.progress >= 100 ? '15803D' : '475569');
    }
    // Nonworking dates follow this project's calendar, including custom holidays.
    if (sc >= 1) for (let d = t0; d < t1; d++) if (!st.work.isWork(d)) p.rect(X(d), y0, sc, (i1 - i0) * rowH, 'EEF1F6');
    p.line(M, y0, M, y0 + (i1 - i0) * rowH, 'E2E8F0', 0.4);
    // today
    if (today >= t0 && today < t1) { const x = X(today) + sc / 2; p.line(x, topBlock + hdrH, x, y0 + (i1 - i0) * rowH, '2B59E6', 0.8, '2 2'); p.poly([[x - 3, topBlock + hdrH], [x + 3, topBlock + hdrH], [x, topBlock + hdrH + 4]], '2B59E6'); }

    // links
    const idx = new Map(); for (let i = i0; i < i1; i++) idx.set(tasks[i].id, i);
    for (const l of st.links) {
      const a = idx.get(l.from), b = idx.get(l.to); if (a == null || b == null) continue;
      const fe = l.type[0], te = l.type[1], A = st.info.get(l.from), B = st.info.get(l.to), mhA = st.byId.get(l.from).ms ? rowH * 0.34 + 1.5 : 0, mhB = st.byId.get(l.to).ms ? rowH * 0.34 + 1.5 : 0;
      const ax = fe === 'F' ? X(A.end) + mhA : X(A.start) - mhA, bx = te === 'F' ? X(B.end) + mhB : X(B.start) - mhB;
      const ay = y0 + (a - i0) * rowH + rowH / 2, by = y0 + (b - i0) * rowH + rowH / 2, dA = fe === 'F' ? 1 : -1, dF = te === 'S' ? 1 : -1;
      const col = l.violated ? 'F59E0B' : crit && l.critical ? 'F43F5E' : '94A3B8';
      p.path(route(ax, ay, dA, bx, by, dF, 3, rowH), col, crit && l.critical ? 0.8 : 0.55, l.violated ? '2 1.5' : undefined);
      p.poly([[bx, by], [bx - dF * 3.6, by - 2.1], [bx - dF * 3.6, by + 2.1]], col);
    }
    // bars
    for (let i = i0; i < i1; i++) {
      const t = tasks[i], f = st.info.get(t.id), y = y0 + (i - i0) * rowH, cy = y + rowH / 2, sum = f.summary, ms = t.ms && !sum, c = crit && f.critical, x1 = X(f.start), x2 = X(f.end), bh = rowH * 0.56;
      if (sum) { const h = Math.max(2.4, rowH * 0.24), yy = cy - h / 2 - 0.5; p.rect(x1, yy, x2 - x1, h, '334155'); p.rect(x1, yy, (x2 - x1) * f.progress / 100, h, '0B1220'); p.poly([[x1, yy + h], [x1 + 3.2, yy + h], [x1, yy + h + 3.2]], '334155'); p.poly([[x2, yy + h], [x2 - 3.2, yy + h], [x2, yy + h + 3.2]], '334155'); }
      else if (ms) { const r = rowH * 0.34; p.poly([[x1, cy - r], [x1 + r, cy], [x1, cy + r], [x1 - r, cy]], c ? 'F43F5E' : t.progress >= 100 ? '94A3B8' : 'F59E0B'); }
      else { const w = Math.max(1.5, x2 - x1); p.rect(x1, cy - bh / 2, w, bh, c ? 'F43F5E' : '5B7CFA'); p.rect(x1, cy - bh / 2, w * f.progress / 100, bh, c ? 'BE123C' : '3A5BDC'); }
    }
    // footer
    const fy = PH - M + 4; let lx = M;
    const sw = (col, label, shape) => { if (shape === 'm') p.poly([[lx + 3, fy - 6], [lx + 6, fy - 3], [lx + 3, fy], [lx, fy - 3]], col); else if (shape === 'l') p.line(lx, fy - 3, lx + 8, fy - 3, col, 0.8); else p.rect(lx, fy - 6, 8, 5, col); p.text(label, lx + 11, fy - 0.5, 6.8, '64748B'); lx += 14 + tw(label, 6.8); };
    sw('5B7CFA', 'Task'); if (crit) sw('F43F5E', 'Critical'); sw('334155', 'Summary'); sw('F59E0B', 'Milestone', 'm'); sw('94A3B8', 'Link', 'l');
    p.text(`${name}  -  page ${pg + 1} of ${count}  -  exported ${new Date().toISOString().slice(0, 10)}`, PW - M, fy, 6.8, '64748B', false, 'r'); // page numbers are per project
    pages.push(p);
  }
}

export function buildPdf(projects) {
  const pages = [];
  for (const pr of projects) projectPages(pr.store, pr.name, pages);
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((p, i) => {
    const body = p.stream();
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  });
  let out = '%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const u8 = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i) & 255;
  return new Blob([u8], { type: 'application/pdf' });
}
