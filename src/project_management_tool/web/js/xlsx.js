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
  constructor(name, tab) { this.name = name; this.tab = tab; this.rows = new Map(); this.widths = []; this.merges = []; this.freeze = null; this.filter = null; this.heights = new Map(); this.outline = new Map(); this.grid = true; this.maxC = 0; this.landscape = true; }
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
    x += `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="${this.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/></worksheet>`;
    return x;
  }
}

// ---------- sheet builders ----------
const WK = { n: '5B7CFA', d: '3A5BDC', cn: 'F43F5E', cd: 'E11D48', sum: '334155', ms: 'F59E0B', done: '94A3B8', wknd: 'EEF0F5' };

function tasksSheet(S, st, name, tab) {
  const sh = new Sheet(name, tab); sh.freeze = [2, 1];
  const head = S.get({ b: 1, color: 'FFFFFF', fill: '1E293B', h: 'center', wrap: 1, bb: '0F172A' });
  const heads = ['#', 'Task', 'Type', 'Start', 'End', 'Days', '% done', 'Float (d)', 'Critical', 'Depends on', 'Owner'];
  heads.forEach((h, c) => sh.set(0, c, h, head)); sh.heights.set(0, 22);
  sh.widths = [5, 38, 10, 13, 13, 7, 9, 9, 9, 16, 16];
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
