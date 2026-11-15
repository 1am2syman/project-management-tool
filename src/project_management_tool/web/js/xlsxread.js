// Dependency-free spreadsheet reader: .xlsx (zip + XML) and .csv → [{ name, rows: [[cell…]], outline: [level…] }].
// Cells are numbers, strings or null. Everything is bounded so a hostile file cannot hang the tab.
const MAX_BYTES = 15 * 1024 * 1024, MAX_ENTRY = 60 * 1024 * 1024, MAX_ROWS = 6000, MAX_COLS = 40;
const dec = new TextDecoder('utf-8');

async function inflateRaw(u8, limit) {
  const ds = new DecompressionStream('deflate-raw'), w = ds.writable.getWriter();
  w.write(u8).catch(() => {}); w.close().catch(() => {});
  const rd = ds.readable.getReader(), parts = []; let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > limit) { rd.cancel(); throw new Error('The file expands to an unreasonable size'); } parts.push(value); }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Not a valid .xlsx file (zip directory not found)');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  if (n > 4000) throw new Error('Unexpected number of entries in the file');
  const files = new Map();
  for (let i = 0; i < n; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + el + cl;
    files.set(name, { method, csize, usize, lo });
  }
  return async (name) => {
    const f = files.get(name); if (!f) return null;
    if (f.usize > MAX_ENTRY) throw new Error('The file is too large to import');
    if (f.lo + 30 > u8.length || dv.getUint32(f.lo, true) !== 0x04034b50) throw new Error('Corrupt zip entry');
    const s = f.lo + 30 + dv.getUint16(f.lo + 26, true) + dv.getUint16(f.lo + 28, true), data = u8.subarray(s, s + f.csize);
    if (f.method === 0) return dec.decode(data);
    if (f.method === 8) { if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed .xlsx files'); return dec.decode(await inflateRaw(data, MAX_ENTRY)); }
    throw new Error('Unsupported compression in the file');
  };
}

const xml = (s) => { const d = new DOMParser().parseFromString(s, 'application/xml'); if (d.querySelector('parsererror')) throw new Error('Corrupt XML inside the file'); return d; };
const byTag = (el, name) => [...el.getElementsByTagName(name)];
const kid = (el, name) => [...el.children].find((c) => c.localName === name);
const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

async function readXlsx(buf) {
  const get = await unzip(buf);
  const wbX = await get('xl/workbook.xml'); if (!wbX) throw new Error('Not an Excel workbook (xl/workbook.xml missing)');
  const wb = xml(wbX), relsX = await get('xl/_rels/workbook.xml.rels'), rels = new Map();
  if (relsX) for (const r of byTag(xml(relsX), 'Relationship')) rels.set(r.getAttribute('Id'), r.getAttribute('Target'));
  const d1904 = byTag(wb, 'workbookPr').some((n) => /^(1|true)$/i.test(n.getAttribute('date1904') || ''));
  const ssX = await get('xl/sharedStrings.xml'), shared = [];
  if (ssX) for (const si of byTag(xml(ssX), 'si')) shared.push(byTag(si, 't').filter((t) => !t.parentNode || t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));
  const out = [];
  for (const sh of byTag(wb, 'sheet')) {
    const rid = sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sh.getAttribute('r:id');
    let target = rels.get(rid); if (!target) continue;
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const sx = await get(target); if (!sx) continue;
    const doc = xml(sx), rows = [], outline = [], hidden = (sh.getAttribute('state') || '') !== '';
    let rn = 0;
    for (const r of byTag(doc, 'row')) {
      const ri = (parseInt(r.getAttribute('r'), 10) || rn + 1) - 1; rn = ri + 1;
      if (ri >= MAX_ROWS) break;
      const cells = [];
      for (const c of [...r.children].filter((k) => k.localName === 'c')) {
        const ci = c.getAttribute('r') ? colIdx(c.getAttribute('r')) : cells.length; if (ci >= MAX_COLS) continue;
        const t = c.getAttribute('t') || 'n', v = kid(c, 'v'), vs = v ? v.textContent : '';
        let val = null;
        if (t === 's') val = shared[+vs] ?? null;
        else if (t === 'inlineStr') { const is = kid(c, 'is'); val = is ? byTag(is, 't').map((x) => x.textContent).join('') : null; }
        else if (t === 'str') val = vs;
        else if (t === 'b') val = vs === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'e') val = null;
        else if (vs !== '') { const n = Number(vs); val = Number.isFinite(n) ? n : vs; }
        cells[ci] = val === '' ? null : val;
      }
      rows[ri] = cells; outline[ri] = parseInt(r.getAttribute('outlineLevel'), 10) || 0;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    out.push({ name: sh.getAttribute('name') || `Sheet${out.length + 1}`, rows, outline, d1904, hidden });
  }
  if (!out.length) throw new Error('The workbook has no readable sheets');
  return out;
}

function readCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0], cnt = (ch) => first.split(ch).length;
  const delim = cnt('\t') > cnt(';') && cnt('\t') > cnt(',') ? '\t' : cnt(';') > cnt(',') ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  const endCell = () => { row.push(cur === '' ? null : cur); cur = ''; };
  const endRow = () => { endCell(); if (row.some((c) => c != null)) rows.push(row.slice(0, MAX_COLS)); else rows.push([]); row = []; };
  for (let i = 0; i < text.length && rows.length < MAX_ROWS; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"' && cur === '') q = true;
    else if (ch === delim) endCell();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) endRow();
  return [{ name: 'CSV', rows, outline: rows.map(() => 0), d1904: false }];
}

/** @param {File} file */
export async function readSpreadsheet(file) {
  if (file.size > MAX_BYTES) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${MAX_BYTES / 1048576} MB`);
  const buf = await file.arrayBuffer(), head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (head[0] === 0x50 && head[1] === 0x4B) return readXlsx(buf);
  if (head[0] === 0xD0 && head[1] === 0xCF) throw new Error('This is an old binary .xls file. In Excel choose File › Save As › Excel Workbook (.xlsx) and try again');
  if (/\.(csv|tsv|txt)$/i.test(file.name) || !/[\u0000]/.test(new TextDecoder().decode(buf.slice(0, 512)))) return readCsv(dec.decode(buf));
  throw new Error('Unsupported file type. Use an .xlsx or .csv file');
}
