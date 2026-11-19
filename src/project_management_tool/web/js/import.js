// Import from Excel / CSV: reads the file, maps columns by header name, builds projects, previews problems, creates sheets.
import { parseDate, today, isEmail, fmtDate } from './model.js';
import { readSpreadsheet } from './xlsxread.js';
import { cleanCalendar, calendarError, WorkingCalendar } from './calendar.js';
import { buildTemplate } from './xlsx.js';
import { esc, setHTML, openModal } from './dom.js';

const MAX_TASKS = 5000;
const ALIASES = {
  id: ['id', 'task id', 'wbs', 'no', 'number', 'row', 'uid', 'ref', 'key', '#'],
  name: ['task', 'task name', 'name', 'activity', 'activity name', 'title', 'item', 'action item', 'action'],
  type: ['type', 'task type'],
  level: ['level', 'outline level', 'indent', 'outline', 'wbs level'],
  start: ['start', 'start date', 'begin', 'planned start', 'start on'],
  end: ['end', 'end date', 'finish', 'finish date', 'due', 'due date', 'deadline', 'planned end', 'end on'],
  dur: ['days', 'duration', 'dur', 'duration days', 'duration in days', 'number of days', 'work days'],
  progress: ['% done', '% complete', 'progress', 'done', 'percent complete', 'complete', 'pct complete', 'completion', '% completed'],
  pred: ['depends on', 'predecessors', 'predecessor', 'dependencies', 'dependency', 'depends', 'preds', 'pred', 'blocked by'],
  owner: ['owner', 'assigned to', 'assignee', 'resource', 'resource names', 'resource name', 'responsible', 'person', 'lead'],
  email: ['email', 'e mail', 'owner email', 'mail', 'email address'],
};
const LABEL = { name: 'Task', id: '#', type: 'Type', level: 'Level', start: 'Start', end: 'End', dur: 'Days', progress: '% done', pred: 'Depends on', owner: 'Owner', email: 'Email' };
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%#]+/g, ' ').trim();
const str = (v) => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1e9) / 1e9) : String(v).trim());
const A = Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [k, new Set(v)]));

function findHeader(rows) {
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const map = {};
    (rows[r] || []).forEach((c, i) => { const h = norm(c); if (!h) return; for (const k of Object.keys(A)) if (map[k] == null && A[k].has(h)) { map[k] = i; break; } });
    const n = Object.keys(map).length;
    if (map.name != null && n >= 2 && (!best || n > best.n)) best = { row: r, map, n };
    if (best && best.n >= 4) break;
  }
  return best;
}

const toDay = (v, d1904) => {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') { const d = Math.floor(v) - 25569 + (d1904 ? 1462 : 0); return v >= 1 && v < 2958466 ? d : null; }
  const s = String(v).trim(); const iso = /^(\d{4}-\d{1,2}-\d{1,2})[T ]/.exec(s);
  const d = parseDate(iso ? iso[1] : s); if (d != null) return d;
  return /^\d{5}(\.\d+)?$/.test(s) ? toDay(Number(s), d1904) : null;
};
const toDur = (v) => {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v >= 0 && v < 100000 ? Math.round(v) : null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(d|day|days|w|wk|wks|week|weeks|h|hr|hrs|hour|hours)?\s*\??$/i.exec(String(v).trim());
  if (!m) return null; const n = parseFloat(m[1].replace(',', '.')), u = (m[2] || 'd').toLowerCase();
  return Math.round(u[0] === 'w' ? n * 7 : u[0] === 'h' ? Math.ceil(n / 8) : n);
};

/** Turn one sheet's cells into a project. Returns { ok, name, data, stats, issues, cols, missing }. */
export function spreadsheetCalendars(sheets) {
  const calendars = new Map(), taskCalendars = new Map();
  for (const sheet of sheets) {
    if (sheet.rows[0]?.[0] !== 'Plan calendars' || ![1, 2].includes(sheet.rows[0]?.[1])) continue;
    for (const row of sheet.rows.slice(2)) {
      if (!row?.[0]) continue;
      const key = String(row[0]), taskKey = sheet.rows[0][1] === 2 && row[4] !== '' && row[4] != null ? String(row[4]) : null;
      if (taskKey != null && !/^[1-9]\d*$/.test(taskKey)) throw new Error(`Invalid task calendar number for ${key}`);
      if (taskKey != null && !taskCalendars.has(key)) taskCalendars.set(key, new Map());
      const target = taskKey == null ? calendars : taskCalendars.get(key), entry = taskKey ?? key;
      const workdays = String(row[1] ?? '').split(',').map((d) => d.trim() === '' ? NaN : Number(d));
      if (!target.has(entry)) target.set(entry, { workdays, holidays: [] });
      const calendar = target.get(entry);
      if (calendar.workdays.join(',') !== workdays.join(',')) throw new Error(`Conflicting calendar workdays for ${key}`);
      if (row[2]) calendar.holidays.push({ date: String(row[2]), name: String(row[3] || '') });
      const error = calendarError(calendar); if (error) throw new Error(`Invalid calendar for ${key}: ${error}`);
    }
  }
  for (const [key, tasks] of taskCalendars) {
    if (!calendars.has(key)) throw new Error(`Task calendars for ${key} require a global calendar`);
    // Metadata is carried alongside the calendar, outside its persisted shape.
    Object.defineProperty(calendars.get(key), 'tasks', { value: tasks });
  }
  return calendars;
}
export function mapSheet(sh, calendar) {
  const work = new WorkingCalendar(calendar);
  const issues = [], warn = (row, msg) => issues.push({ row, msg, lv: 'warn' }), err = (msg) => issues.push({ row: 0, msg, lv: 'error' });
  const H = findHeader(sh.rows);
  if (!H) { err('No header row found. The first rows need column titles such as Task, Start, Days, Depends on.'); return { ok: false, name: sh.name, issues, stats: null, cols: [], missing: [] }; }
  const m = H.map, cols = Object.keys(m).map((k) => ({ key: k, label: LABEL[k], from: str(sh.rows[H.row][m[k]]) }));
  const missing = ['start', 'dur', 'pred', 'owner'].filter((k) => m[k] == null && !(k === 'dur' && m.end != null) && !(k === 'start' && m.end != null && m.dur != null)).map((k) => LABEL[k]);
  const recs = [];
  for (let r = H.row + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r] || [], g = (k) => (m[k] == null ? undefined : row[m[k]]);
    if (!row.some((c) => c != null && str(c) !== '')) continue;
    const name = str(g('name'));
    if (!name) { warn(r + 1, 'Row has data but no task name — skipped'); continue; }
    if (recs.length >= MAX_TASKS) { warn(r + 1, `More than ${MAX_TASKS} tasks — the rest were ignored`); break; }
    recs.push({ r: r + 1, name, raw: row, g, outline: sh.outline[r] || 0 });
  }
  if (!recs.length) { err('No task rows found under the header.'); return { ok: false, name: sh.name, issues, stats: null, cols, missing }; }

  // hierarchy
  const useOutline = m.level == null && recs.some((x) => x.outline > 0); // Excel row grouping, 0 = top
  const lv = recs.map((x) => {
    const L = m.level != null ? Number(str(x.g('level')).replace(',', '.')) : NaN;
    return Number.isFinite(L) ? L : useOutline ? x.outline : null;
  });
  const known = lv.filter((v) => v != null), minL = useOutline ? 0 : known.length ? Math.min(...known) : 0;
  let prev = -1;
  recs.forEach((x, i) => {
    let L = lv[i] == null ? (m.level != null || known.length ? Math.max(0, prev) : 0) : Math.max(0, Math.round(lv[i] - minL));
    if (L > prev + 1) { if (prev >= 0 || L > 0) warn(x.r, `Level jumps from ${prev + 1} to ${L + 1}; placed one level under the row above`); L = prev + 1; }
    x.level = Math.min(L, 7); prev = x.level;
  });
  recs.forEach((x, i) => { x.summary = !!recs[i + 1] && recs[i + 1].level > x.level; });

  // ids
  const idOf = new Map();
  recs.forEach((x) => {
    const own = m.id != null ? str(x.g('id')) : ''; x.key = own || String(x.r);
    const k = x.key.toLowerCase();
    if (idOf.has(k)) { warn(x.r, `Duplicate # “${x.key}” — dependencies will point to the first one`); x.dup = true; }
    else idOf.set(k, x);
    x.byRow = String(x.r);
  });
  const rowIdx = new Map(recs.map((x) => [x.byRow, x]));

  // progress: fractions when the whole column is ≤ 1 (Excel stores 70% as 0.7)
  const pv = m.progress == null ? [] : recs.map((x) => x.g('progress')).filter((v) => typeof v === 'number');
  const frac = pv.length && Math.max(...pv) <= 1 && pv.some((v) => v > 0 && v < 1) || (pv.length && Math.max(...pv) <= 1 && pv.every((v) => v === 0 || v === 1) && recs.some((x) => /%/.test(String(x.raw[m.progress] ?? ''))));

  // dates / durations
  let anchor = null;
  const noStart = [];
  recs.forEach((x) => {
    const t = { id: 0, name: x.name.slice(0, 200), level: x.level, start: today, dur: 1, progress: 0, owner: str(x.g('owner')).slice(0, 80), email: '', ms: false };
    const em = str(x.g('email')); if (em) { if (isEmail(em)) t.email = em; else warn(x.r, `“${em}” is not a valid email address — ignored`); }
    const pr = x.g('progress');
    if (pr != null && str(pr) !== '') {
      const n = typeof pr === 'number' ? (frac ? pr * 100 : pr) : parseFloat(String(pr).replace('%', '').replace(',', '.')) * (String(pr).includes('%') ? 1 : frac ? 100 : 1);
      if (Number.isFinite(n) && n >= 0 && n <= 100.0001) t.progress = Math.round(n); else warn(x.r, `Progress “${str(pr)}” is not 0–100% — set to 0`);
    }
    x.t = t;
    if (x.summary) return;
    const taskCalendar = calendar?.tasks?.get(x.key);
    if (taskCalendar) t.calendar = cleanCalendar(taskCalendar);
    const taskWork = taskCalendar ? new WorkingCalendar(taskCalendar) : work;
    const typ = norm(x.g('type')), s = toDay(x.g('start'), sh.d1904), e = toDay(x.g('end'), sh.d1904), d = toDur(x.g('duration') ?? x.g('dur'));
    if (s === null) warn(x.r, `Start “${str(x.g('start'))}” is not a recognised date — ignored`);
    if (e === null) warn(x.r, `End “${str(x.g('end'))}” is not a recognised date — ignored`);
    if (d === null) warn(x.r, `Days “${str(x.g('dur'))}” is not a number — ignored`);
    const isMs = /^(milestone|ms|mile)/.test(typ) || (d === 0 && !/^task/.test(typ));
    let start = s ?? undefined, dur = d ?? undefined;
    if (isMs) { t.ms = true; t.dur = 0; start = start ?? e ?? undefined; }
    else {
      if (dur === undefined && start != null && e != null) { dur = taskWork.count(start, e + 1); if (dur < 1) { warn(x.r, 'End is before Start — set to 1 day'); dur = 1; } }
      if (start == null && e != null && dur != null) start = taskWork.start(e + 1, Math.max(1, dur));
      if (start == null && e != null && dur == null) { start = e; dur = 1; }
      if (dur === undefined) { dur = 1; if (m.dur != null || m.end != null) warn(x.r, 'No duration — set to 1 day'); }
      t.dur = Math.max(1, dur);
    }
    if (start == null) noStart.push(x); else { t.start = start; anchor = anchor == null ? start : Math.min(anchor, start); }
  });
  for (const x of noStart) x.t.start = anchor ?? today; // unscheduled: starts at the project start, then dependencies push it
  recs.forEach((x, i) => { x.t.id = i + 1; });

  // dependencies
  const links = [], out = new Map(), pairs = new Map(); let nl = 1;
  const reaches = (from, to) => { const st = [from], seen = new Set(); while (st.length) { const c = st.pop(); if (c === to) return true; if (seen.has(c)) continue; seen.add(c); for (const n of out.get(c) || []) st.push(n); } return false; };
  for (const x of recs) {
    const txt = str(x.g('pred')); if (!txt) continue;
    if (x.summary) { warn(x.r, 'Summary rows cannot have dependencies — ignored'); continue; }
    for (const tok of txt.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
      let p = idOf.get(tok.toLowerCase()), type = 'FS', lag = 0;
      if (!p) {
        const mm = /^(.+?)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+)?\s*(?:d|days?)?$/i.exec(tok);
        if (mm) { p = idOf.get(mm[1].trim().toLowerCase()) || (m.id == null ? rowIdx.get(mm[1].trim()) : undefined); type = (mm[2] || 'FS').toUpperCase(); lag = mm[3] ? parseInt(mm[3].replace(/\s/g, ''), 10) : 0; }
      }
      if (!p) { warn(x.r, `Dependency “${tok}” does not match any # — ignored`); continue; }
      if (p === x) { warn(x.r, 'Task depends on itself — ignored'); continue; }
      if (p.summary) { warn(x.r, `Dependency on “${p.name}” ignored — it is a summary row; depend on one of its children`); continue; }
      const key = `${p.t.id}:${x.t.id}`, existing = pairs.get(key);
      if (existing) {
        if (existing.type === type && existing.lag === lag) warn(x.r, `Repeated dependency on “${p.name}” was included once`);
        else issues.push({ row: x.r, lv: 'error', msg: `Row ${x.r}: multiple relationships from “${p.name}” to “${x.name}”. Keep one type and lag in Depends on, then import again.` });
        continue;
      }
      if (reaches(x.t.id, p.t.id)) { warn(x.r, `Dependency on “${p.name}” would create a cycle — ignored`); continue; }
      const link = { id: `l${nl++}`, from: p.t.id, to: x.t.id, type, lag };
      links.push(link); pairs.set(key, link); (out.get(p.t.id) || out.set(p.t.id, []).get(p.t.id)).push(x.t.id);
    }
  }
  for (const key of calendar?.tasks?.keys() || []) {
    const matches = recs.filter((x) => x.key.toLowerCase() === key.toLowerCase());
    if (matches.length !== 1 || matches[0].summary) err(`Task calendar #${key} does not identify a unique task or milestone`);
  }
  const tasks = recs.map((x) => x.t);
  const stats = { tasks: tasks.filter((t, i) => !t.ms && !recs[i].summary).length, ms: tasks.filter((t, i) => t.ms && !recs[i].summary).length, summaries: recs.filter((x) => x.summary).length, links: links.length, unscheduled: noStart.length, first: anchor };
  return { ok: !issues.some((x) => x.lv === 'error'), name: sh.name, data: { calendar: cleanCalendar(calendar), tasks, links, collapsed: [], nextId: tasks.length + 1, nextLink: nl }, stats, issues, cols, missing };
}

export function createImport(ctx) {
  const { store } = ctx;
  const btn = document.querySelector('#impbtn');
  const download = (blob, name) => { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); };
  const getTemplate = async () => { try { download(await buildTemplate(), 'project-import-template.xlsx'); ctx.toast('Template downloaded — fill in the Tasks sheet, then import it'); } catch (e) { console.error(e); ctx.toast(`Could not build the template: ${e.message}`); } };

  let dlg = null;
  const baseName = (f) => f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported project';

  function chooseFile() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.xlsm,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
    inp.addEventListener('change', () => { if (inp.files[0]) load(inp.files[0]); });
    inp.click();
  }

  function open(file) {
    if (dlg) { dlg.close(); }
    dlg = openModal('Import from Excel', '<div id="imBody"></div>', { wide: true, onClose: () => { dlg = null; } });
    const root = dlg.body.querySelector('#imBody');
    dlg.el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-im]'); if (!a) return;
      if (a.dataset.im === 'pick') chooseFile();
      else if (a.dataset.im === 'tpl') getTemplate();
      else if (a.dataset.im === 'go') commit();
    });
    dlg.el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dlg.el.classList.add('drop'); } });
    dlg.el.addEventListener('dragleave', (e) => { if (e.target === dlg.el) dlg.el.classList.remove('drop'); });
    dlg.el.addEventListener('drop', (e) => { dlg.el.classList.remove('drop'); const f = e.dataTransfer?.files?.[0]; if (f) { e.preventDefault(); load(f); } });
    dlg.el.addEventListener('change', (e) => { if (e.target.matches('[data-pick]')) paint(); });
    dlg.el.addEventListener('input', (e) => { if (e.target.matches('[data-name]')) { const s = state.sheets[+e.target.dataset.name]; if (s) s.title = e.target.value; } });
    state = { file: null, sheets: [], busy: false, error: '' };
    if (file) load(file); else paint();
    return root;
  }
  let state = { file: null, sheets: [], busy: false, error: '' };

  async function load(file) {
    if (!dlg) open();
    state = { file, sheets: [], busy: true, error: '' }; paint();
    try {
      const raw = await readSpreadsheet(file);
      const calendars = spreadsheetCalendars(raw);
      state.sheets = raw.filter((s) => s.rows.some((r) => r && r.length) && s.rows[0]?.[0] !== 'Plan calendars').map((s, i) => {
        const res = mapSheet(s, calendars.get(s.name)), skip = /\b(gantt|delay log)$/i.test(s.name) || /^instructions?$/i.test(s.name) || s.hidden;
        return { ...res, src: s.name, title: raw.length === 1 || /^(csv|tasks?|sheet\d*|import|plan)$/i.test(s.name) ? baseName(file) : s.name, on: res.ok && !skip, i };
      });
      if (!state.sheets.length) state.error = 'The file is empty.';
    } catch (e) { console.error(e); state.error = e.message || String(e); }
    state.busy = false; paint();
  }

  function paint() {
    if (!dlg) return;
    const root = dlg.body.querySelector('#imBody'), S = state;
    for (const el of root.querySelectorAll('[data-pick]')) { const s = S.sheets[+el.dataset.pick]; if (s) s.on = el.checked; }
    const pick = S.sheets.filter((s) => s.ok && s.on), nT = pick.reduce((a, s) => a + s.data.tasks.length, 0);
    let h = `<p class="help">Bring an existing plan in from Excel or CSV. Column titles are matched automatically (Task, Start, End, Days, Depends on, Owner …).</p>
      <div class="im-top"><button class="primary" data-im="pick">${S.file ? 'Choose a different file…' : 'Choose a file…'}</button><button data-im="tpl">Download template</button><span class="mut">.xlsx or .csv · or drop a file here</span></div>`;
    if (S.busy) h += '<div class="rem-empty">Reading file…</div>';
    else if (S.error) h += `<div class="rem-warn"><p><b>Couldn’t read ${esc(S.file ? S.file.name : 'the file')}.</b></p><p>${esc(S.error)}</p></div>`;
    else if (!S.file) h += `<div class="im-drop"><b>Drop an Excel file here</b><span>or download the template, fill it in and import it. Hierarchy, milestones, dependencies (4, 6SS+2, 9FF-1), owners and progress are all supported.</span></div>`;
    else {
      h += `<div class="im-file"><b>${esc(S.file.name)}</b><span class="mut">${(S.file.size / 1024).toFixed(0)} KB · ${S.sheets.length} sheet${S.sheets.length === 1 ? '' : 's'}</span></div>`;
      h += S.sheets.filter((s) => s.ok || !/^instructions?$/i.test(s.src)).map((s) => {
        const sub = s.ok ? `${s.stats.tasks} tasks · ${s.stats.ms} milestones · ${s.stats.summaries} groups · ${s.stats.links} links${s.stats.first != null ? ` · starts ${esc(fmtDate(s.stats.first))}` : ''}` : '';
        const errs = s.issues.filter((x) => x.lv === 'error'), ws = s.issues.filter((x) => x.lv === 'warn');
        return `<div class="im-sheet${s.on ? ' on' : ''}${s.ok ? '' : ' bad'}">
          <div class="im-h"><label class="chk"><input type="checkbox" data-pick="${s.i}"${s.on ? ' checked' : ''}${s.ok ? '' : ' disabled'}><b>${esc(s.src)}</b></label><span class="mut">${s.ok ? sub : 'Not importable'}</span></div>
          ${s.ok ? `<div class="im-name"><span>Project name</span><input data-name="${s.i}" maxlength="60" value="${esc(s.title)}"></div>
            <div class="chips">${s.cols.map((c) => `<span class="chip2 on" title="Column “${esc(c.from)}”">${esc(c.label)} <em>← ${esc(c.from)}</em></span>`).join('')}${s.missing.map((c) => `<span class="chip2 off" title="No matching column found">${esc(c)} <em>not found</em></span>`).join('')}</div>
            ${s.stats.unscheduled ? `<p class="mut">${s.stats.unscheduled} task${s.stats.unscheduled === 1 ? ' has' : 's have'} no start date; they start with the project and move after their predecessors.</p>` : ''}` : ''}
          ${errs.map((x) => `<div class="rem-warn"><p>${esc(x.msg)}</p></div>`).join('')}
          ${ws.length ? `<details class="im-warns"><summary>${ws.length} thing${ws.length === 1 ? '' : 's'} to check</summary><ul>${ws.slice(0, 60).map((x) => `<li><i>row ${x.row}</i> ${esc(x.msg)}</li>`).join('')}${ws.length > 60 ? `<li class="mut">…and ${ws.length - 60} more</li>` : ''}</ul></details>` : ''}
        </div>`;
      }).join('');
      h += `<div class="im-foot"><span class="mut">Each ticked sheet becomes a new project tab; nothing existing is changed. Durations use task calendars when included, otherwise the project calendar or every day. Configure workdays and holidays with Calendar after import.</span><button class="primary" data-im="go"${pick.length ? '' : ' disabled'}>Import ${pick.length > 1 ? `${pick.length} projects` : 'project'}${nT ? ` · ${nT} rows` : ''}</button></div>`;
    }
    const keep = root.querySelector('details')?.open, scroll = dlg.body.scrollTop;
    setHTML(root, h);
    if (keep) root.querySelector('details')?.setAttribute('open', '');
    dlg.body.scrollTop = scroll;
  }

  function commit() {
    const pick = state.sheets.filter((s) => s.ok && s.on); if (!pick.length) return;
    let n = 0, last = '';
    for (const s of pick) {
      const name = (s.title || s.src || 'Imported project').trim().slice(0, 60) || 'Imported project';
      store.addSheet(s.data, name); n += 1; last = name;
    }
    dlg.close(); ctx.requestRender();
    ctx.toast(n === 1 ? `Imported “${last}”` : `Imported ${n} projects`);
    requestAnimationFrame(() => document.querySelector('[data-fit]')?.click());
  }

  btn.addEventListener('click', () => open());
  // drop a spreadsheet anywhere on the page
  let depth = 0;
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (isFiles(e)) depth++; });
  window.addEventListener('dragleave', (e) => { if (isFiles(e)) depth = Math.max(0, depth - 1); });
  window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    depth = 0; if (!isFiles(e) || e.defaultPrevented) return;
    e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { if (dlg) load(f); else open(f); }
  });
  return { open, getTemplate };
}
