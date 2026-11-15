// Dependency-free .xlsx writer: styled Tasks sheet (outline groups, freeze panes, filters) and a
// cell-painted Gantt sheet per project. Zip container is written by hand (deflate when available).
import { ymd, dow, MONTHS, today } from './model.js';

const enc = new TextEncoder();
const esc = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colL = (n) => { let s = ''; let k = n + 1; while (k > 0) { const r = (k - 1) % 26; s = String.fromCharCode(65 + r) + s; k = Math.floor((k - 1) / 26); } return s; };
const monday = (d) => d - ((dow(d) + 6) % 7);
const serial = (d) => d + 25569; // unix-day -> Excel serial

// ---------- style registry ----------
const BUILTIN_FMT = { '0': 1, '0%': 9 };
class Styles {
  constructor() {
    this.fonts = [this.fontXml({})];
    this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.fmts = []; this.cache = new Map();
  }
  fontXml(o) { return `<font>${o.b ? '<b/>' : ''}${o.i ? '<i/>' : ''}<sz val="${o.sz || 10}"/><color rgb="FF${o.color || '0F172A'}"/><name val="Calibri"/><family val="2"/></font>`; }
  idx(arr, xml) { let i = arr.indexOf(xml); if (i < 0) { i = arr.length; arr.push(xml); } return i; }
  get(o = {}) {
    const key = JSON.stringify(o); if (this.cache.has(key)) return this.cache.get(key);
    const font = this.idx(this.fonts, this.fontXml(o));
    const fill = o.fill ? this.idx(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${o.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const border = o.bb ? this.idx(this.borders, `<border><left/><right/><top/><bottom style="thin"><color rgb="FF${o.bb}"/></bottom><diagonal/></border>`) : 0;
    let nf = 0;
    if (o.fmt) { if (BUILTIN_FMT[o.fmt] != null) nf = BUILTIN_FMT[o.fmt]; else { let i = this.fmts.indexOf(o.fmt); if (i < 0) { i = this.fmts.length; this.fmts.push(o.fmt); } nf = 164 + i; } }
    const al = o.h || o.v || o.indent || o.wrap ? `<alignment horizontal="${o.h || 'general'}" vertical="${o.v || 'center'}"${o.indent ? ` indent="${o.indent}"` : ''}${o.wrap ? ' wrapText="1"' : ''}/>` : '';
    const xf = `<xf numFmtId="${nf}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${al ? ' applyAlignment="1">' + al + '</xf>' : '/>'}`;
    const i = this.xfs.push(xf) - 1; this.cache.set(key, i); return i;
  }
  xml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      (this.fmts.length ? `<numFmts count="${this.fmts.length}">${this.fmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>` : '') +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts><fills count="${this.fills.length}">${this.fills.join('')}</fills><borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
}

// ---------- sheet ----------
class Sheet {
  constructor(name, tab) { this.name = name; this.tab = tab; this.rows = new Map(); this.widths = []; this.merges = []; this.freeze = null; this.filter = null; this.heights = new Map(); this.outline = new Map(); this.grid = true; this.maxC = 0; this.landscape = true; this.validations = []; }
  set(r, c, v, s = 0) { if (!this.rows.has(r)) this.rows.set(r, new Map()); this.rows.get(r).set(c, { v, s }); this.maxC = Math.max(this.maxC, c); }
  cellXml(r, c, { v, s }) {
    const ref = `${colL(c)}${r + 1}`;
    if (v == null || v === '') return `<c r="${ref}" s="${s}"/>`;
    if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${Number.isFinite(v) ? v : 0}</v></c>`;
    return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }
  xml() {
    const rs = [...this.rows.keys()].sort((a, b) => a - b), lastR = rs.length ? rs[rs.length - 1] : 0, maxOut = Math.max(0, ...this.outline.values());
    let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`;
    x += `<sheetPr><tabColor rgb="FF${this.tab || '5B7CFA'}"/><outlinePr summaryBelow="0"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colL(this.maxC)}${lastR + 1}"/>`;
    x += `<sheetViews><sheetView workbookViewId="0"${this.grid ? '' : ' showGridLines="0"'}>`;
    if (this.freeze) {
      const [fc, fr] = this.freeze, tl = `${colL(fc)}${fr + 1}`;
      x += `<pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${tl}" activePane="${fc && fr ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight'}" state="frozen"/>`;
      if (fc && fr) x += `<selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="${tl}" sqref="${tl}"/>`;
    }
    x += `</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"${maxOut ? ` outlineLevelRow="${maxOut}"` : ''}/>`;
    if (this.widths.length) x += `<cols>${this.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
    x += '<sheetData>';
    for (const r of rs) {
      const cells = this.rows.get(r), h = this.heights.get(r), o = this.outline.get(r);
      x += `<row r="${r + 1}"${h ? ` ht="${h}" customHeight="1"` : ''}${o ? ` outlineLevel="${o}"` : ''}>`;
      for (const c of [...cells.keys()].sort((a, b) => a - b)) x += this.cellXml(r, c, cells.get(c));
      x += '</row>';
    }
    x += '</sheetData>';
    if (this.filter) x += `<autoFilter ref="${this.filter}"/>`;
    if (this.merges.length) x += `<mergeCells count="${this.merges.length}">${this.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`;
    if (this.validations.length) x += `<dataValidations count="${this.validations.length}">${this.validations.map((v) => `<dataValidation type="${v.type}"${v.op ? ` operator="${v.op}"` : ''} allowBlank="1" showErrorMessage="1" errorTitle="${esc(v.title || 'Invalid value')}" error="${esc(v.error || '')}" sqref="${v.ref}">${v.f1 != null ? `<formula1>${esc(v.f1)}</formula1>` : ''}${v.f2 != null ? `<formula2>${esc(v.f2)}</formula2>` : ''}</dataValidation>`).join('')}</dataValidations>`;
    x += `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="${this.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/></worksheet>`;
    return x;
  }
}

// ---------- sheet builders ----------
const WK = { n: '5B7CFA', d: '3A5BDC', cn: 'F43F5E', cd: 'E11D48', sum: '334155', ms: 'F59E0B', done: '94A3B8', wknd: 'EEF0F5' };

function tasksSheet(S, st, name, tab) {
  const sh = new Sheet(name, tab); sh.freeze = [2, 1];
  const head = S.get({ b: 1, color: 'FFFFFF', fill: '1E293B', h: 'center', wrap: 1, bb: '0F172A' });
  const heads = ['#', 'Task', 'Type', 'Start', 'End', 'Days', '% done', 'Float (d)', 'Critical', 'Depends on', 'Owner', 'Email'];
  heads.forEach((h, c) => sh.set(0, c, h, head)); sh.heights.set(0, 22);
  sh.widths = [5, 38, 10, 13, 13, 7, 9, 9, 9, 16, 18, 30];
  st.tasks.forEach((t, i) => {
    const f = st.info.get(t.id), r = i + 1, sum = f.summary, ms = t.ms && !sum, crit = f.critical && st.critical;
    const base = { b: sum ? 1 : 0, fill: sum ? 'F1F5F9' : null, bb: 'E2E8F0', color: crit && !sum ? 'BE123C' : '0F172A' };
    const fl = (o) => S.get({ ...base, ...o });
    sh.set(r, 0, i + 2, fl({ h: 'center', color: '94A3B8' }));
    sh.set(r, 1, t.name, fl({ indent: t.level, h: 'left' }));
    sh.set(r, 2, sum ? 'Summary' : ms ? 'Milestone' : 'Task', fl({ color: '64748B' }));
    sh.set(r, 3, serial(f.start), fl({ fmt: 'mmm d, yyyy', h: 'center' }));
    sh.set(r, 4, serial(ms ? t.start : f.end - 1), fl({ fmt: 'mmm d, yyyy', h: 'center' }));
    sh.set(r, 5, ms ? 0 : f.end - f.start, fl({ fmt: '0', h: 'center' }));
    sh.set(r, 6, Math.round(f.progress) / 100, fl({ fmt: '0%', h: 'center' }));
    sh.set(r, 7, f.float == null ? '' : f.float, fl({ fmt: '0', h: 'center', color: f.float === 0 ? 'BE123C' : f.float > 0 ? '15803D' : base.color, b: f.float === 0 ? 1 : base.b }));
    sh.set(r, 8, f.critical && !sum ? 'Yes' : '', fl({ h: 'center', color: 'BE123C', b: 1 }));
    sh.set(r, 9, st.predText(t.id), fl({ color: '475569' }));
    sh.set(r, 10, t.owner, fl({}));
    sh.set(r, 11, t.email || '', fl({ color: '475569' }));
    if (t.level > 0) sh.outline.set(r, Math.min(7, t.level));
  });
  sh.filter = `A1:${colL(heads.length - 1)}${st.tasks.length + 1}`;
  return sh;
}

function ganttSheet(S, st, name, tab) {
  const sh = new Sheet(name, tab), P = st.project, span = P.end - P.start, day = span <= 140, step = day ? 1 : 7;
  const s0 = day ? P.start - 1 : monday(P.start), e0 = P.end + (day ? 1 : 7), cols = [];
  for (let d = s0; d < e0; d += step) cols.push({ a: d, b: d + step });
  const C0 = 4; sh.freeze = [C0, 2]; sh.grid = false;
  const hd = S.get({ b: 1, color: 'FFFFFF', fill: '1E293B', h: 'center', bb: '0F172A' });
  ['#', 'Task', 'Start', 'End'].forEach((h, c) => { sh.set(0, c, h, hd); sh.set(1, c, '', hd); sh.merges.push(`${colL(c)}1:${colL(c)}2`); });
  sh.widths = [4, 32, 9.5, 9.5, ...cols.map(() => (day ? 2.6 : 4.4))]; sh.heights.set(0, 18); sh.heights.set(1, 16);
  // month band (merged) + day / week numbers
  const mStyle = S.get({ b: 1, sz: 9, color: '2B59E6', fill: 'E8EEFF', h: 'left', bb: 'C7D2FE' });
  for (let i = 0; i < cols.length;) {
    const [y, m] = ymd(cols[i].a); let j = i; while (j + 1 < cols.length && ymd(cols[j + 1].a)[1] === m) j++;
    const n = j - i + 1, label = n >= (day ? 6 : 2) ? `${MONTHS[m]} ${y}` : n >= (day ? 3 : 1) ? MONTHS[m] : '';
    for (let c = i; c <= j; c++) sh.set(0, C0 + c, c === i ? label : '', mStyle);
    if (n > 1) sh.merges.push(`${colL(C0 + i)}1:${colL(C0 + j)}1`);
    i = j + 1;
  }
  cols.forEach((c, i) => {
    const we = day && (dow(c.a) === 0 || dow(c.a) === 6), td = today >= c.a && today < c.b;
    sh.set(1, C0 + i, ymd(c.a)[2], S.get({ sz: 8, h: 'center', color: td ? 'FFFFFF' : we ? '94A3B8' : '475569', fill: td ? '2B59E6' : we ? WK.wknd : 'F6F7FA', bb: 'CBD5E1', b: td ? 1 : 0 }));
  });
  st.tasks.forEach((t, i) => {
    const f = st.info.get(t.id), r = i + 2, sum = f.summary, ms = t.ms && !sum, crit = f.critical && st.critical, p = f.progress / 100;
    const base = { bb: 'EEF1F6', b: sum ? 1 : 0 };
    sh.set(r, 0, i + 2, S.get({ ...base, h: 'center', color: '94A3B8', sz: 9 }));
    sh.set(r, 1, t.name, S.get({ ...base, indent: t.level, color: crit && !sum ? 'BE123C' : '0F172A' }));
    sh.set(r, 2, serial(f.start), S.get({ ...base, fmt: 'mmm d', h: 'center', sz: 9, color: '475569' }));
    sh.set(r, 3, serial(ms ? t.start : f.end - 1), S.get({ ...base, fmt: 'mmm d', h: 'center', sz: 9, color: '475569' }));
    if (t.level > 0) sh.outline.set(r, Math.min(7, t.level));
    const doneEnd = f.start + (f.end - f.start) * p;
    cols.forEach((c, k) => {
      const we = day && (dow(c.a) === 0 || dow(c.a) === 6), mid = (c.a + c.b) / 2;
      let s = null, v = '';
      if (sum) { if (c.a < f.end && c.b > f.start) s = S.get({ fill: WK.sum }); }
      else if (ms) { if (f.start >= c.a && f.start < c.b) { s = S.get({ b: 1, sz: 11, h: 'center', color: crit ? WK.cn : p >= 1 ? WK.done : WK.ms, fill: we ? WK.wknd : null }); v = '◆'; } }
      else if (c.a < f.end && c.b > f.start) s = S.get({ fill: mid <= doneEnd ? (crit ? WK.cd : WK.d) : (crit ? WK.cn : WK.n) });
      if (!s && we) s = S.get({ fill: WK.wknd });
      if (s != null) sh.set(r, C0 + k, v, s);
    });
  });
  return sh;
}

// ---------- zip ----------
let CRC = null;
function crc32(u8) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function deflateRaw(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  try { const cs = new CompressionStream('deflate-raw'), w = cs.writable.getWriter(); w.write(u8); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); } catch { return null; }
}
async function zip(files) {
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = []; let off = 0;
  const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name), raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(raw);
    const z = await deflateRaw(raw), useZ = z && z.length < raw.length, body = useZ ? z : raw, method = useZ ? 8 : 0;
    const head = Uint8Array.from([0x50, 0x4B, 3, 4, ...u16(20), ...u16(0x0800), ...u16(method), ...u16(time), ...u16(date), ...u32(crc), ...u32(body.length), ...u32(raw.length), ...u16(name.length), ...u16(0)]);
    parts.push(head, name, body);
    central.push(Uint8Array.from([0x50, 0x4B, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(time), ...u16(date), ...u32(crc), ...u32(body.length), ...u32(raw.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
    off += head.length + name.length + body.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = Uint8Array.from([0x50, 0x4B, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), 0, 0]);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- workbook ----------
const safeName = (n, used) => {
  let b = String(n).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let out = b, k = 2;
  while (used.has(out.toLowerCase())) { const suf = ` (${k++})`; out = b.slice(0, 31 - suf.length) + suf; }
  used.add(out.toLowerCase()); return out;
};
const PAL = ['5B7CFA', '10B981', 'F59E0B', 'EC4899', '8B5CF6', '06B6D4', 'EF4444', '84CC16'];

/** projects: [{ name, store }] where store is a computed Store view. */
export async function buildXlsx(projects) {
  const S = new Styles(), sheets = [], used = new Set();
  projects.forEach((p, i) => {
    const tab = PAL[i % PAL.length];
    sheets.push(tasksSheet(S, p.store, safeName(p.name, used), tab));
    sheets.push(ganttSheet(S, p.store, safeName(`${p.name.slice(0, 24)} Gantt`, used), tab));
  });
  return pack(S, sheets);
}

async function pack(S, sheets) {
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((s, i) => (s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name.replace(/'/g, "''"))}'!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '')).join('')}</definedNames></workbook>` },
    { name: 'xl/styles.xml', data: S.xml() },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml() })),
  ];
  return zip(files);
}

// ---------- import template ----------
export const TEMPLATE_COLS = ['#', 'Task', 'Type', 'Level', 'Start', 'Days', '% done', 'Depends on', 'Owner', 'Email'];

/** Blank, documented import template: a Tasks sheet with a worked example and an Instructions sheet. */
export async function buildTemplate() {
  const S = new Styles(), used = new Set();
  const sh = new Sheet('Tasks', '2B59E6'); sh.freeze = [2, 1]; sh.widths = [6, 38, 12, 8, 13, 8, 9, 16, 18, 30];
  const head = S.get({ b: 1, color: 'FFFFFF', fill: '1E293B', h: 'center', wrap: 1, bb: '0F172A' });
  TEMPLATE_COLS.forEach((h, c) => sh.set(0, c, h, head)); sh.heights.set(0, 22);
  const d0 = Math.floor(Date.now() / 86400000), mon = d0 - ((dow(d0) + 6) % 7) + 7; // next Monday
  // [id, task, type, level, startOffsetDays, days, %done, depends, owner, email]
  const ex = [
    [1, 'Website redesign', 'Task', 1, 0, null, null, '', '', ''],
    [2, 'Discovery', 'Task', 2, 0, null, null, '', '', ''],
    [3, 'Stakeholder interviews', 'Task', 3, 0, 5, 1, '', 'Alex Morgan', 'alex.morgan@example.com'],
    [4, 'Requirements sign-off', 'Milestone', 3, 5, 0, 0, '3', 'Alex Morgan', 'alex.morgan@example.com'],
    [5, 'Design', 'Task', 2, 0, null, null, '', '', ''],
    [6, 'Wireframes', 'Task', 3, 5, 7, 0.4, '4', 'Sam Lee', 'sam.lee@example.com'],
    [7, 'Visual design', 'Task', 3, 12, 9, 0, '6', 'Sam Lee', 'sam.lee@example.com'],
    [8, 'Build', 'Task', 2, 0, null, null, '', '', ''],
    [9, 'Frontend', 'Task', 3, 12, 14, 0, '6SS+5, 7FF', 'Jo Park', 'jo.park@example.com'],
    [10, 'Launch', 'Milestone', 2, 26, 0, 0, '9, 7', '', ''],
  ];
  const g = (o) => S.get({ bb: 'E2E8F0', ...o });
  ex.forEach((r, i) => {
    const sum = r[5] == null, row = i + 1, b = sum ? 1 : 0, fill = sum ? 'F1F5F9' : null;
    sh.set(row, 0, r[0], g({ h: 'center', color: '94A3B8', b, fill }));
    sh.set(row, 1, r[1], g({ indent: r[3] - 1, h: 'left', b, fill }));
    sh.set(row, 2, r[2], g({ color: '64748B', fill }));
    sh.set(row, 3, r[3], g({ h: 'center', fmt: '0', fill }));
    sh.set(row, 4, sum ? '' : mon + r[4] + 25569, g({ fmt: 'yyyy-mm-dd', h: 'center', fill }));
    sh.set(row, 5, sum ? '' : r[5], g({ h: 'center', fmt: '0', fill }));
    sh.set(row, 6, sum ? '' : r[6], g({ h: 'center', fmt: '0%', fill }));
    sh.set(row, 7, r[7], g({ color: '475569', fill }));
    sh.set(row, 8, r[8], g({ fill }));
    sh.set(row, 9, r[9], g({ color: '475569', fill }));
  });
  // empty, pre-formatted rows to type into
  for (let row = ex.length + 1; row <= 300; row++) {
    sh.set(row, 0, '', g({ h: 'center', color: '94A3B8' })); sh.set(row, 1, '', g({})); sh.set(row, 2, '', g({ color: '64748B' })); sh.set(row, 3, '', g({ h: 'center', fmt: '0' }));
    sh.set(row, 4, '', g({ fmt: 'yyyy-mm-dd', h: 'center' })); sh.set(row, 5, '', g({ h: 'center', fmt: '0' })); sh.set(row, 6, '', g({ h: 'center', fmt: '0%' }));
    sh.set(row, 7, '', g({ color: '475569' })); sh.set(row, 8, '', g({})); sh.set(row, 9, '', g({ color: '475569' }));
  }
  sh.validations.push(
    { type: 'list', ref: 'C2:C300', f1: '"Task,Milestone"', title: 'Type', error: 'Choose Task or Milestone.' },
    { type: 'whole', op: 'between', ref: 'D2:D300', f1: '1', f2: '8', title: 'Level', error: 'Level is a whole number from 1 (top) to 8.' },
    { type: 'whole', op: 'greaterThanOrEqual', ref: 'F2:F300', f1: '0', title: 'Days', error: 'Days is a whole number of calendar days (0 = milestone).' },
    { type: 'decimal', op: 'between', ref: 'G2:G300', f1: '0', f2: '1', title: '% done', error: 'Enter 0%–100%.' },
  );
  sh.filter = `A1:${colL(TEMPLATE_COLS.length - 1)}300`;

  const ins = new Sheet('Instructions', 'F59E0B'); ins.widths = [18, 92]; ins.grid = false; ins.landscape = false;
  const h1 = S.get({ b: 1, sz: 16, color: '0F172A' }), th = S.get({ b: 1, color: 'FFFFFF', fill: '1E293B', bb: '0F172A' }), k = S.get({ b: 1, bb: 'E2E8F0', v: 'top' }), v = S.get({ bb: 'E2E8F0', wrap: 1, v: 'top' }), p = S.get({ color: '475569', wrap: 1, v: 'top' });
  ins.set(0, 0, 'How to fill in the import template', h1); ins.heights.set(0, 28);
  [
    'Fill in the Tasks sheet (one task per row, in the order you want them), save as .xlsx, then use Import in the app.',
    'The example rows show the structure; delete them and type your own. Column headers must stay in row 1 — extra columns are ignored.',
  ].forEach((t, i) => { ins.set(2 + i, 0, t, p); ins.merges.push(`A${3 + i}:B${3 + i}`); ins.heights.set(2 + i, 30); });
  ins.set(5, 0, 'Column', th); ins.set(5, 1, 'What to enter', th);
  [
    ['#', 'A unique ID for the row (numbers or WBS codes such as 1.2). Used by "Depends on". If left empty the Excel row number is used.'],
    ['Task *', 'The task name. Required.'],
    ['Type', '"Task" (default) or "Milestone". A task with Days = 0 is also treated as a milestone. Summary (parent) tasks are created automatically from Level, see below.'],
    ['Level', 'Outline depth: 1 = top level, 2 = child of the nearest row above with Level 1, and so on. A row becomes a summary task when the next row is deeper. Summaries need no dates; they are computed from their children.'],
    ['Start', 'First day of the task, as a real Excel date or text like 2026-11-30, 30 Nov 2026, Nov 30 or 11/30/2026. If empty, the task starts after its predecessors (or on the project start date).'],
    ['Days', 'Duration in calendar days (end date is exclusive of the next day: Start Nov 2 + 5 days finishes Nov 6). 0 makes a milestone. You can supply an End column instead.'],
    ['End (optional)', 'Optional extra column: last day of the task (inclusive). Used when Days is empty.'],
    ['% done', 'Progress, 0%–100% (format the cell as a percentage) or 0–100.'],
    ['Depends on', 'Predecessors, by the # of those rows, separated by commas. Optional link type and lag: 4  ·  6SS+2 (start-to-start, 2 days later)  ·  9FF-1 (finish-to-finish, 1 day earlier). Default type is FS (finish-to-start).'],
    ['Owner / Email', 'Person responsible. Email is optional and is used for deadline reminders; connect Microsoft 365 afterwards to pick people from your directory.'],
  ].forEach((r, i) => { ins.set(6 + i, 0, r[0], k); ins.set(6 + i, 1, r[1], v); ins.heights.set(6 + i, r[1].length > 190 ? 60 : r[1].length > 95 ? 45 : 30); });
  ins.set(17, 0, 'Also works with', S.get({ b: 1, color: '475569' }));
  ins.set(17, 1, 'Excel files exported from this app (Tasks sheet), CSV files with the same headers, and most Microsoft Project / Smartsheet / Excel task lists — common header names such as Name, Finish, Duration, Predecessors, Resource Names and Assigned To are recognised.', p); ins.heights.set(17, 45);
  return pack(S, [sh, ins]);
}
