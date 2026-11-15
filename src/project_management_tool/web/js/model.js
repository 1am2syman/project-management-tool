// Data model, scheduling engine (all 4 link types), critical path (CPM), undo/redo.
// Durations are calendar days. A task occupies [start, start+dur) (end is exclusive).
// Milestones have dur 0.

export const DAY = 86400000;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const MONTHS = MON;

export const D = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);
export const today = (() => { const t = new Date(); return Math.floor(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY); })();
export const dow = (d) => (((d + 4) % 7) + 7) % 7; // 0 = Sunday
export const ymd = (d) => { const x = new Date(d * DAY); return [x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()]; };
export const fmtDate = (d) => { const [, m, day] = ymd(d); return `${MON[m]} ${day}`; };
export const fmtISO = (d) => new Date(d * DAY).toISOString().slice(0, 10);

export function parseDate(s, ref) {
  s = String(s).trim(); if (!s) return null;
  const y0 = ymd(ref ?? today)[0];
  const mk = (y, m, d) => { if (m < 0 || m > 11 || d < 1 || d > 31) return null; const v = Date.UTC(y, m, d) / DAY; if (!Number.isFinite(v)) return null; const r = ymd(v); return r[0] === y && r[1] === m && r[2] === d ? v : null; };
  const mi = (n) => MON.findIndex((x) => x.toLowerCase() === n.slice(0, 3).toLowerCase());
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return mk(+m[1], m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/))) return mk(m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : y0, m[1] - 1, +m[2]);
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/)) && mi(m[1]) >= 0) return mk(m[3] ? +m[3] : y0, mi(m[1]), +m[2]);
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?$/)) && mi(m[2]) >= 0) return mk(m[3] ? +m[3] : y0, mi(m[2]), +m[1]);
  return null;
}

export const LINK_TYPES = ['FS', 'SS', 'FF', 'SF'];

function demo() {
  const s = D('2026-11-02');
  const T = (name, level, o = {}) => ({ name, level, start: s, dur: 5, progress: 0, owner: '', ms: false, ...o });
  const tasks = [
    T('Product launch', 0),
    T('Discovery', 1),
    T('Stakeholder interviews', 2, { start: s, dur: 5, progress: 100, owner: 'Ava K' }),
    T('Market analysis', 2, { dur: 6, progress: 100, owner: 'Mo S' }),
    T('Requirements sign-off', 2, { ms: true, dur: 0, progress: 100, owner: 'Ava K' }),
    T('Design', 1),
    T('UX research', 2, { dur: 7, progress: 70, owner: 'Lena P' }),
    T('Wireframes', 2, { dur: 6, progress: 35, owner: 'Lena P' }),
    T('Visual design', 2, { dur: 9, progress: 0, owner: 'Ravi T' }),
    T('Design freeze', 2, { ms: true, dur: 0, owner: 'Lena P' }),
    T('Build', 1),
    T('Backend API', 2, { dur: 14, progress: 25, owner: 'Dan C' }),
    T('Frontend app', 2, { dur: 16, owner: 'Mei W' }),
    T('Integrations', 2, { dur: 8, owner: 'Dan C' }),
    T('Alpha build', 2, { ms: true, dur: 0, owner: 'Dan C' }),
    T('Launch readiness', 1),
    T('QA & bug bash', 2, { dur: 10, owner: 'Zoe H' }),
    T('Security review', 2, { dur: 6, owner: 'Omar F' }),
    T('Docs & training', 2, { dur: 8, owner: 'Mo S' }),
    T('Go / No-go', 2, { ms: true, dur: 0, owner: 'Ava K' }),
    T('Launch', 2, { ms: true, dur: 0, owner: 'Ava K' }),
  ].map((t, i) => ({ id: i + 1, ...t }));
  const L = (from, to, type = 'FS', lag = 0) => ({ from, to, type, lag });
  const links = [
    L(3, 4, 'SS', 2), L(3, 5), L(4, 5), L(5, 7), L(7, 8, 'SS', 3), L(8, 9), L(9, 10),
    L(5, 12, 'FS', 2), L(8, 13), L(12, 14, 'SS', 5), L(12, 14, 'FF', 2),
    L(10, 15), L(13, 15), L(14, 15), L(15, 17), L(15, 18, 'SS', 2), L(13, 19, 'SS', 5),
    L(17, 20), L(18, 20), L(19, 20), L(20, 21, 'FS', 2),
  ].map((l, i) => ({ id: 'l' + (i + 1), ...l }));
  return { tasks, links, collapsed: [], nextId: 22, nextLink: links.length + 1 };
}

const KEY = 'pm-proto-v2';

const WB = 'pm-workbook-v1', TPL = 'pm-templates-v1';
const LINK_SET = new Set(LINK_TYPES);

// Coerce arbitrary (possibly corrupt / hand-edited) saved data into a valid project.
function sanitize(d) {
  const src = Array.isArray(d && d.tasks) ? d.tasks : [];
  const seen = new Set(); const tasks = [];
  for (const r of src) {
    if (!r || typeof r !== 'object') continue;
    let id = Number(r.id); if (!Number.isFinite(id) || seen.has(id)) id = Math.max(0, ...seen) + 1;
    seen.add(id);
    const ms = !!r.ms, prev = tasks[tasks.length - 1];
    const level = Math.max(0, Math.min(prev ? prev.level + 1 : 0, Math.floor(Number(r.level)) || 0));
    const start = Number.isFinite(Number(r.start)) ? Math.round(Number(r.start)) : today;
    const dur = ms ? 0 : Math.max(1, Math.round(Number(r.dur)) || 1);
    const progress = Math.max(0, Math.min(100, Math.round(Number(r.progress)) || 0));
    tasks.push({ id, name: String(r.name ?? '').slice(0, 200) || 'Untitled', level, start, dur, progress, owner: String(r.owner ?? '').slice(0, 80), ms });
  }
  const ids = new Set(tasks.map((t) => t.id)), links = [];
  let ln = 0;
  for (const l of Array.isArray(d && d.links) ? d.links : []) {
    if (!l || !ids.has(l.from) || !ids.has(l.to) || !LINK_SET.has(l.type)) continue;
    const n = parseInt(String(l.id).replace(/\D/g, ''), 10) || 0; ln = Math.max(ln, n);
    links.push({ id: `l${n || ++ln}`, from: l.from, to: l.to, type: l.type, lag: Math.round(Number(l.lag)) || 0 });
  }
  const uniq = new Set(); const clean = links.filter((l) => { if (uniq.has(l.id)) return false; uniq.add(l.id); return true; });
  const collapsed = (Array.isArray(d && d.collapsed) ? d.collapsed : []).filter((x) => ids.has(x));
  return { tasks, links: clean, collapsed, nextId: Math.max(Number(d && d.nextId) || 0, ...ids, 0) + 1, nextLink: Math.max(Number(d && d.nextLink) || 0, ln + 1) };
}

function blank() {
  const t = (id, name, level, dur) => ({ id, name, level, start: today, dur, progress: 0, owner: '', ms: false });
  return { tasks: [t(1, 'Phase 1', 0, 5), t(2, 'First task', 1, 5)], links: [], collapsed: [], nextId: 3, nextLink: 1 };
}

// Built-in templates: rows are [name, level, days, owner, isMilestone]; links are [from, to, type, lag] (1-based rows).
function spec(id, name, desc, rows, links) {
  const tasks = rows.map((r, i) => ({ id: i + 1, name: r[0], level: r[1], start: 0, dur: r[4] ? 0 : r[2] || 5, progress: 0, owner: r[3] || '', ms: !!r[4] }));
  return {
    id, name, desc, builtin: true, tasks,
    links: links.map((l, i) => ({ id: `l${i + 1}`, from: l[0], to: l[1], type: l[2] || 'FS', lag: l[3] || 0 })),
    nextId: rows.length + 1, nextLink: links.length + 1,
  };
}
let builtinCache = null;
function builtins() {
  if (builtinCache) return builtinCache;
  const d = demo(), base = Math.min(...d.tasks.map((t) => t.start));
  builtinCache = [
    { id: 'b-launch', name: 'Product launch', desc: 'Discovery → design → build → launch, with SS/FF links', builtin: true, tasks: d.tasks.map((t) => ({ ...t, start: t.start - base, progress: 0 })), links: d.links, nextId: d.nextId, nextLink: d.nextLink },
    spec('b-marketing', 'Marketing campaign', 'Strategy, creative, channels, go-live and reporting', [
      ['Campaign', 0], ['Strategy', 1], ['Audience research', 2, 6, 'Analyst'], ['Messaging & positioning', 2, 5, 'Lead'], ['Budget approval', 2, 0, 'Lead', 1],
      ['Creative', 1], ['Copywriting', 2, 7, 'Writer'], ['Design assets', 2, 9, 'Designer'], ['Video production', 2, 12, 'Producer'], ['Creative review', 2, 0, 'Lead', 1],
      ['Channels', 1], ['Landing page', 2, 8, 'Web'], ['Email sequences', 2, 6, 'CRM'], ['Paid media setup', 2, 5, 'Media'], ['Social calendar', 2, 4, 'Social'], ['Go live', 2, 0, 'Lead', 1],
      ['Measure', 1], ['Campaign running', 2, 21, 'Media'], ['Performance report', 2, 4, 'Analyst'],
    ], [[3, 4], [4, 5], [5, 7], [5, 8], [8, 9, 'SS', 3], [7, 10], [9, 10], [8, 10], [10, 12], [10, 13], [12, 14, 'SS', 2], [10, 15], [12, 16], [13, 16], [14, 16], [15, 16], [16, 18], [18, 19]]),
    spec('b-web', 'Website redesign', 'IA, design, build in parallel, QA and go-live', [
      ['Website redesign', 0], ['Discovery', 1], ['Stakeholder workshop', 2, 3, 'PM'], ['Content audit', 2, 5, 'Content'], ['Sitemap & IA', 2, 4, 'UX'],
      ['Design', 1], ['Wireframes', 2, 6, 'UX'], ['UI design', 2, 8, 'Designer'], ['Design sign-off', 2, 0, 'PM', 1],
      ['Development', 1], ['Component library', 2, 7, 'Dev'], ['Page templates', 2, 10, 'Dev'], ['CMS integration', 2, 8, 'Dev'], ['Content migration', 2, 6, 'Content'],
      ['Launch', 1], ['QA & accessibility', 2, 5, 'QA'], ['Staging review', 2, 3, 'PM'], ['Go live', 2, 0, 'PM', 1],
    ], [[3, 5], [4, 5], [5, 7], [7, 8], [8, 9], [9, 11], [11, 12], [11, 13, 'SS', 3], [12, 14, 'SS', 4], [12, 16], [13, 16], [14, 16], [16, 17], [17, 18]]),
    spec('b-event', 'Event planning', 'Venue, logistics, promotion and event day', [
      ['Event', 0], ['Plan', 1], ['Define goals & budget', 2, 3, 'Lead'], ['Venue shortlist', 2, 5, 'Ops'], ['Venue booked', 2, 0, 'Ops', 1],
      ['Logistics', 1], ['Speakers & agenda', 2, 10, 'Lead'], ['Catering', 2, 6, 'Ops'], ['Registration site', 2, 7, 'Web'], ['Promotion', 2, 14, 'Marketing'], ['Run of show', 2, 4, 'Lead'],
      ['Event day', 1], ['Setup', 2, 1, 'Ops'], ['Event', 2, 2, 'Lead'], ['Teardown & wrap-up', 2, 2, 'Ops'],
    ], [[3, 4], [4, 5], [5, 7], [5, 8], [5, 9], [9, 10, 'SS', 2], [7, 11], [8, 11], [10, 11], [11, 13], [13, 14], [14, 15]]),
    { id: 'b-blank', name: 'Blank project', desc: 'One phase, one task — start from scratch', builtin: true, ...(() => { const b = blank(); b.tasks.forEach((t) => { t.start = 0; }); return b; })() },
  ];
  return builtinCache;
}

export class Store {
  constructor() {
    this.listeners = []; this.undoStack = []; this.redoStack = []; this.hist = new Map();
    this.auto = true; this.critical = true;
    try { const p = JSON.parse(localStorage.getItem(`${KEY}:prefs`) || '{}'); if ('auto' in p) this.auto = !!p.auto; if ('critical' in p) this.critical = !!p.critical; } catch { /* corrupt prefs */ }
    this.wb = this.readWB();
    this.templates = this.readTpl();
    this.load(this.sheet().data);
  }
  on(fn) { this.listeners.push(fn); }
  emit(kind = 'change') { for (const f of this.listeners) f(kind); }

  // ---- persistence ----
  readWB() {
    try {
      const w = JSON.parse(localStorage.getItem(WB));
      if (w && Array.isArray(w.sheets) && w.sheets.length) {
        const sheets = w.sheets.filter((s) => s && typeof s.id === 'string' && s.data).map((s) => ({ id: s.id, name: String(s.name || 'Sheet').slice(0, 60), data: sanitize(s.data) }));
        if (sheets.length) {
          const nextSheet = Math.max(Number(w.nextSheet) || 0, ...sheets.map((s) => parseInt(s.id.slice(1), 10) || 0)) + 1;
          return { active: sheets.some((s) => s.id === w.active) ? w.active : sheets[0].id, nextSheet, sheets };
        }
      }
    } catch { /* corrupt workbook: fall through */ }
    let data = null;
    try { data = JSON.parse(localStorage.getItem(KEY)); } catch { /* none */ }
    return { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Launch plan', data: sanitize(data && Array.isArray(data.tasks) ? data : demo()) }] };
  }
  readTpl() {
    try { const t = JSON.parse(localStorage.getItem(TPL)); if (Array.isArray(t)) return t.filter((x) => x && typeof x.name === 'string' && Array.isArray(x.tasks)).map((x) => ({ ...x, builtin: false })); } catch { /* corrupt */ }
    return [];
  }
  sheet(id = this.wb.active) { return this.wb.sheets.find((s) => s.id === id); }
  load(d) {
    const c = sanitize(d);
    this.tasks = c.tasks; this.links = c.links; this.collapsed = new Set(c.collapsed); this.nextId = c.nextId; this.nextLink = c.nextLink;
    this.settle();
  }
  serialize() { return JSON.stringify({ tasks: this.tasks, links: this.links, collapsed: [...this.collapsed], nextId: this.nextId, nextLink: this.nextLink }); }
  save() {
    try {
      this.sheet().data = JSON.parse(this.serialize());
      localStorage.setItem(WB, JSON.stringify(this.wb));
      localStorage.setItem(`${KEY}:prefs`, JSON.stringify({ auto: this.auto, critical: this.critical }));
    } catch { /* quota / private mode: keep working in memory */ }
  }
  resetAll() { this.hist.clear(); this.undoStack = []; this.redoStack = []; this.wb = { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Launch plan', data: sanitize(demo()) }] }; this.load(this.wb.sheets[0].data); this.save(); this.emit('sheet'); }
  setPref(k, v) { this[k] = v; if (k === 'auto' && v) this.tx(() => {}); this.save(); this.emit(); }

  // ---- sheets (workbook tabs) ----
  uniqueName(base, ignoreId) {
    const b = String(base).trim().slice(0, 60) || 'Sheet', taken = new Set(this.wb.sheets.filter((s) => s.id !== ignoreId).map((s) => s.name.toLowerCase()));
    if (!taken.has(b.toLowerCase())) return b;
    for (let n = 2; ; n++) { const c = `${b} (${n})`; if (!taken.has(c.toLowerCase())) return c; }
  }
  stash() { this.save(); this.hist.set(this.wb.active, { u: this.undoStack, r: this.redoStack }); }
  enter(id) {
    this.wb.active = id;
    const h = this.hist.get(id); this.undoStack = h ? h.u : []; this.redoStack = h ? h.r : [];
    this.load(this.sheet().data); this.save(); this.emit('sheet');
  }
  switchSheet(id) { if (id === this.wb.active || !this.sheet(id)) return; this.stash(); this.enter(id); }
  addSheet(data, name) {
    this.stash();
    const id = `s${this.wb.nextSheet++}`;
    this.wb.sheets.push({ id, name: this.uniqueName(name), data: sanitize(data) });
    this.enter(id); return id;
  }
  newBlank() { return this.addSheet(blank(), `Project ${this.wb.nextSheet}`); }
  renameSheet(id, name) {
    const s = this.sheet(id), n = String(name).trim(); if (!s || !n || n === s.name) return false;
    s.name = this.uniqueName(n, id); this.save(); this.emit('meta'); return true;
  }
  duplicateSheet(id) {
    if (id === this.wb.active) this.save();
    const s = this.sheet(id); if (!s) return null;
    return this.addSheet(JSON.parse(JSON.stringify(s.data)), `${s.name} copy`);
  }
  deleteSheet(id) {
    const ws = this.wb.sheets, i = ws.findIndex((s) => s.id === id);
    if (i < 0 || ws.length < 2) return false;
    ws.splice(i, 1); this.hist.delete(id);
    if (id === this.wb.active) { this.undoStack = []; this.redoStack = []; this.enter(ws[Math.min(i, ws.length - 1)].id); } else { this.save(); this.emit('meta'); }
    return true;
  }
  moveSheet(id, to) {
    const ws = this.wb.sheets, i = ws.findIndex((s) => s.id === id); if (i < 0) return;
    const [s] = ws.splice(i, 1); ws.splice(Math.max(0, Math.min(ws.length, to)), 0, s); this.save(); this.emit('meta');
  }

  // Computed, read-only copy of any sheet (used by exporters) without touching the active one.
  view(id) {
    const v = Object.create(Store.prototype), c = sanitize(this.sheet(id).data);
    Object.assign(v, { listeners: [], auto: this.auto, critical: this.critical, tasks: c.tasks, links: c.links, collapsed: new Set(c.collapsed), nextId: c.nextId, nextLink: c.nextLink });
    v.settle(); return v;
  }

  // ---- templates ----
  allTemplates() { return [...builtins(), ...this.templates]; }
  saveTpl() { try { localStorage.setItem(TPL, JSON.stringify(this.templates)); } catch { /* storage unavailable */ } }
  saveTemplate(name) {
    const n = String(name).trim().slice(0, 60); if (!n) return null;
    const base = Math.min(...this.tasks.map((t) => t.start));
    const t = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: n, builtin: false, savedAt: Date.now(),
      desc: `Saved from "${this.sheet().name}"`,
      tasks: this.tasks.map((x) => ({ ...x, start: x.start - base, progress: 0 })),
      links: this.links.map(({ id, from, to, type, lag }) => ({ id, from, to, type, lag })), nextId: this.nextId, nextLink: this.nextLink,
    };
    const i = this.templates.findIndex((x) => x.name.toLowerCase() === n.toLowerCase());
    if (i >= 0) { this.templates[i] = t; } else this.templates.push(t);
    this.saveTpl(); this.emit('meta'); return { tpl: t, updated: i >= 0 };
  }
  deleteTemplate(id) { this.templates = this.templates.filter((t) => t.id !== id); this.saveTpl(); this.emit('meta'); }
  instantiate(tpl, startDay, name) {
    const data = { tasks: tpl.tasks.map((t) => ({ ...t, start: t.start + startDay, progress: 0 })), links: tpl.links.map((l) => ({ ...l })), collapsed: [], nextId: tpl.nextId, nextLink: tpl.nextLink };
    const id = this.addSheet(data, name || tpl.name);
    this.recalc(); this.propagate(); this.recalc(); this.save(); this.emit('sheet'); // always resolve links once, even with auto-schedule off
    return id;
  }
  static summaryOf(tpl) {
    const leaves = tpl.tasks.filter((t, i, a) => !(a[i + 1] && a[i + 1].level > t.level));
    const s = Math.min(...tpl.tasks.map((t) => t.start)), e = Math.max(...tpl.tasks.map((t) => t.start + t.dur));
    return { tasks: leaves.filter((t) => !t.ms).length, ms: leaves.filter((t) => t.ms).length, span: Number.isFinite(e - s) ? e - s : 0 };
  }

  // ---- transactions / undo ----
  tx(fn) {
    const before = this.serialize();
    const r = fn();
    this.settle();
    if (this.serialize() !== before) { this.undoStack.push(before); if (this.undoStack.length > 150) this.undoStack.shift(); this.redoStack = []; this.save(); }
    this.emit();
    return r;
  }
  undo() { if (this._orig || !this.undoStack.length) return; this.redoStack.push(this.serialize()); this.load(JSON.parse(this.undoStack.pop())); this.save(); this.emit(); }
  redo() { if (this._orig || !this.redoStack.length) return; this.undoStack.push(this.serialize()); this.load(JSON.parse(this.redoStack.pop())); this.save(); this.emit(); }

  // ---- drag sessions: restore originals each frame so pushed successors snap back ----
  beginDrag() { this._before = this.serialize(); this._orig = this.tasks.map((t) => ({ id: t.id, start: t.start, dur: t.dur, progress: t.progress })); }
  dragApply(fn) {
    for (const o of this._orig) { const t = this.byId.get(o.id); if (!t) continue; t.start = o.start; t.dur = o.dur; t.progress = o.progress; }
    fn(); this.settle(); this.emit('drag');
  }
  endDrag(commit = true) {
    if (!commit) { for (const o of this._orig) { const t = this.byId.get(o.id); if (!t) continue; t.start = o.start; t.dur = o.dur; t.progress = o.progress; } this.settle(); }
    else if (this.serialize() !== this._before) { this.undoStack.push(this._before); this.redoStack = []; this.save(); }
    this._orig = null; this.emit();
  }
  orig(id) { return this._orig.find((o) => o.id === id); }

  // ---- scheduling ----
  incoming(id) { return this._in.get(id) || []; }
  outgoing(id) { return this._out.get(id) || []; }
  index() {
    this._in = new Map(); this._out = new Map();
    for (const l of this.links) { (this._in.get(l.to) || this._in.set(l.to, []).get(l.to)).push(l); (this._out.get(l.from) || this._out.set(l.from, []).get(l.from)).push(l); }
  }
  startLB(id, exclude) {
    let m = -Infinity;
    for (const l of this.incoming(id)) {
      if (exclude && exclude.has(l.from)) continue;
      const p = this.byId.get(l.from);
      if (l.type === 'FS') m = Math.max(m, p.start + p.dur + l.lag);
      else if (l.type === 'SS') m = Math.max(m, p.start + l.lag);
    }
    return m;
  }
  endLB(id, exclude) {
    let m = -Infinity;
    for (const l of this.incoming(id)) {
      if (exclude && exclude.has(l.from)) continue;
      const p = this.byId.get(l.from);
      if (l.type === 'FF') m = Math.max(m, p.start + p.dur + l.lag);
      else if (l.type === 'SF') m = Math.max(m, p.start + l.lag);
    }
    return m;
  }
  lowerBound(id, exclude) { const t = this.byId.get(id); return Math.max(this.startLB(id, exclude), this.endLB(id, exclude) - t.dur); }

  topo() {
    const leaves = this.tasks.filter((t) => !this.info.get(t.id).summary);
    const indeg = new Map(leaves.map((t) => [t.id, 0]));
    for (const l of this.links) if (indeg.has(l.to) && indeg.has(l.from)) indeg.set(l.to, indeg.get(l.to) + 1);
    const q = leaves.filter((t) => indeg.get(t.id) === 0).map((t) => t.id), out = [], seen = new Set();
    for (let h = 0; h < q.length; h++) {
      const id = q[h]; out.push(id); seen.add(id);
      for (const l of this.outgoing(id)) if (indeg.has(l.to)) { indeg.set(l.to, indeg.get(l.to) - 1); if (indeg.get(l.to) === 0) q.push(l.to); }
    }
    for (const t of leaves) if (!seen.has(t.id)) out.push(t.id);
    return out;
  }
  propagate() {
    for (const id of this.topo()) {
      const lb = this.lowerBound(id);
      const t = this.byId.get(id);
      if (lb > t.start) t.start = lb;
    }
  }
  settle() { this.recalc(); if (this.auto) { this.propagate(); this.recalc(); } }

  // ---- derived state ----
  recalc() {
    const T = this.tasks, n = T.length;
    this.byId = new Map(T.map((t) => [t.id, t]));
    const info = new Map();
    for (let i = 0; i < n; i++) { let e = i; while (e + 1 < n && T[e + 1].level > T[i].level) e++; info.set(T[i].id, { i, sub: e, summary: e > i }); }
    this.info = info;
    this.links = this.links.filter((l) => info.has(l.from) && info.has(l.to) && !info.get(l.from).summary && !info.get(l.to).summary);
    this.index();
    // summaries
    for (const t of T) {
      const f = info.get(t.id);
      if (!f.summary) { f.start = t.start; f.end = t.start + t.dur; f.progress = t.progress; continue; }
      let s = Infinity, e = -Infinity, w = 0, pw = 0;
      for (let j = f.i + 1; j <= f.sub; j++) {
        if (info.get(T[j].id).summary) continue;
        s = Math.min(s, T[j].start); e = Math.max(e, T[j].start + T[j].dur);
        const wt = Math.max(T[j].dur, 0.0001); w += wt; pw += wt * T[j].progress;
      }
      f.start = s; f.end = e; f.progress = w ? pw / w : 0;
    }
    // CPM on leaves (zero total float against the current schedule = critical)
    const order = this.topo(), leaves = order.map((id) => this.byId.get(id));
    let pend = -Infinity, pstart = Infinity;
    for (const t of leaves) { pend = Math.max(pend, t.start + t.dur); pstart = Math.min(pstart, t.start); }
    const LF = new Map(leaves.map((t) => [t.id, pend]));
    for (let k = order.length - 1; k >= 0; k--) {
      const t = this.byId.get(order[k]); let lf = pend;
      for (const l of this.outgoing(t.id)) {
        const s = this.byId.get(l.to), lfs = LF.get(l.to), lss = lfs - s.dur;
        if (l.type === 'FS') lf = Math.min(lf, lss - l.lag);
        else if (l.type === 'SS') lf = Math.min(lf, lss - l.lag + t.dur);
        else if (l.type === 'FF') lf = Math.min(lf, lfs - l.lag);
        else lf = Math.min(lf, lfs - l.lag + t.dur);
      }
      LF.set(t.id, lf);
      const f = info.get(t.id); f.float = lf - (t.start + t.dur); f.critical = f.float <= 0 && t.progress < 100;
    }
    for (const t of T) { const f = info.get(t.id); if (f.summary) { f.float = null; f.critical = false; } }
    // a summary is "critical" if any of its children is
    for (const t of T) { const f = info.get(t.id); if (f.summary) for (let j = f.i + 1; j <= f.sub; j++) if (info.get(T[j].id).critical) { f.critical = true; break; } }
    for (const l of this.links) {
      const p = this.byId.get(l.from), s = this.byId.get(l.to), pe = p.start + p.dur, se = s.start + s.dur;
      l.slack = l.type === 'FS' ? s.start - (pe + l.lag) : l.type === 'SS' ? s.start - (p.start + l.lag) : l.type === 'FF' ? se - (pe + l.lag) : se - (p.start + l.lag);
      l.violated = l.slack < 0;
      l.critical = l.slack <= 0 && info.get(l.from).critical && info.get(l.to).critical;
    }
    this.project = { start: isFinite(pstart) ? pstart : today, end: isFinite(pend) ? pend : today + 1 };
    this.critCount = leaves.filter((t) => info.get(t.id).critical).length;
    // visible rows
    this.rows = [];
    for (let i = 0; i < n; i++) {
      this.rows.push(T[i]);
      if (this.collapsed.has(T[i].id) && info.get(T[i].id).summary) i = info.get(T[i].id).sub;
    }
  }
  rowNum(id) { return this.info.get(id).i + 2; }
  taskAtRow(num) { return this.tasks[num - 2]; }
  descLeaves(id) { const f = this.info.get(id); const out = []; for (let j = f.i; j <= f.sub; j++) if (!this.info.get(this.tasks[j].id).summary) out.push(this.tasks[j].id); return out; }

  // ---- drag primitives (call inside dragApply) ----
  dragMove(id, delta) {
    const f = this.info.get(id);
    if (f.summary) {
      const ids = this.descLeaves(id), set = new Set(ids); let d = delta;
      if (this.auto) for (const lid of ids) d = Math.max(d, this.lowerBound(lid, set) - this.byId.get(lid).start);
      for (const lid of ids) this.byId.get(lid).start += d;
    } else {
      const t = this.byId.get(id); let s = t.start + delta;
      if (this.auto) s = Math.max(s, this.lowerBound(id));
      t.start = s;
    }
  }
  dragResize(id, side, delta) {
    const t = this.byId.get(id), end = t.start + t.dur;
    if (side === 'l') {
      let s = t.start + delta; if (this.auto) s = Math.max(s, this.startLB(id));
      s = Math.min(s, end - 1); t.start = s; t.dur = end - s;
    } else {
      let e = end + delta; if (this.auto) e = Math.max(e, this.endLB(id));
      e = Math.max(e, t.start + 1); t.dur = e - t.start;
    }
  }
  dragProgress(id, pct) { this.byId.get(id).progress = Math.max(0, Math.min(100, Math.round(pct))); }

  // ---- structure ----
  addTask(afterId, ms = false) {
    return this.tx(() => {
      const after = afterId != null ? this.byId.get(afterId) : null;
      const f = after ? this.info.get(after.id) : null;
      const idx = f ? f.sub + 1 : this.tasks.length;
      const level = after ? after.level : this.tasks.length ? this.tasks[this.tasks.length - 1].level : 0;
      const start = f ? (f.summary ? f.start : after.start) : today;
      const t = { id: this.nextId++, name: ms ? 'New milestone' : 'New task', level, start, dur: ms ? 0 : 5, progress: 0, owner: '', ms };
      this.tasks.splice(idx, 0, t);
      return t.id;
    });
  }
  deleteTask(id) {
    this.tx(() => { const f = this.info.get(id); const gone = new Set(this.tasks.slice(f.i, f.sub + 1).map((t) => t.id)); this.tasks.splice(f.i, f.sub - f.i + 1, ); this.links = this.links.filter((l) => !gone.has(l.from) && !gone.has(l.to)); });
  }
  indent(id, dir) {
    const f = this.info.get(id), T = this.tasks;
    if (dir > 0 && (f.i === 0 || T[f.i].level > T[f.i - 1].level)) return null;
    if (dir < 0 && T[f.i].level === 0) return null;
    if (dir > 0) { // the previous row becomes a summary; summaries cannot carry links, so refuse rather than delete data silently
      const p = T[f.i - 1];
      if (!this.info.get(p.id).summary && this.links.some((l) => l.from === p.id || l.to === p.id)) return `“${p.name}” has links and would become a summary; remove its links first`;
    }
    this.tx(() => { for (let j = f.i; j <= f.sub; j++) T[j].level += dir; });
    return null;
  }
  toggle(id) { if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id); this.recalc(); this.save(); this.emit(); }
  reaches(a, b, seen = new Set()) { if (a === b) return true; if (seen.has(a)) return false; seen.add(a); return this.outgoing(a).some((l) => this.reaches(l.to, b, seen)); }
  canLink(from, to) {
    if (from === to) return 'A task cannot depend on itself';
    if (this.info.get(from).summary || this.info.get(to).summary) return 'Summary tasks cannot be linked';
    if (this.reaches(to, from)) return 'That link would create a cycle';
    return null;
  }
  addLink(from, fromEnd, to, toEnd) {
    const type = (fromEnd === 'f' ? 'F' : 'S') + (toEnd === 'f' ? 'F' : 'S');
    const err = this.canLink(from, to); if (err) return err;
    if (this.links.some((l) => l.from === from && l.to === to && l.type === type)) return 'Link already exists';
    let id;
    this.tx(() => { id = 'l' + this.nextLink++; this.links.push({ id, from, to, type, lag: 0 }); });
    return null;
  }
  updateLink(id, patch) { this.tx(() => Object.assign(this.links.find((l) => l.id === id), patch)); }
  removeLink(id) { this.tx(() => { this.links = this.links.filter((l) => l.id !== id); }); }

  predText(id) {
    return this.incoming(id).map((l) => `${this.rowNum(l.from)}${l.type === 'FS' ? '' : l.type}${l.lag ? (l.lag > 0 ? '+' : '') + l.lag : ''}`).join(', ');
  }
  setCell(id, col, raw) {
    const t = this.byId.get(id), f = this.info.get(id), v = String(raw).trim();
    if (col === 'name') { if (!v) return 'Name cannot be empty'; this.tx(() => { t.name = v; }); return null; }
    if (col === 'owner') { this.tx(() => { t.owner = v; }); return null; }
    if (col === 'start') {
      const d = parseDate(v, f.start); if (d == null) return 'Unrecognised date (try "Nov 12" or 2026-11-12)';
      this.tx(() => {
        if (f.summary) { const delta = d - f.start; for (const lid of this.descLeaves(id)) this.byId.get(lid).start += delta; }
        else { t.start = this.auto ? Math.max(d, this.lowerBound(id)) : d; }
      });
      return null;
    }
    if (col === 'end') {
      if (f.summary) return 'Summary dates come from their children';
      const d = parseDate(v, f.start); if (d == null) return 'Unrecognised date';
      this.tx(() => { if (t.ms) { t.start = d; } else { t.dur = Math.max(1, d - t.start + 1); if (this.auto) t.dur = Math.max(t.dur, this.endLB(id) - t.start); } });
      return null;
    }
    if (col === 'dur') {
      if (f.summary || t.ms) return 'Duration is fixed for summaries and milestones';
      const n = parseFloat(v); if (!(n >= 1)) return 'Duration must be at least 1 day';
      this.tx(() => { t.dur = Math.round(n); }); return null;
    }
    if (col === 'progress') {
      if (f.summary) return 'Summary progress is computed';
      const n = parseFloat(v.replace('%', '')); if (!(n >= 0 && n <= 100)) return 'Progress must be 0–100';
      this.tx(() => { t.progress = Math.round(n); }); return null;
    }
    if (col === 'pred') {
      if (f.summary) return 'Summary tasks cannot have predecessors';
      const next = [];
      for (const tok of v.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
        const m = tok.match(/^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+)?$/i);
        if (!m) return `Can't parse "${tok}" — use e.g. 4, 6SS+2, 9FF-1`;
        const p = this.taskAtRow(+m[1]); if (!p) return `Row ${m[1]} doesn't exist`;
        const type = (m[2] || 'FS').toUpperCase(), lag = m[3] ? parseInt(m[3].replace(/\s/g, ''), 10) : 0;
        if (p.id === id) return 'A task cannot depend on itself';
        if (this.info.get(p.id).summary) return `Row ${m[1]} is a summary`;
        next.push({ from: p.id, type, lag });
      }
      const keep = this.links.filter((l) => l.to !== id);
      const saved = this.links; this.links = keep;
      for (const n of next) if (this.reaches(id, n.from)) { this.links = saved; return 'That would create a cycle'; }
      this.links = saved;
      this.tx(() => { this.links = keep.concat(next.map((n) => ({ id: 'l' + this.nextLink++, from: n.from, to: id, type: n.type, lag: n.lag }))); });
      return null;
    }
    return null;
  }
}
