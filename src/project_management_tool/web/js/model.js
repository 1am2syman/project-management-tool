// Data model, scheduling engine (all 4 link types), critical path (CPM), undo/redo.
// Durations count each task’s effective working days; computed finish dates are exclusive.
// Milestones have dur 0.
import { appState } from './appstate.js';
import { WorkingCalendar, cleanCalendar, calendarError } from './calendar.js';
import { latestAllowedStart } from './slack.js';

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

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(s);
// Legacy reminder fields are retained for saved-data compatibility only. Nothing schedules or sends mail.
export const REM_TPL = {
  subject: '{{prefix}}: {{task}} · {{when}} · {{project}}',
  body: 'Hi {{person}},\n\nA quick reminder about the following ({{when}}):\n\n{{details}}\n\nThanks,\n{{sender}}',
};
export const REM_DEF = { on: false, auto: false, mode: 'task', offsets: [3, 1, 0], overdue: true, hour: 9, subject: REM_TPL.subject, body: REM_TPL.body, muted: [] };
// Inert legacy sharing metadata. readOnly + source identifies an older snapshot; no cloud operations use these fields.
export function cleanShare(s) {
  if (!s || typeof s !== 'object' || typeof s.driveId !== 'string' || typeof s.itemId !== 'string') return null;
  const people = {};
  if (s.people && typeof s.people === 'object') for (const [k, v] of Object.entries(s.people).slice(0, 500)) if (isEmail(k) && v && typeof v === 'object') people[k.toLowerCase()] = { name: String(v.name || k).slice(0, 80), permId: typeof v.permId === 'string' ? v.permId : '', uid: typeof v.uid === 'string' ? v.uid.slice(0, 100) : '', at: Number(v.at) || 0 };
  return { driveId: s.driveId.slice(0, 300), itemId: s.itemId.slice(0, 300), webUrl: typeof s.webUrl === 'string' && /^https:\/\//.test(s.webUrl) ? s.webUrl.slice(0, 1000) : '', auto: !!s.auto, publishedAt: Number(s.publishedAt) || 0, people };
}
// Explicit, named snapshots of one project. Each keeps its plan as an immutable JSON string
// (like undo snapshots), so a version is never edited in place and costs one stored value.
export const MAX_VERSIONS = 200;
// Version types for delay accounting; versions saved before it have no type and are never treated as agreed.
export const VERSION_TYPE_IDS = ['baseline', 'status', 'draft'];
export const PREVIEW_LOCK = 'You are viewing a saved version. Return to Current to edit.';
export function cleanVersions(list) {
  const out = [], ids = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    if (!v || typeof v !== 'object' || typeof v.data !== 'string' || !Number.isSafeInteger(v.n) || v.n < 1) continue;
    const id = `v${v.n}`; if (ids.has(id)) continue;
    try { const d = JSON.parse(v.data); if (!d || !Array.isArray(d.tasks) || !Array.isArray(d.links)) continue; } catch { continue; }
    const target = Number.isSafeInteger(v.target) && v.target > 0 ? v.target : null, type = VERSION_TYPE_IDS.includes(v.type) ? v.type : null;
    ids.add(id);
    out.push({ id, n: v.n, name: String(v.name ?? '').trim().slice(0, 80) || `Version ${v.n}`, note: String(v.note ?? '').slice(0, 1000), at: Number.isFinite(Number(v.at)) ? Number(v.at) : 0, by: String(v.by ?? '').slice(0, 120), auto: v.auto !== false, target, ...(type ? { type } : {}), data: v.data });
  }
  return out.sort((a, b) => a.n - b.n).slice(-MAX_VERSIONS);
}
// Sheets without versions keep their previous saved shape.
function versionFields(s) {
  const versions = cleanVersions(s.versions);
  if (!versions.length && !(Number.isSafeInteger(s.nextVersion) && s.nextVersion > 1)) return {};
  return { versions, nextVersion: Math.max(Number.isSafeInteger(s.nextVersion) ? s.nextVersion : 1, (versions.at(-1)?.n || 0) + 1) };
}
export function cleanSource(s) {
  if (!s || typeof s !== 'object' || typeof s.driveId !== 'string' || typeof s.itemId !== 'string') return null;
  return { driveId: s.driveId.slice(0, 300), itemId: s.itemId.slice(0, 300), by: String(s.by || '').slice(0, 120), byEmail: isEmail(s.byEmail) ? s.byEmail : '', fetchedAt: Number(s.fetchedAt) || 0 };
}
export function cleanRem(r) {
  const o = r && typeof r === 'object' ? r : {};
  const offs = [...new Set((Array.isArray(o.offsets) ? o.offsets : REM_DEF.offsets).map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n) && n >= 0 && n <= 60))].sort((a, b) => b - a).slice(0, 8);
  const hour = Math.round(Number(o.hour)); 
  const str = (v, d, n) => (typeof v === 'string' && v.trim() ? v.slice(0, n) : d);
  const muted = [...new Set((Array.isArray(o.muted) ? o.muted : []).map((e) => String(e).toLowerCase()).filter(isEmail))].slice(0, 500);
  return { on: !!o.on, auto: !!o.on && !!o.auto, mode: ['task', 'person', 'project'].includes(o.mode) ? o.mode : 'task', offsets: offs, overdue: o.overdue !== false, hour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : REM_DEF.hour, subject: str(o.subject, REM_TPL.subject, 200), body: str(o.body, REM_TPL.body, 4000), muted, ...(typeof o.timezone === 'string' && o.timezone.length <= 100 ? { timezone: o.timezone } : {}) };
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
    L(5, 12, 'FS', 2), L(8, 13), L(12, 14, 'FF', 2),
    L(10, 15), L(13, 15), L(14, 15), L(15, 17), L(15, 18, 'SS', 2), L(13, 19, 'SS', 5),
    L(17, 20), L(18, 20), L(19, 20), L(20, 21, 'FS', 2),
  ].map((l, i) => ({ id: 'l' + (i + 1), ...l }));
  return { tasks, links, collapsed: [], nextId: 22, nextLink: links.length + 1 };
}

const KEY = 'pm-proto-v2';

const WB = 'pm-workbook-v1', TPL = 'pm-templates-v1';
const LINK_SET = new Set(LINK_TYPES);

// Delay accounting data. Agreed dates live on the tasks (agr = agreed start, agreed finish, original agreed finish; inc = an
// inclusion awaiting agreement) and the change log lives beside them, so undo, versions and files carry them unchanged.
export const LOG_TYPES = ['delay', 'revision', 'inclusion', 'omission'];
export const LOG_KINDS = ['Late start', 'Overrun', 'On hold'];
const dayInt = (v) => (Number.isSafeInteger(v) && Math.abs(v) < 1e8 ? v : null);
function cleanAgreed(r, ms) {
  const a = r.agr, out = {};
  if (a && typeof a === 'object') {
    const f = dayInt(a.f), o = dayInt(a.o), st = dayInt(a.s);
    if (f != null) out.agr = { s: ms ? f : st ?? f, f, o: o ?? f };
  }
  if (r.inc === true && !out.agr) out.inc = true;
  return out;
}
// Templates describe a plan's shape only: agreed dates belong to the project they were agreed in.
const withoutAgreed = (t) => { const c = { ...t }; delete c.agr; delete c.inc; return c; };
const text = (v, n) => String(v ?? '').trim().slice(0, n);
export function cleanLog(list) {
  const out = [], ids = new Set();
  for (const e of Array.isArray(list) ? list.slice(0, 20000) : []) {
    if (!e || typeof e !== 'object' || !LOG_TYPES.includes(e.type) || !Number.isSafeInteger(e.id) || e.id < 1 || ids.has(e.id)) continue;
    ids.add(e.id);
    const x = { id: e.id, type: e.type, taskId: Number.isSafeInteger(e.taskId) ? e.taskId : 0, taskName: text(e.taskName, 200), at: Number.isFinite(Number(e.at)) ? Number(e.at) : 0, days: dayInt(e.days) ?? 0 };
    if (e.type === 'delay' || e.type === 'revision') x.op = e.op === 'start' ? 'start' : 'finish';
    if (e.type === 'delay') {
      x.kind = LOG_KINDS.includes(e.kind) ? e.kind : x.op === 'start' ? 'Late start' : 'Overrun';
      x.cause = e.cause ? text(e.cause, 20) || null : null; x.party = text(e.party, 80);
      if (e.via === 'link') x.via = 'link'; // recorded after a connection edit: its effect on the milestones is stored in eff
    }
    if (e.type !== 'delay') { x.reason = text(e.reason, 500); x.approvedBy = text(e.approvedBy, 120); }
    if (e.note) x.note = text(e.note, 500);
    if (e.source) x.source = text(e.source, 20);
    { const slip = e.type === 'revision' ? cleanEff(e.slip) : null; if (slip) x.slip = slip; }
    { const eff = cleanEff(e.eff); if (eff) x.eff = eff; else if (e.type === 'delay' && e.eff && typeof e.eff === 'object') x.eff = {}; } // a delay that moved no milestone still says so
    for (const k of ['from', 'to']) if (dayInt(e[k]) != null) x[k] = e[k];
    out.push(x);
  }
  return out;
}
// The original agreed completion and each summary's original agreed finish, frozen when the first baseline is agreed:
// later agreed changes appear as steps from these, they never rewrite them.
export function cleanOrig(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {}, end = dayInt(o.end);
  if (end != null) out.end = end;
  const sums = {};
  if (o.sums && typeof o.sums === 'object') for (const [k, v] of Object.entries(o.sums).slice(0, 20000)) if (/^[1-9]\d{0,15}$/.test(k) && dayInt(v) != null) sums[k] = v;
  if (Object.keys(sums).length) out.sums = sums;
  return Object.keys(out).length ? out : null;
}
// Per-entry agreed-date effects: days the entry moved the agreed date of a milestone (by task id) or of the project completion ('end').
function cleanEff(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(e).slice(0, 2000)) if ((k === 'end' || /^[1-9]\d{0,15}$/.test(k)) && dayInt(v) && v !== 0) out[k] = v;
  return Object.keys(out).length ? out : null;
}
function cleanLogFields(d) {
  const log = cleanLog(d?.log), baselined = d?.baselined === true, orig = baselined ? cleanOrig(d?.agreedOrig) : null;
  if (!log.length && !baselined) return {};
  return { log, nextLog: Math.max(Number.isSafeInteger(d?.nextLog) ? d.nextLog : 1, Math.max(0, ...log.map((e) => e.id)) + 1), ...(baselined ? { baselined } : {}), ...(orig ? { agreedOrig: orig } : {}) };
}

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
    const rawDuration = Math.round(Number(r.dur));
    const dur = ms ? 0 : Math.max(1, Math.min(99999999, Number.isSafeInteger(rawDuration) ? rawDuration : 1));
    const progress = Math.max(0, Math.min(100, Math.round(Number(r.progress)) || 0));
    tasks.push({ id, name: String(r.name ?? '').slice(0, 200) || 'Untitled', level, start, dur, progress, owner: String(r.owner ?? '').slice(0, 80), email: isEmail(String(r.email ?? '').trim()) ? String(r.email).trim() : '', noRem: !!r.noRem, ms, scheduling: ['auto', 'manual', 'anchor'].includes(r.scheduling) ? r.scheduling : 'auto', ...(r.calendar && !calendarError(r.calendar) ? { calendar: cleanCalendar(r.calendar) } : {}), ...cleanAgreed(r, ms) });
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
  // Key milestones for the delay analysis: a view choice kept with the project, like which groups are collapsed.
  const stars = [...new Set(Array.isArray(d && d.stars) ? d.stars : [])].filter((x) => ids.has(x));
  return { tasks, links: clean, calendar: cleanCalendar(d?.calendar), collapsed, ...(stars.length ? { stars } : {}), ...cleanLogFields(d), nextId: Math.max(Number(d && d.nextId) || 1, Math.max(...ids, 0) + 1), nextLink: Math.max(Number(d && d.nextLink) || 0, ln + 1) };
}

function planText(data) { const plan = sanitize(data); delete plan.collapsed; delete plan.stars; return JSON.stringify(plan); }

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
  constructor(saved) {
    this.listeners = []; this.undoStack = []; this.redoStack = []; this.hist = new Map(); this.preview = null;
    this.auto = true; this.critical = true; this.criticalTargets = Object.create(null); this.criticalTargetId = null;
    try {
      const p = saved ? saved.preferences || {} : JSON.parse(localStorage.getItem(`${KEY}:prefs`) || '{}');
      if ('auto' in p) this.auto = !!p.auto; if ('critical' in p) this.critical = !!p.critical;
      if (p.criticalTargets && typeof p.criticalTargets === 'object' && !Array.isArray(p.criticalTargets)) {
        for (const [sheet, id] of Object.entries(p.criticalTargets)) if (Number.isSafeInteger(id) && id > 0) this.criticalTargets[sheet] = id;
      }
    } catch { /* corrupt prefs */ }
    this.wb = this.readWB(saved?.workbook);
    this.templates = this.readTpl(saved ? saved.templates || [] : undefined);
    const stack = (items) => (Array.isArray(items) ? items : []).filter((item) => {
      try { const data = JSON.parse(item); return typeof item === 'string' && Array.isArray(data.tasks) && Array.isArray(data.links); } catch { return false; }
    });
    for (const [id, history] of Object.entries(saved?.history || {})) {
      if (this.sheet(id) && history) this.hist.set(id, { u: stack(history.u), r: stack(history.r) });
    }
    const activeHistory = this.hist.get(this.wb.active);
    this.undoStack = activeHistory?.u || []; this.redoStack = activeHistory?.r || [];
    this.load(this.sheet().data);
  }
  on(fn) { this.listeners.push(fn); }
  emit(kind = 'change') { for (const f of this.listeners) { try { f(kind); } catch (e) { console.error(e); } } } // one broken listener must not stop the others (e.g. the renderer)

  // ---- persistence ----
  readWB(saved) {
    try {
      const w = saved ?? JSON.parse(localStorage.getItem(WB));
      if (w && Array.isArray(w.sheets) && w.sheets.length) {
        const sheets = w.sheets.filter((s) => s && typeof s.id === 'string' && s.data).map((s) => ({ id: s.id, name: String(s.name || 'Sheet').slice(0, 60), data: sanitize(s.data), ...(typeof s.fileToken === 'string' ? { fileToken: s.fileToken.slice(0, 100) } : {}), rem: cleanRem(s.rem), share: cleanShare(s.share), source: cleanSource(s.source), readOnly: !!s.readOnly && !!cleanSource(s.source), ...versionFields(s) }));
        if (sheets.length) {
          const nextSheet = Math.max(Number(w.nextSheet) || 1, Math.max(0, ...sheets.map((s) => parseInt(s.id.slice(1), 10) || 0)) + 1);
          return { active: sheets.some((s) => s.id === w.active) ? w.active : sheets[0].id, nextSheet, sheets };
        }
      }
    } catch { /* corrupt workbook: fall through */ }
    let data = null;
    try { data = JSON.parse(localStorage.getItem(KEY)); } catch { /* none */ }
    return { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Launch plan', data: sanitize(data && Array.isArray(data.tasks) ? data : demo()), rem: cleanRem() }] };
  }
  readTpl(saved) {
    try { const t = saved ?? JSON.parse(localStorage.getItem(TPL)); if (Array.isArray(t)) return t.filter((x) => x && typeof x.name === 'string' && Array.isArray(x.tasks)).map((x) => ({ ...x, builtin: false })); } catch { /* corrupt */ }
    return [];
  }
  sheet(id = this.wb.active) { return this.wb.sheets.find((s) => s.id === id); }
  load(d) {
    const c = sanitize(d);
    this.calendar = c.calendar; this.work = new WorkingCalendar(this.calendar);
    this.tasks = c.tasks; this.links = c.links; this.collapsed = new Set(c.collapsed); this.stars = new Set(c.stars || []); this.nextId = c.nextId; this.nextLink = c.nextLink;
    this.log = c.log || []; this.nextLog = c.nextLog || 1; this.baselined = !!c.baselined; this.agreedOrig = c.agreedOrig || null;
    this.settle();
  }
  // What is stored: tasks and the user-authored fields of links (slack/violated/critical are recomputed on load).
  // Undo snapshots leave out which groups are collapsed: folding a group is a view choice, not an edit to be undone.
  serialize(withView = true) {
    const o = { calendar: this.calendar, tasks: this.tasks, links: this.links.map((l) => ({ id: l.id, from: l.from, to: l.to, type: l.type, lag: l.lag })), nextId: this.nextId, nextLink: this.nextLink };
    if (this.log?.length || this.baselined) { o.log = this.log; o.nextLog = this.nextLog; if (this.baselined) o.baselined = true; if (this.agreedOrig) o.agreedOrig = this.agreedOrig; }
    if (withView) { o.collapsed = [...this.collapsed]; const live = new Set(this.tasks.map((t) => t.id)), stars = [...(this.stars || [])].filter((id) => live.has(id)); if (stars.length) o.stars = stars; }
    return JSON.stringify(o);
  }
  snap() { return this.serialize(false); }
  savedState() {
    const history = Object.fromEntries([...this.hist].filter(([id]) => this.sheet(id)));
    history[this.wb.active] = { u: this.undoStack, r: this.redoStack };
    return { workbook: this.wb, templates: this.templates, preferences: { auto: this.auto, critical: this.critical, criticalTargets: { ...this.criticalTargets } }, history, browser: appState.snapshot() };
  }
  save() {
    if (this.stale) return; // another tab changed the workbook: writing now would overwrite its work
    // While a saved version is on screen, the loaded tasks are that version: never write them over the live project.
    if (!this.preview) this.sheet().data = JSON.parse(this.serialize());
    try {
      localStorage.setItem(WB, JSON.stringify(this.wb));
      localStorage.setItem(`${KEY}:prefs`, JSON.stringify({ auto: this.auto, critical: this.critical, criticalTargets: this.criticalTargets }));
    } catch { /* disk saving can still work when browser storage is full */ }
    this.persist?.(this.savedState());
  }
  resetAll() { this.preview = null; this.criticalTargets = Object.create(null); this.hist.clear(); this.undoStack = []; this.redoStack = []; this.wb = { active: 's1', nextSheet: 2, sheets: [{ id: 's1', name: 'Launch plan', data: sanitize(demo()), rem: cleanRem() }] }; this.load(this.wb.sheets[0].data); this.save(); this.emit('sheet'); }
  setPref(k, v) { this[k] = v; if (k === 'auto' && v) this.tx(() => {}); this.save(); this.emit(); }

  criticalTarget() {
    const id = this.preview ? this.preview.target : this.wb ? this.criticalTargets?.[this.wb.active] : this.criticalTargetId;
    const task = this.byId?.get(id);
    return task?.ms && !this.info.get(id).summary ? task : null;
  }
  setCriticalTarget(id = null) {
    if (this.stale) return 'This project changed in another tab. Reload before changing the view.';
    if (this.preview) return PREVIEW_LOCK;
    if (id !== null && (!this.byId.get(id)?.ms || this.info.get(id).summary)) return 'Choose an existing milestone as the critical-path target';
    if (id === null) delete this.criticalTargets[this.wb.active];
    else this.criticalTargets[this.wb.active] = id;
    this.critical = true;
    this.recalc(); this.save(); this.emit('critical-target');
    return null;
  }

  // ---- sheets (workbook tabs) ----
  uniqueName(base, ignoreId) {
    const b = String(base).trim().slice(0, 60) || 'Sheet', taken = new Set(this.wb.sheets.filter((s) => s.id !== ignoreId).map((s) => s.name.toLowerCase()));
    if (!taken.has(b.toLowerCase())) return b;
    for (let n = 2; ; n++) { const c = `${b} (${n})`; if (!taken.has(c.toLowerCase())) return c; }
  }
  stash() { this.save(); this.hist.set(this.wb.active, { u: this.undoStack, r: this.redoStack }); }
  enter(id) {
    this.preview = null;
    this.wb.active = id;
    const h = this.hist.get(id); this.undoStack = h ? h.u : []; this.redoStack = h ? h.r : [];
    this.load(this.sheet().data); this.save(); this.emit('sheet');
  }
  switchSheet(id) { if (id === this.wb.active || !this.sheet(id)) return; this.stash(); this.enter(id); }
  addSheet(data, name, extra = {}) {
    this.stash();
    const id = `s${this.wb.nextSheet++}`;
    this.wb.sheets.push({ id, name: this.uniqueName(name), data: sanitize(data), rem: cleanRem(), ...extra });
    this.enter(id); return id;
  }
  // Compatibility helper for older read-only snapshots. This method only updates local data.
  importShared(data, name, source) {
    const ex = this.wb.sheets.find((s) => s.source && s.source.driveId === source.driveId && s.source.itemId === source.itemId);
    if (ex) {
      ex.data = sanitize(data); ex.source = cleanSource(source);
      if (ex.id === this.wb.active) { this.preview = null; this.load(ex.data); this.save(); this.emit('sheet'); } else this.switchSheet(ex.id);
      return ex.id;
    }
    const id = this.addSheet(data, name, { readOnly: true, source: cleanSource(source) }); this.save(); this.emit('sheet'); return id;
  }
  // Legacy snapshot format: tasks, links and name only, without integration metadata.
  snapshot(id = this.wb.active) {
    if (id === this.wb.active) this.save(); const s = this.sheet(id), data = JSON.parse(JSON.stringify(s.data));
    for (const t of data.tasks) delete t.noRem; // omitted by the legacy snapshot format
    return { v: 1, name: s.name, data };
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
    ws.splice(i, 1); this.hist.delete(id); delete this.criticalTargets[id];
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
    Object.assign(v, { criticalTargetId: this.criticalTargets?.[id], listeners: [], frozen: !!this.sheet(id).readOnly, auto: this.auto, critical: this.critical, calendar: c.calendar, work: new WorkingCalendar(c.calendar), tasks: c.tasks, links: c.links, collapsed: new Set(c.collapsed), nextId: c.nextId, nextLink: c.nextLink, log: c.log || [], nextLog: c.nextLog || 1, baselined: !!c.baselined, agreedOrig: c.agreedOrig || null });
    v.settle(); return v;
  }
  // Computed, frozen copy of a saved version: dates exactly as they were when it was taken.
  versionView(vid, sheetId = this.wb.active) {
    const version = this.version(vid, sheetId); if (!version) return null;
    const v = Object.create(Store.prototype), c = sanitize(JSON.parse(version.data));
    Object.assign(v, { criticalTargetId: version.target, listeners: [], frozen: true, auto: version.auto, critical: this.critical, calendar: c.calendar, work: new WorkingCalendar(c.calendar), tasks: c.tasks, links: c.links, collapsed: new Set(), nextId: c.nextId, nextLink: c.nextLink, log: c.log || [], nextLog: c.nextLog || 1, baselined: !!c.baselined, agreedOrig: c.agreedOrig || null });
    v.settle(); return v;
  }

  // ---- versions: explicit snapshots of the active project ----
  versions(sheetId = this.wb.active) { return this.sheet(sheetId)?.versions || []; }
  version(vid, sheetId = this.wb.active) { return this.versions(sheetId).find((v) => v.id === vid) || null; }
  get previewing() { return this.preview ? this.version(this.preview.id) : null; }
  versionError() { return this.stale ? 'This project changed in another tab; reload before managing versions' : null; }
  // Canonical plan text (no view state), so equal plans compare equal regardless of how they were saved.
  livePlan() { if (!this.preview) this.save(); return planText(this.sheet().data); }
  // True when the live plan matches the newest version, so another snapshot would record no change.
  unchangedSinceLatest() { const latest = this.versions().at(-1); return !!latest && planText(JSON.parse(latest.data)) === this.livePlan(); }
  // Why another version cannot be saved right now, or null.
  snapshotError() {
    const error = this.versionError(); if (error) return error;
    return (this.sheet().versions || []).length >= MAX_VERSIONS ? `A project keeps at most ${MAX_VERSIONS} versions; delete an older version first` : null;
  }
  // An Agreed baseline: the agreement and the version are one operation. Nothing is agreed unless the version can be saved,
  // and the agreement cannot be undone on its own (a snapshot taken before it would drop the agreed dates the version holds),
  // so the undo history starts at the baseline.
  snapshotAgreed(agree, opts) {
    const error = this.snapshotError(); if (error) return { error };
    const fail = agree(); if (fail) return { error: fail };
    const r = this.snapshotVersion(opts);
    if (r.error) { this.undo(); this.redoStack.pop(); return r; }
    this.undoStack = []; this.redoStack = []; this.emit();
    return r;
  }
  snapshotVersion({ name = '', note = '', by = '', type = null } = {}) {
    const error = this.versionError(); if (error) return { error };
    const sheet = this.sheet(), list = sheet.versions || [];
    if (list.length >= MAX_VERSIONS) return { error: `A project keeps at most ${MAX_VERSIONS} versions; delete an older version first` };
    const data = this.livePlan(); // always the live plan, also while another version is on screen
    const n = Math.max(sheet.nextVersion || 1, (list.at(-1)?.n || 0) + 1);
    const [version] = cleanVersions([{ n, name: String(name).trim() || `Version ${n}`, note, by, type, at: Date.now(), auto: this.auto, target: this.criticalTargets[sheet.id] ?? null, data }]);
    sheet.versions = [...list, version]; sheet.nextVersion = n + 1;
    this.save(); this.emit('versions');
    return { version };
  }
  updateVersion(vid, { name, note, type } = {}) {
    const error = this.versionError(); if (error) return error;
    const v = this.version(vid); if (!v) return 'That version no longer exists';
    if (name !== undefined) { const n = String(name).trim().slice(0, 80); if (!n) return 'Give the version a name'; v.name = n; }
    if (note !== undefined) v.note = String(note).slice(0, 1000);
    if (type !== undefined) { if (type && !VERSION_TYPE_IDS.includes(type)) return 'Unknown version type'; if (type) v.type = type; else delete v.type; }
    this.save(); this.emit('versions'); return null;
  }
  // Numbers are never reused, so a deleted version cannot be confused with a later one.
  deleteVersion(vid) {
    const error = this.versionError(); if (error) return error;
    const sheet = this.sheet(); if (!this.version(vid)) return 'That version no longer exists';
    if (this.preview?.id === vid) this.exitPreview();
    sheet.versions = sheet.versions.filter((v) => v.id !== vid);
    this.save(); this.emit('versions'); return null;
  }
  previewVersion(vid) {
    if (this._orig) return 'Finish the current drag first';
    const v = this.version(vid); if (!v) return 'That version no longer exists';
    if (!this.preview) this.save();
    this.preview = { id: v.id, target: v.target };
    this.load({ ...JSON.parse(v.data), collapsed: [...this.collapsed], stars: [...(this.stars || [])] });
    this.emit('version'); return null;
  }
  exitPreview() {
    if (!this.preview) return;
    this.preview = null; this.load(this.sheet().data); this.emit('version');
  }
  // Replaces the live plan with a version in one undoable step. Task and relationship
  // counters never move backwards, so new items cannot reuse IDs seen by later versions.
  restoreVersion(vid) {
    const v = this.version(vid); if (!v) return 'That version no longer exists';
    if (this.sheet().readOnly) return 'This project is read-only';
    if (this.stale) return 'This project changed in another tab; reload before restoring a version';
    this.exitPreview();
    const c = sanitize(JSON.parse(v.data)), ids = new Set(c.tasks.map((t) => t.id)), sheetId = this.wb.active;
    this.tx(() => {
      this.calendar = c.calendar; this.work = new WorkingCalendar(c.calendar);
      this.tasks = c.tasks; this.links = c.links; this.log = c.log || []; this.baselined = !!c.baselined; this.agreedOrig = c.agreedOrig || null;
      this.nextLog = Math.max(this.nextLog, c.nextLog || 1);
      this.nextId = Math.max(this.nextId, c.nextId); this.nextLink = Math.max(this.nextLink, c.nextLink);
      this.collapsed = new Set([...this.collapsed].filter((id) => ids.has(id)));
      this.stars = new Set([...(this.stars || [])].filter((id) => ids.has(id)));
    });
    if (v.target && this.byId.get(v.target)?.ms) this.criticalTargets[sheetId] = v.target; else delete this.criticalTargets[sheetId];
    this.recalc(); this.save(); this.emit();
    return null;
  }
  copyVersionAsProject(vid) {
    const v = this.version(vid); if (!v) return { error: 'That version no longer exists' };
    if (this.stale) return { error: 'This project changed in another tab; reload before copying a version' };
    const id = this.addSheet(JSON.parse(v.data), `${this.sheet().name.slice(0, 30)} · ${v.name}`);
    if (v.target && this.byId.get(v.target)?.ms) { this.criticalTargets[id] = v.target; this.recalc(); this.save(); this.emit('critical-target'); }
    return { id };
  }

  // ---- templates ----
  allTemplates() { return [...builtins(), ...this.templates]; }
  saveTpl() {
    if (this.stale) return;
    try { localStorage.setItem(TPL, JSON.stringify(this.templates)); } catch { /* storage unavailable */ }
    this.persist?.(this.savedState());
  }
  saveTemplate(name) {
    const n = String(name).trim().slice(0, 60); if (!n) return null;
    const base = Math.min(...this.tasks.map((t) => t.start));
    const t = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: n, builtin: false, savedAt: Date.now(),
      desc: `Saved from "${this.sheet().name}"`,
      calendar: cleanCalendar(this.calendar),
      tasks: this.tasks.map((x) => ({ ...withoutAgreed(x), start: x.start - base, progress: 0 })),
      links: this.links.map(({ id, from, to, type, lag }) => ({ id, from, to, type, lag })), nextId: this.nextId, nextLink: this.nextLink,
    };
    const i = this.templates.findIndex((x) => x.name.toLowerCase() === n.toLowerCase());
    if (i >= 0) { this.templates[i] = t; } else this.templates.push(t);
    this.saveTpl(); this.emit('meta'); return { tpl: t, updated: i >= 0 };
  }
  deleteTemplate(id) { this.templates = this.templates.filter((t) => t.id !== id); this.saveTpl(); this.emit('meta'); }
  instantiate(tpl, startDay, name) {
    const data = { calendar: cleanCalendar(tpl.calendar), tasks: tpl.tasks.map((t) => ({ ...withoutAgreed(t), start: t.start + startDay, progress: 0 })), links: tpl.links.map((l) => ({ ...l })), collapsed: [], nextId: tpl.nextId, nextLink: tpl.nextLink };
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
  get readOnly() { const s = this.wb && this.sheet(); return !!(s && s.readOnly) || !!this.preview; } // detached views (export) have no workbook
  tx(fn) {
    if (this.readOnly) { this.emit('denied'); return undefined; } // shared read-only copy
    const before = this.snap();
    const r = fn();
    this.settle();
    if (this.snap() !== before) { this.undoStack.push(before); if (this.undoStack.length > 150) this.undoStack.shift(); this.redoStack = []; this.save(); }
    this.emit();
    return r;
  }
  undo() { if (this._orig || this.readOnly || !this.undoStack.length) return; this.redoStack.push(this.snap()); this.load({ ...JSON.parse(this.undoStack.pop()), collapsed: [...this.collapsed], stars: [...(this.stars || [])] }); this.save(); this.emit(); }
  redo() { if (this._orig || this.readOnly || !this.redoStack.length) return; this.undoStack.push(this.snap()); this.load({ ...JSON.parse(this.redoStack.pop()), collapsed: [...this.collapsed], stars: [...(this.stars || [])] }); this.save(); this.emit(); }

  // ---- drag sessions: restore originals each frame so pushed successors snap back ----
  beginDrag() { this._pre = this.hook?.before() ?? null; this._before = this.snap(); this._orig = this.tasks.map((t) => ({ id: t.id, start: t.start, dur: t.dur, progress: t.progress, scheduling: t.scheduling })); }
  dragApply(fn) {
    for (const o of this._orig) { const t = this.byId.get(o.id); if (!t) continue; t.start = o.start; t.dur = o.dur; t.progress = o.progress; if (o.scheduling) t.scheduling = o.scheduling; else delete t.scheduling; }
    fn(); this.settle(); this.emit('drag');
  }
  // `meta` ({ id, kind }) names the dragged task so the delay-accounting hook can offer to record a late finish.
  endDrag(commit = true, meta = null) {
    const changed = commit && this.snap() !== this._before, pre = this._pre; this._pre = null;
    this.endDragNow(commit);
    if (changed && meta && this.hook) this.hook.after({ id: meta.id, kind: meta.kind, pre });
  }
  endDragNow(commit) {
    if (!commit) { for (const o of this._orig) { const t = this.byId.get(o.id); if (!t) continue; t.start = o.start; t.dur = o.dur; t.progress = o.progress; if (o.scheduling) t.scheduling = o.scheduling; else delete t.scheduling; } this.settle(); }
    else if (this.snap() !== this._before) { this.undoStack.push(this._before); if (this.undoStack.length > 150) this.undoStack.shift(); this.redoStack = []; this.save(); }
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
  workFor(task) {
    const t = typeof task === 'object' ? task : this.byId.get(task);
    if (!t?.calendar || this.info?.get(t.id)?.summary) return this.work;
    this._taskCalendars ??= new WeakMap();
    if (!this._taskCalendars.has(t.calendar)) this._taskCalendars.set(t.calendar, new WorkingCalendar(t.calendar));
    return this._taskCalendars.get(t.calendar);
  }
  startLB(id, exclude) {
    const work = this.workFor(id);
    let m = -Infinity;
    for (const l of this.incoming(id)) {
      if (exclude && exclude.has(l.from)) continue;
      const p = this.byId.get(l.from);
      if (l.type === 'FS') m = Math.max(m, work.shift(work.next(this.finish(p)), l.lag));
      else if (l.type === 'SS') m = Math.max(m, work.shift(p.start, l.lag));
    }
    return m;
  }
  endLB(id, exclude) {
    const work = this.workFor(id);
    let m = -Infinity;
    for (const l of this.incoming(id)) {
      if (exclude && exclude.has(l.from)) continue;
      const p = this.byId.get(l.from);
      if (l.type === 'FF') m = Math.max(m, work.shiftEnd(this.finish(p), l.lag));
      else if (l.type === 'SF') m = Math.max(m, work.shiftEnd(p.start, l.lag));
    }
    return m;
  }
  finish(task) { return this.workFor(task).finish(task.start, task.dur); }
  duration(id) { const f = this.info.get(id), t = this.byId.get(id); return f.summary ? this.work.count(f.start, f.end) : t.dur; }
  lowerBound(id, exclude) { const t = this.byId.get(id), work = this.workFor(t); return Math.max(this.startLB(id, exclude), work.start(this.endLB(id, exclude), t.dur)); }
  previewCalendar(value, taskId = null) {
    const task = taskId == null ? null : this.byId.get(taskId);
    const error = this.structureError() || (taskId != null && (!task ? 'Task no longer exists' : this.info.get(taskId).summary ? 'Summary dates come from their children' : null)) || (value == null && taskId != null ? null : calendarError(value)); if (error) return { error };
    const view = Object.create(Store.prototype);
    Object.assign(view, { listeners: [], frozen: false, auto: this.auto, critical: this.critical, calendar: cleanCalendar(taskId == null ? value : this.calendar), work: new WorkingCalendar(taskId == null ? value : this.calendar), tasks: this.tasks.map((t) => ({ ...t })), links: this.links.map((l) => ({ ...l })), collapsed: new Set(this.collapsed), log: this.log, nextLog: this.nextLog, baselined: this.baselined });
    if (taskId != null) {
      const target = view.tasks.find((t) => t.id === taskId);
      if (value == null) delete target.calendar; else target.calendar = cleanCalendar(value);
    }
    view.recalc();
    for (const task of view.tasks) if (!view.info.get(task.id).summary && (taskId == null ? !task.calendar : task.id === taskId)) task.start = view.workFor(task).next(task.start);
    view.settle();
    if ([...view.info.values()].some((f) => !Number.isSafeInteger(f.end) || Math.abs(f.start) > 99999999 || Math.abs(f.end) > 99999999)) return { error: 'This calendar moves task dates outside the supported date range; shorten the affected tasks first' };
    const changes = this.tasks.filter((t) => { const before = this.info.get(t.id), after = view.info.get(t.id); return before.start !== after.start || before.end !== after.end; }).map((t) => ({ id: t.id, name: t.name, before: this.info.get(t.id), after: view.info.get(t.id) }));
    return { view, changes };
  }
  setCalendar(value, taskId = null) {
    const preview = this.previewCalendar(value, taskId); if (preview.error) return preview.error;
    const pre = this.hook?.before() ?? null;
    this.tx(() => { this.calendar = preview.view.calendar; this.work = preview.view.work; this.tasks = preview.view.tasks; });
    this.hook?.after({ id: taskId, kind: 'calendar', pre });
    return null;
  }

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
  scheduling(id) {
    const t = this.byId.get(id);
    if (this.info.get(id)?.summary) return { mode: 'summary', mark: 'Σ', label: 'Summary', detail: 'Dates roll up from child tasks' };
    if (t?.scheduling !== 'manual' && t?.scheduling !== 'anchor') return { mode: 'auto', mark: 'A', label: this.auto ? 'Auto' : 'Auto paused', detail: 'Earliest date from connections and the effective task calendar; without predecessors, keeps its starting date' + (this.auto ? '' : '; enable Auto-schedule for live updates') };
    if (t?.scheduling === 'manual') return { mode: 'manual', mark: 'M', label: 'Manual', detail: 'Dates set by you; connections do not move this task' };
    return { mode: 'anchor', mark: 'D', label: 'Date anchor', detail: 'Keeps its chosen date; Auto-schedule can delay it to satisfy connections. Choose Auto-calculate to remove this date anchor.' };
  }
  setScheduling(id, mode) {
    const error = this.structureError(); if (error) return error;
    const t = this.byId.get(id), f = this.info.get(id);
    if (!t || !f) return 'Task no longer exists';
    if (f.summary) return 'Summary dates come from their children';
    if (!['auto', 'manual', 'anchor'].includes(mode)) return 'Unknown scheduling mode';
    const work = this.workFor(t), lb = this.lowerBound(id), linked = this.incoming(id).length > 0;
    if (mode === 'auto' && linked && (!Number.isSafeInteger(lb) || Math.abs(work.finish(lb, t.dur)) > 99999999)) return 'Calculated dates are outside the supported range';
    const pre = this.hook?.before() ?? null;
    this.tx(() => {
      t.scheduling = mode;
      if (mode === 'auto' && linked) t.start = work.next(lb);
    });
    this.hook?.after({ id, kind: 'mode', pre });
    return null;
  }
  propagate() {
    for (const id of this.topo()) {
      const work = this.workFor(id), lb = this.lowerBound(id);
      const t = this.byId.get(id);
      if (t.scheduling === 'manual') continue;
      t.start = work.next(t.scheduling !== 'anchor' && Number.isFinite(lb) ? lb : Math.max(t.start, lb));
    }
  }
  // Everything connected to a task: WBS ancestors / descendants and the transitive dependency chain in both directions.
  related(id) {
    const f = this.info.get(id); if (!f) return null;
    const T = this.tasks, anc = new Set(), desc = new Set(), up = new Set(), down = new Set(), upL = new Set(), downL = new Set();
    for (let i = f.i - 1, lv = T[f.i].level; i >= 0 && lv > 0; i--) if (T[i].level < lv) { anc.add(T[i].id); lv = T[i].level; }
    for (let j = f.i + 1; j <= f.sub; j++) desc.add(T[j].id);
    const walk = (start, map, key, set, lset) => { const q = [start]; while (q.length) { const x = q.pop(); for (const l of map.get(x) || []) { lset.add(l.id); if (!set.has(l[key]) && l[key] !== id) { set.add(l[key]); q.push(l[key]); } } } };
    const roots = f.summary ? [...desc].filter((d) => !this.info.get(d).summary) : [id]; // a summary stands for its leaves
    for (const r of roots) { walk(r, this._in, 'from', up, upL); walk(r, this._out, 'to', down, downL); }
    for (const d of desc) { up.delete(d); down.delete(d); }
    return { anc, desc, up, down, upL, downL };
  }
  settle() { this.rev = (this.rev || 0) + 1; this.recalc(); if (this.auto && !this.readOnly && !this.frozen) { this.propagate(); this.recalc(); } }

  // ---- derived state ----
  recalc() {
    const T = this.tasks, n = T.length;
    this.byId = new Map(T.map((t) => [t.id, t]));
    const info = new Map();
    for (let i = 0; i < n; i++) { let e = i; while (e + 1 < n && T[e + 1].level > T[i].level) e++; info.set(T[i].id, { i, sub: e, summary: e > i }); }
    this.info = info;
    // A summary has no independent schedule or calendar; undo restores its former leaf state.
    for (const t of T) if (info.get(t.id).summary) delete t.calendar;
    this.links = this.links.filter((l) => info.has(l.from) && info.has(l.to) && !info.get(l.from).summary && !info.get(l.to).summary);
    this.index();
    // summaries
    for (const t of T) {
      const f = info.get(t.id);
      if (!f.summary) { f.start = t.start; f.end = this.finish(t); f.progress = t.progress; continue; }
      let s = Infinity, e = -Infinity, w = 0, pw = 0;
      for (let j = f.i + 1; j <= f.sub; j++) {
        if (info.get(T[j].id).summary) continue;
        s = Math.min(s, T[j].start); e = Math.max(e, this.finish(T[j]));
        const wt = Math.max(T[j].dur, 0.0001); w += wt; pw += wt * T[j].progress;
      }
      f.start = s; f.end = e; f.progress = w ? pw / w : 0;
    }
    // CPM on leaves (zero total float against the current schedule = critical)
    const order = this.topo(), leaves = order.map((id) => this.byId.get(id));
    let pend = -Infinity, pstart = Infinity;
    for (const t of leaves) { pend = Math.max(pend, this.finish(t)); pstart = Math.min(pstart, t.start); }
    const target = this.criticalTarget(), scope = target ? new Set([target.id]) : null;
    if (scope) {
      const queue = [target.id];
      for (let i = 0; i < queue.length; i++) for (const link of this.incoming(queue[i])) {
        if (!scope.has(link.from)) { scope.add(link.from); queue.push(link.from); }
      }
    }
    const latestStarts = new Map();
    for (let k = order.length - 1; k >= 0; k--) {
      const t = this.byId.get(order[k]), f = info.get(t.id);
      if (scope && !scope.has(t.id)) { f.float = null; f.latestStart = f.latestEnd = null; f.totalLimiters = []; f.critical = false; continue; }
      const work = this.workFor(t), boundary = target ? target.start : t.dur ? work.start(pend, t.dur) : work.next(pend, -1);
      const outgoing = this.outgoing(t.id).filter((link) => !scope || scope.has(link.to));
      const latest = latestAllowedStart(work, t, outgoing, this.byId, latestStarts, boundary, !!target && t.id !== target.id, (task) => this.workFor(task));
      latestStarts.set(t.id, latest.start);
      f.latestStart = latest.start; f.latestEnd = latest.end; f.totalLimiters = latest.limiters;
      f.float = work.count(t.start, latest.start); f.critical = f.float <= 0 && t.progress < 100;
    }
    // Free slack holds every immediate successor at its current dates, independently
    // of the chosen total-slack scope. Terminal tasks use the project's finish;
    // the selected target itself stays fixed at its current date.
    for (const t of T) {
      const f = info.get(t.id);
      if (f.summary) { f.float = f.freeFloat = f.latestStart = f.latestEnd = f.freeStart = f.freeEnd = null; f.totalLimiters = f.freeLimiters = []; f.critical = false; continue; }
      const outgoing = this.outgoing(t.id), fixedTarget = target?.id === t.id;
      const work = this.workFor(t), boundary = fixedTarget ? target.start : t.dur ? work.start(pend, t.dur) : work.next(pend, -1);
      const free = latestAllowedStart(work, t, fixedTarget ? [] : outgoing, this.byId, null, boundary, !fixedTarget && outgoing.length > 0, (task) => this.workFor(task));
      f.freeStart = free.start; f.freeEnd = free.end; f.freeLimiters = free.limiters;
      f.freeFloat = work.count(t.start, free.start);
    }
    // a summary is "critical" if any of its children is
    for (const t of T) { const f = info.get(t.id); if (f.summary) for (let j = f.i + 1; j <= f.sub; j++) if (info.get(T[j].id).critical) { f.critical = true; break; } }
    for (const l of this.links) {
      const p = this.byId.get(l.from), s = this.byId.get(l.to), pe = this.finish(p), se = this.finish(s), work = this.workFor(s);
      l.slack = l.type === 'FS' ? s.start - work.shift(work.next(pe), l.lag) : l.type === 'SS' ? s.start - work.shift(p.start, l.lag) : l.type === 'FF' ? se - work.shiftEnd(pe, l.lag) : se - work.shiftEnd(p.start, l.lag);
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
    const f = this.info.get(id), work = this.workFor(id);
    if (f.summary) {
      const ids = this.descLeaves(id), set = new Set(ids); let d = delta;
      if (this.auto) for (const lid of ids) if (this.byId.get(lid).scheduling === 'anchor') d = Math.max(d, this.lowerBound(lid, set) - this.byId.get(lid).start);
      for (const lid of ids) { const t = this.byId.get(lid); if (t.scheduling === 'auto') t.scheduling = 'manual'; t.start = this.workFor(t).next(t.start + d); }
    } else {
      const t = this.byId.get(id); let s = t.start + delta;
      if (t.scheduling === 'auto') t.scheduling = 'manual';
      if (this.auto && t.scheduling === 'anchor') s = Math.max(s, this.lowerBound(id));
      t.start = work.next(s);
    }
  }
  dragResize(id, side, delta) {
    const t = this.byId.get(id), work = this.workFor(t), end = this.finish(t);
    if (t.scheduling === 'auto' && (side === 'l' || !t.agr)) t.scheduling = 'manual'; // a finish edit of an agreed task keeps its mode
    if (side === 'l') {
      let s = t.start + delta; if (this.auto && t.scheduling === 'anchor') s = Math.max(s, this.startLB(id));
      s = Math.min(work.next(s), work.next(end - 1, -1)); t.start = s; t.dur = Math.max(1, work.count(s, end));
    } else {
      let e = end + delta; if (this.auto && t.scheduling === 'anchor') e = Math.max(e, this.endLB(id));
      t.dur = Math.max(1, work.count(t.start, e));
    }
  }
  dragProgress(id, pct) { this.byId.get(id).progress = Math.max(0, Math.min(100, Math.round(pct))); }

  // ---- structure ----
  structureError() {
    if (this.preview) return PREVIEW_LOCK;
    if (this.readOnly) return 'This project is read-only';
    if (this.stale) return 'This project changed in another tab; reload before editing';
    return null;
  }
  parentId(id) {
    const f = this.info.get(id), t = this.byId.get(id);
    if (!f || !t || t.level === 0) return null;
    for (let i = f.i - 1; i >= 0; i--) if (this.tasks[i].level < t.level) return this.tasks[i].id;
    return null;
  }
  canAddChild(id) {
    const t = this.byId.get(id), f = this.info.get(id);
    if (!t || !f) return 'Task no longer exists';
    if (t.ms) return 'Milestones cannot contain child tasks';
    if (!f.summary && this.links.some((l) => l.from === id || l.to === id)) return `“${t.name}” has relationships and would become a summary; remove its relationships first`;
    return null;
  }
  insertion(referenceId, position = 'after') {
    const error = this.structureError(); if (error) return { error };
    if (!['before', 'after', 'child'].includes(position)) return { error: 'Unknown insertion position' };
    if (referenceId == null) return position === 'child' ? { error: 'Select a parent task first' } : { index: this.tasks.length, level: 0, start: today };
    const t = this.byId.get(referenceId), f = this.info.get(referenceId);
    if (!t || !f) return { error: 'Task no longer exists' };
    if (position === 'child') { const reason = this.canAddChild(referenceId); if (reason) return { error: reason }; }
    return { index: position === 'before' ? f.i : f.sub + 1, level: t.level + (position === 'child' ? 1 : 0), start: f.start };
  }
  insertTask(referenceId, ms = false, position = 'after') {
    const place = this.insertion(referenceId, position); if (place.error) return { error: place.error };
    const id = this.tx(() => {
      const t = { id: this.nextId++, name: ms ? 'New milestone' : 'New task', level: place.level, start: this.work.next(place.start), dur: ms ? 0 : 5, progress: 0, owner: '', email: '', ms, scheduling: 'auto', ...(this.baselined ? { inc: true } : {}) }; // added after agreement: pending until agreed
      this.tasks.splice(place.index, 0, t);
      if (position === 'child') this.collapsed.delete(referenceId);
      return t.id;
    });
    return { id };
  }
  addTask(afterId, ms = false) { return this.insertTask(afterId, ms).id; }
  movePlan(id, targetId, position = 'after') {
    const place = this.insertion(targetId, position); if (place.error) return place;
    const f = this.info.get(id), t = this.byId.get(id), target = this.info.get(targetId);
    if (!f || !t || !target) return { error: 'Task no longer exists' };
    if (target.i >= f.i && target.i <= f.sub) return { error: 'A cascade cannot be moved into itself or one of its children' };
    return { ...place, from: f.i, count: f.sub - f.i + 1, delta: place.level - t.level };
  }
  moveTask(id, targetId, position = 'after') {
    const place = this.movePlan(id, targetId, position); if (place.error) return place.error;
    this.tx(() => {
      const block = this.tasks.splice(place.from, place.count);
      for (const t of block) t.level += place.delta;
      this.tasks.splice(place.index > place.from ? place.index - place.count : place.index, 0, ...block);
      if (position === 'child') this.collapsed.delete(targetId);
    });
    return null;
  }
  setTaskKind(id, milestone) {
    const error = this.structureError(); if (error) return error;
    const task = this.byId.get(id), info = this.info.get(id);
    if (!task || !info) return 'Task no longer exists';
    if (info.summary) return 'A cascade with child tasks cannot be converted to a milestone';
    if (typeof milestone !== 'boolean') return 'Unknown task type';
    if (task.ms === milestone) return null;
    this.tx(() => { task.ms = milestone; task.dur = milestone ? 0 : 1; });
    return null;
  }
  removeRows(id) { const f = this.info.get(id); const gone = new Set(this.tasks.slice(f.i, f.sub + 1).map((t) => t.id)); this.tasks.splice(f.i, f.sub - f.i + 1); this.links = this.links.filter((l) => !gone.has(l.from) && !gone.has(l.to)); }
  deleteTask(id) { this.tx(() => this.removeRows(id)); }
  // One undo step for an edit plus the record that explains it: the record joins the edit's step instead of adding its own.
  amend(fn) {
    const n = this.undoStack.length, r = this.tx(fn);
    if (n > 0 && this.undoStack.length === n + 1) { this.undoStack.splice(n, 1); this.save(); }
    return r;
  }
  indentPlan(id, dir) {
    const error = this.structureError(); if (error) return { error };
    const f = this.info.get(id), t = this.byId.get(id);
    if (!f || !t) return { error: 'Select a task first' };
    if (dir < 0) {
      const parent = this.parentId(id);
      return parent == null ? { error: 'This task is already at the top level' } : { targetId: parent, position: 'after' };
    }
    for (let i = f.i - 1; i >= 0; i--) {
      const prev = this.tasks[i];
      if (prev.level < t.level) break;
      if (prev.level === t.level) return { targetId: prev.id, position: 'child' };
    }
    return { error: 'There is no previous sibling to indent under' };
  }
  indent(id, dir) {
    const plan = this.indentPlan(id, dir);
    return plan.error || this.moveTask(id, plan.targetId, plan.position);
  }
  // Key milestones the delay analysis shows in its impact grid and trend. Saved with the project; not part of undo.
  keyMilestones() { return this.stars || new Set(); }
  setKeyMilestone(id, on) {
    if (this.sheet().readOnly || this.preview) return false;
    this.stars = new Set(this.stars || []); if (on) this.stars.add(id); else this.stars.delete(id);
    this.save(); this.emit('meta'); return true;
  }
  toggle(id) { if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id); this.recalc(); this.save(); this.emit(); }
  reaches(a, b, seen = new Set()) { if (a === b) return true; if (seen.has(a)) return false; seen.add(a); return this.outgoing(a).some((l) => this.reaches(l.to, b, seen)); }
  linksBetween(from, to) { return this.links.filter((l) => l.from === from && l.to === to); }
  linkConflicts() {
    const pairs = new Map();
    for (const l of this.links) {
      const key = `${l.from}:${l.to}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(l);
    }
    return [...pairs.values()].filter((links) => links.length > 1);
  }
  canLink(from, to) {
    if (!this.byId.has(from) || !this.byId.has(to)) return 'Task no longer exists';
    if (from === to) return 'A task cannot depend on itself';
    if (this.info.get(from).summary || this.info.get(to).summary) return 'Summary tasks cannot be linked';
    if (this.reaches(to, from)) return 'That link would create a cycle';
    return null;
  }
  addLink(from, fromEnd, to, toEnd) {
    if (this.readOnly) return this.preview ? PREVIEW_LOCK : 'This project is read-only';
    if (this.stale) return 'This project changed in another tab; reload before editing relationships';
    const type = (fromEnd === 'f' ? 'F' : 'S') + (toEnd === 'f' ? 'F' : 'S');
    const err = this.canLink(from, to); if (err) return err;
    if (this.linksBetween(from, to).length) return 'A relationship already exists between these tasks';
    const pre = this.hook?.before() ?? null;
    this.tx(() => { this.links.push({ id: 'l' + this.nextLink++, from, to, type, lag: 0 }); });
    this.hook?.after({ id: to, kind: 'link', pre });
    return null;
  }
  updateLink(id, patch, { resolvePair = false } = {}) {
    if (this.readOnly) return this.preview ? PREVIEW_LOCK : 'This project is read-only';
    if (this.stale) return 'This project changed in another tab; reload before editing relationships';
    const link = this.links.find((l) => l.id === id); if (!link) return 'Relationship no longer exists';
    if ('from' in patch || 'to' in patch) return 'Relationship endpoints cannot be changed';
    const type = patch.type ?? link.type, lag = Number(patch.lag ?? link.lag);
    if (!LINK_SET.has(type)) return 'Unknown relationship type';
    if (!Number.isSafeInteger(lag)) return 'Lag must be a whole number of days';
    const err = this.canLink(link.from, link.to); if (err) return err;
    if (!resolvePair && this.linksBetween(link.from, link.to).length > 1) return 'Review the existing relationships and choose one to keep';
    const pre = this.hook?.before() ?? null;
    this.tx(() => {
      Object.assign(link, { type, lag });
      if (resolvePair) this.links = this.links.filter((l) => l.id === id || l.from !== link.from || l.to !== link.to);
    });
    this.hook?.after({ id: link.to, kind: 'link', pre });
    return null;
  }
  removeLink(id) { this.tx(() => { this.links = this.links.filter((l) => l.id !== id); }); }

  predText(id) {
    return this.incoming(id).map((l) => `${this.rowNum(l.from)}${l.type === 'FS' ? '' : l.type}${l.lag ? (l.lag > 0 ? '+' : '') + l.lag : ''}`).join(', ');
  }
  // Always addressed by sheet id: callers finish async work after the user may have switched tabs.
  setShare(id, share) { const s = this.sheet(id); if (!s || s.readOnly) return; s.share = cleanShare(share); this.save(); this.emit('share'); }
  clearNoRem() { this.tx(() => { for (const t of this.tasks) t.noRem = false; }); }
  setNoRem(id, v) { this.tx(() => { const t = this.byId.get(id); if (t) t.noRem = !!v; }); }
  setOwner(id, name, email) { this.tx(() => { const t = this.byId.get(id); if (t) { t.owner = String(name).slice(0, 80); t.email = isEmail(email) ? email : ''; } }); }
  get rem() { return this.sheet().rem || (this.sheet().rem = cleanRem()); }
  setRem(patch) { if (this.readOnly) return; this.sheet().rem = cleanRem({ ...this.rem, ...patch }); this.save(); this.emit('meta'); }
  // Typed start / finish / duration edits tell the delay-accounting hook, which may offer to record a late finish.
  setCell(id, col, raw) {
    const track = this.hook && (col === 'start' || col === 'end' || col === 'dur'), pre = track ? this.hook.before() : null;
    const error = this.applyCell(id, col, raw);
    if (track && !error) this.hook.after({ id, kind: col, pre });
    return error;
  }
  applyCell(id, col, raw) {
    const t = this.byId.get(id), work = this.workFor(t), f = this.info.get(id), v = String(raw).trim();
    if (col === 'name') { if (!v) return 'Name cannot be empty'; this.tx(() => { t.name = v; }); return null; }
    if (col === 'owner') {
      const m = v.match(/^(.*?)\s*<([^<>]+)>$/); let name = v, email = '';
      if (m && isEmail(m[2].trim())) { name = m[1].trim(); email = m[2].trim(); } else if (isEmail(v)) { name = v.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); email = v; }
      else if (name && name.toLowerCase() === (t.owner || '').toLowerCase()) email = t.email || '';
      else if (name && this.resolvePerson) { const p = this.resolvePerson(name); if (p) { name = p.name; email = p.email; } }
      this.tx(() => { t.owner = name; t.email = email; }); return null;
    }
    if (col === 'email') { if (v && !isEmail(v)) return 'Not a valid email address'; this.tx(() => { t.email = v; }); return null; }
    if (col === 'start') {
      const d = parseDate(v, f.start); if (d == null) return 'Unrecognised date (try "Nov 12" or 2026-11-12)';
      this.tx(() => {
        this.dragMove(id, d - f.start); // same clamping as dragging, so a group keeps its shape
      });
      return null;
    }
    if (col === 'end') {
      if (f.summary) return 'Summary dates come from their children';
      const d = parseDate(v, f.start); if (d == null) return 'Unrecognised date';
      this.tx(() => { if (t.scheduling === 'auto' && !t.agr) t.scheduling = 'manual'; if (t.ms) { t.start = work.next(d); } else { t.dur = Math.max(1, work.count(t.start, d + 1)); if (this.auto && t.scheduling === 'anchor') t.dur = Math.max(t.dur, work.count(t.start, this.endLB(id))); } });
      return null;
    }
    if (col === 'dur') {
      if (f.summary || t.ms) return 'Duration is fixed for summaries and milestones';
      const n = parseFloat(v); if (!Number.isFinite(n) || !(n >= 1) || n > 99999999 || Math.abs(work.finish(t.start, Math.round(n))) > 99999999) return 'Duration must be at least 1 working day and fit within the supported date range';
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
        if (next.some((l) => l.from === p.id)) return `Only one relationship per task pair is allowed; row ${m[1]} is repeated`;
        next.push({ from: p.id, type, lag });
      }
      const keep = this.links.filter((l) => l.to !== id);
      const saved = this.links; this.links = keep;
      for (const n of next) if (this.reaches(id, n.from)) { this.links = saved; return 'That would create a cycle'; }
      this.links = saved;
      const pre = this.hook?.before() ?? null;
      this.tx(() => { this.links = keep.concat(next.map((n) => ({ id: 'l' + this.nextLink++, from: n.from, to: id, type: n.type, lag: n.lag }))); });
      this.hook?.after({ id, kind: 'link', pre });
      return null;
    }
    return null;
  }
}
