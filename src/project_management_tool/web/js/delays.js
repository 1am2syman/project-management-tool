// Delay accounting (no DOM). Expected dates stay the schedule (task start and duration). Agreed dates are stored on each
// task as agr = { s: agreed start, f: agreed finish (the date, for a milestone), o: the first agreed finish }, and every
// change is recorded in the project's log. Everything shown about delay is derived here, so the sheet, the Gantt,
// Analysis and the exports cannot disagree. Days are working days in the task's own calendar.
import { Store, today as TODAY, VERSION_TYPE_IDS, cleanLog } from './model.js';

export const KINDS = ['Late start', 'Overrun', 'On hold'];
export const DEFAULT_CAUSES = ['Estimate / rework', 'Resource availability', 'Client / approver', 'Supplier / subcontractor', 'External / force majeure', 'Unknown'];
export const VERSION_TYPES = { baseline: 'Agreed baseline', status: 'Status update', draft: 'Draft' };
export const versionTypeLabel = (v) => VERSION_TYPES[v?.type] || '';
export const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
export const UNCLASSIFIED = 'Unclassified';

// ---- causes: one app-wide list. Delays keep the cause id, so renaming updates every delay ----
export function defaultCauses() { return { list: DEFAULT_CAUSES.map((name, i) => ({ id: `c${i + 1}`, name, retired: false })), next: DEFAULT_CAUSES.length + 1 }; }
export function cleanCauses(raw) {
  if (!raw || !Array.isArray(raw.list)) return defaultCauses();
  const list = [], ids = new Set();
  for (const c of raw.list.slice(0, 200)) {
    const name = String(c?.name ?? '').trim().slice(0, 60), id = String(c?.id ?? '').slice(0, 20);
    if (!name || !id || ids.has(id)) continue;
    ids.add(id); list.push({ id, name, retired: !!c.retired });
  }
  const top = Math.max(0, ...list.map((c) => parseInt(c.id.slice(1), 10) || 0));
  return { list, next: Math.max(Number.isSafeInteger(raw.next) ? raw.next : 1, top + 1) };
}
export const causeName = (causes, id) => (id ? causes.list.find((c) => c.id === id)?.name ?? 'Unknown' : UNCLASSIFIED);
export const activeCauses = (causes) => causes.list.filter((c) => !c.retired);
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
export function addCause(causes, name) {
  const n = String(name ?? '').trim().slice(0, 60); if (!n) return 'Give the cause a name';
  const hit = causes.list.find((c) => sameName(c.name, n));
  if (hit && !hit.retired) return 'That cause already exists';
  if (hit) hit.retired = false; else causes.list.push({ id: `c${causes.next++}`, name: n, retired: false });
  return null;
}
export function renameCause(causes, id, name) {
  const c = causes.list.find((x) => x.id === id), n = String(name ?? '').trim().slice(0, 60);
  if (!c) return 'That cause no longer exists'; if (!n) return 'Give the cause a name';
  if (causes.list.some((x) => x.id !== id && sameName(x.name, n))) return 'That cause already exists';
  c.name = n; return null;
}
export const causeInUse = (logs, id) => logs.some((e) => e.cause === id);
// A cause that delays still use is retired (hidden from the picker, kept on old delays) instead of removed.
export function removeCause(causes, id, inUse) {
  const i = causes.list.findIndex((x) => x.id === id); if (i < 0) return 'retired';
  if (inUse) { causes.list[i].retired = true; return 'retired'; }
  causes.list.splice(i, 1); return 'removed';
}
export function moveCause(causes, id, to) {
  const i = causes.list.findIndex((x) => x.id === id); if (i < 0) return;
  const [c] = causes.list.splice(i, 1); causes.list.splice(Math.max(0, Math.min(causes.list.length, to)), 0, c);
}
export const usedCauses = (causes, log) => { const ids = new Set(log.filter((e) => e.cause).map((e) => e.cause)); return causes.list.filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, name: c.name })); };
// Opening a file: map its causes onto the list by name, add unknown ones (active, so they can be picked again), and rewrite the log to this list's ids.
export function importCauses(causes, fileCauses, log) {
  const map = new Map();
  for (const c of Array.isArray(fileCauses) ? fileCauses : []) {
    const hit = causes.list.find((x) => sameName(x.name, c.name));
    if (hit) { map.set(c.id, hit.id); continue; }
    const id = `c${causes.next++}`; causes.list.push({ id, name: String(c.name).trim().slice(0, 60), retired: false }); map.set(c.id, id);
  }
  return log.map((e) => (e.cause ? { ...e, cause: map.get(e.cause) ?? null } : e));
}


// ---- dates ----
const finOf = (s, t) => (t.ms ? t.start : s.finish(t) - 1);
// Last day of a row: a task's final working day, a milestone's date; a summary ends with its last task.
export function fin(s, id) {
  const f = s.info.get(id);
  if (!f.summary) return finOf(s, s.byId.get(id));
  let m = -Infinity;
  for (let j = f.i + 1; j <= f.sub; j++) if (!s.info.get(s.tasks[j].id).summary) m = Math.max(m, finOf(s, s.tasks[j]));
  return m;
}
// The project's last day: its latest task finish or milestone date.
export function endDay(s) { let m = -Infinity; for (const t of s.tasks) if (!s.info.get(t.id).summary) m = Math.max(m, finOf(s, t)); return m; }
// Signed working days from finish a to finish b.
export function wd(s, a, b, id = null) {
  if (a === b) return 0;
  const w = id == null ? s.work : s.workFor(id);
  return b > a ? w.count(a + 1, b + 1) : -w.count(b + 1, a + 1);
}
export const leaves = (s) => s.tasks.filter((t) => !s.info.get(t.id).summary);
export const hasAgreed = (s) => s.tasks.some((t) => t.agr);
export const hasInclusions = (s) => s.tasks.some((t) => t.inc);
export const hasRevision = (s) => s.tasks.some((t) => t.agr && t.agr.o !== t.agr.f) || (s.log || []).some((e) => e.type !== 'delay');

// Everything derived below depends only on the plan, so it is computed once per plan state (Store.rev changes on every edit).
const cache = new WeakMap();
function memo(s, key, make) {
  let c = cache.get(s);
  if (!c || c.rev !== (s.rev ?? 0)) { c = { rev: s.rev ?? 0, m: new Map() }; cache.set(s, c); }
  if (!c.m.has(key)) c.m.set(key, make());
  return c.m.get(key);
}

// A summary has an agreed date only once a baseline was agreed: one deadline never gives the project an agreed date.
// Original agreed dates of summaries and of the completion are frozen when the first baseline is agreed (Store.agreedOrig).
export function agreedOf(s, id) {
  const t = s.byId.get(id), f = s.info.get(id); if (!t || !f) return null;
  if (!f.summary) return t.agr ? { ...t.agr } : null;
  if (!s.baselined) return null;
  const kids = s.tasks.slice(f.i + 1, f.sub + 1).filter((k) => !s.info.get(k.id).summary && k.agr);
  return kids.length ? { s: Math.min(...kids.map((k) => k.agr.s)), f: Math.max(...kids.map((k) => k.agr.f)), o: s.agreedOrig?.sums?.[id] ?? Math.max(...kids.map((k) => k.agr.o)), rollup: true } : null;
}
function agreedEnd(s) {
  if (!s.baselined) return null;
  let m = -Infinity; for (const k of leaves(s)) if (k.agr) m = Math.max(m, k.agr.f);
  return Number.isFinite(m) ? m : null;
}
export function completion(s) {
  if (!s.baselined) return null;
  const kids = leaves(s).filter((k) => k.agr); if (!kids.length) return null;
  const f = Math.max(...kids.map((k) => k.agr.f)), o = s.agreedOrig?.end ?? Math.max(...kids.map((k) => k.agr.o)), expected = endDay(s);
  const pend = pendEffect(s, 'end');
  return { o, f, expected, delay: wd(s, f, expected) - pend, pend, rev: wd(s, o, f), total: wd(s, o, expected) };
}

// ---- counterfactuals: schedule the plan without some work or delay, with the real scheduler ----
// Removing a task connects its predecessors to its successors, so the rest of the chain keeps its order.
function bridge(tasks, links, ids) {
  let n = 0;
  for (const id of ids) {
    const ins = links.filter((l) => l.to === id), outs = links.filter((l) => l.from === id);
    for (const a of ins) for (const b of outs) if (a.from !== b.to && !links.some((l) => l.from === a.from && l.to === b.to)) links.push({ id: `bridge${id}-${n++}`, from: a.from, to: b.to, type: 'FS', lag: 0 });
    for (let i = links.length - 1; i >= 0; i--) if (links[i].from === id || links[i].to === id) links.splice(i, 1);
    const at = tasks.findIndex((t) => t.id === id); if (at >= 0) tasks.splice(at, 1);
  }
}
function copyView(s, mutate) {
  const v = Object.create(Store.prototype), tasks = leaves(s).map((t) => ({ ...t, level: 0 })), links = s.links.map((l) => ({ id: l.id, from: l.from, to: l.to, type: l.type, lag: l.lag }));
  mutate?.(tasks, links);
  Object.assign(v, { tasks, links, calendar: s.calendar, work: s.work, collapsed: new Set(), listeners: [], auto: s.auto !== false, frozen: false, critical: true, criticalTargetId: null, log: [], nextLog: 1, baselined: false });
  v.settle();
  return v;
}
const without = (s, ids) => copyView(s, (tasks, links) => bridge(tasks, links, ids));
const dateIn = (v, id) => (id === 'end' ? endDay(v) : finOf(v, v.byId.get(id)));
export const targets = (s) => [...leaves(s).filter((t) => t.ms).map((t) => ({ id: t.id, name: t.name, ms: true })), { id: 'end', name: 'Project completion', ms: false }];
const expectedOf = (s, id) => (id === 'end' ? endDay(s) : fin(s, id));
const diffAt = (s, a, b, id) => (id !== 'end' && (!a.byId.has(id) || !b.byId.has(id)) ? null : wd(s, dateIn(a, id), dateIn(b, id)));

// Pending inclusions are scheduled out one at a time (newest first), so each one's push on every milestone adds up exactly.
const pendState = (s) => memo(s, 'pend', () => {
  const ids = leaves(s).filter((t) => t.inc).map((t) => t.id); if (!ids.length) return null;
  let cur = s; const steps = [];
  for (const id of [...ids].reverse()) {
    const next = without(cur, [id]), effects = {};
    for (const tg of targets(s)) effects[tg.id] = diffAt(s, next, cur, tg.id);
    steps.push({ id, name: s.byId.get(id).name, effects }); cur = next;
  }
  const fins = new Map(); for (const t of leaves(cur)) fins.set(t.id, finOf(cur, t));
  return { steps: steps.reverse(), view: cur, fins };
});
const pendEffect = (s, id) => pendState(s)?.steps.reduce((n, p) => n + (p.effects[id] || 0), 0) || 0;
const pendOf = (s, id) => { const p = pendState(s), w = p?.fins.get(id); return w == null ? 0 : Math.max(0, wd(s, w, fin(s, id), id)); };
// The pending inclusion that pushes a task: the nearest one among its predecessors.
export function pendingSource(s, id) {
  const seen = new Set([id]), q = [id];
  while (q.length) { const x = q.shift(); for (const l of s.incoming(x)) { if (seen.has(l.from)) continue; if (s.byId.get(l.from)?.inc) return l.from; seen.add(l.from); q.push(l.from); } }
  return null;
}

// ---- variance: total = revision + own + inherited + pending inclusion ----
const entriesOf = (s, id, type = 'delay') => (s.log || []).filter((e) => e.taskId === id && e.type === type);
export const ownLogged = (s, id) => entriesOf(s, id).reduce((n, e) => n + Math.max(0, e.days), 0);
// The predecessor that pushes a task: the latest-finishing one that is late or not itself agreed.
export function sourceOf(s, id) {
  let best = null;
  for (const l of s.incoming(id)) {
    const p = s.byId.get(l.from); if (!p) continue;
    const e = fin(s, l.from);
    if (p.agr && (e <= p.agr.f || wd(s, p.agr.f, e, l.from) <= 0)) continue;
    if (!best || e > best.e) best = { id: l.from, e };
  }
  if (!best) for (const l of s.incoming(id)) { const e = s.byId.has(l.from) ? fin(s, l.from) : -Infinity; if (!best || e > best.e) best = { id: l.from, e }; } // pushed by a connection, not by a late predecessor
  return best?.id ?? null;
}
// Days its predecessors push the task past its agreed finish: the task re-scheduled with its agreed length from the
// earliest start its connections allow. Whatever else moved it is the task's own doing.
function pushOf(s, id, v) {
  const t = s.byId.get(id), a = t.agr;
  if (!a || v <= 0 || !s.incoming(id).length) return 0;
  const lb = s.lowerBound(id); if (!Number.isFinite(lb)) return 0;
  const w = s.workFor(t);
  const f = t.ms ? w.next(Math.max(a.f, lb)) : w.finish(w.next(Math.max(a.s, lb)), Math.max(1, w.count(a.s, a.f + 1))) - 1;
  return Math.min(v, Math.max(0, wd(s, a.f, f, id)));
}
export function row(s, id) {
  return memo(s, `row${id}`, () => {
    const a = agreedOf(s, id); if (!a) return null;
    const f = s.info.get(id), e = fin(s, id), w = f.summary ? null : id;
    const v = wd(s, a.f, e, w), rev = wd(s, a.o, a.f, w), total = wd(s, a.o, e, w);
    let own = 0, inherited = 0, pend = 0, source = null;
    if (f.summary) own = v;
    else {
      pend = v > 0 ? Math.min(v, pendOf(s, id)) : 0;
      inherited = Math.max(0, pushOf(s, id, v) - pend);
      own = v - inherited - pend;
      source = inherited ? sourceOf(s, id) : null;
    }
    return { id, agreed: a.f, orig: a.o, start: a.s, expected: e, v, rev, own, inherited, pend, source, pendSource: pend ? pendingSource(s, id) : null, rollup: !!a.rollup, summary: f.summary, total };
  });
}
// Follow an inherited delay back to the task where it started.
export function originOf(s, id) {
  for (let i = 0; i < 100; i++) { const r = row(s, id); if (!r || r.own > 0 || r.source == null) return id; id = r.source; }
  return id;
}
export const lastDelay = (s, id) => entriesOf(s, id).at(-1) || null;

// ---- overdue: unfinished and past its agreed (and expected) date; the app never moves anything by itself ----
export function overdue(s, id, today = TODAY) {
  const t = s.byId.get(id), f = s.info.get(id), a = t?.agr;
  if (!t || f.summary || !a || t.progress >= 100) return 0;
  const last = Math.max(fin(s, id), a.f);
  return last < today ? Math.max(1, wd(s, last, today, id)) : 0;
}

// ---- tooltip lines for a bar ----
export function explain(s, id, causes) {
  const r = row(s, id); if (!r || r.rollup) return null;
  const parts = [];
  if (r.own > 0) { const e = lastDelay(s, id); parts.push(`Own ${sign(r.own)}${e ? ` · ${causeName(causes, e.cause)}${e.party ? ` · ${e.party}` : ''}` : ' · Unclassified'}`); }
  if (r.inherited > 0) {
    const from = originOf(s, r.source ?? id), o = lastDelay(s, from);
    parts.push(`Inherited ${sign(r.inherited)} from ${s.byId.get(from)?.name ?? 'an earlier task'}${o ? ` (${causeName(causes, o.cause)})` : ''}`);
  }
  if (r.pend > 0) parts.push(`Pending inclusion ${sign(r.pend)} from ${s.byId.get(r.pendSource)?.name ?? 'new work'}`);
  if (r.own < 0) parts.push(`Recovered ${sign(-r.own)} against the agreed date`);
  if (r.rev) parts.push(`Revision ${sign(r.rev)}`);
  return { head: `${s.byId.get(id).name} · ${r.v ? `${sign(r.v)}d vs agreed` : 'on the agreed date'}`, parts, row: r };
}

// ---- Gantt render model: only the task where the delay started is shaded ----
// Its shaded days are those after (agreed finish + inherited days + pending inclusion days). A task pushed by anything else is a plain bar.
export function ganttModel(s, id) {
  const t = s.byId.get(id), f = s.info.get(id), a = t?.agr;
  if (!t || f.summary || !a) return null;
  const r = row(s, id); if (!r) return null;
  const out = { id, ms: !!t.ms, agreedFinish: a.f, marker: t.ms ? 'diamond' : 'triangle', shade: null, leadIn: null, inheritedFrom: r.source, own: Math.max(0, r.own), inherited: r.inherited, pending: r.pend };
  if (!t.ms && r.own > 0) {
    const w = s.workFor(t), from = Math.max(f.start, w.shift(a.f, r.inherited + r.pend) + 1);
    if (from < f.end) out.shade = { from, to: f.end, days: r.own };
  }
  if (!t.ms && r.own > 0 && f.start > a.s && lastDelay(s, id)?.kind === 'Late start') out.leadIn = { from: a.s, to: f.start };
  return out;
}

// What typing a later finish for one task would do: how many agreed tasks it pushes and how far the project finish moves.
export function whatIfFinish(s, id, day) {
  const cf = copyView(s, (tasks) => { const x = tasks.find((q) => q.id === id); if (!x) return; if (x.ms) x.start = day; else x.dur = Math.max(1, s.workFor(x).count(x.start, day + 1)); });
  let pushed = 0;
  for (const k of leaves(s)) if (k.id !== id && k.agr && cf.byId.has(k.id) && fin(cf, k.id) > fin(s, k.id)) pushed++;
  return { pushed, finish: Math.max(0, wd(s, endDay(s), endDay(cf))) };
}

// ---- effects of every recorded change on every milestone ----
const delayEntries = (s) => (s.log || []).filter((e) => e.type === 'delay' && e.days > 0 && s.byId.has(e.taskId));
// Delays are taken out newest first, so the effects add up exactly (telescoping): effect = date(before removal) - date(after).
// Revisions, inclusions and omissions moved the agreed dates themselves; each entry stores that effect (entry.eff).
export const changeEffects = (s) => memo(s, 'fx', () => {
  const ps = pendState(s), out = [];
  let cur = ps ? ps.view : s;
  for (const e of [...delayEntries(s)].reverse()) {
    const next = copyView(cur, (tasks) => {
      const t = tasks.find((x) => x.id === e.taskId); if (!t) return;
      if (e.op === 'start') t.start = s.workFor(t).shift(t.start, -e.days);
      else if (!t.ms) t.dur = Math.max(1, t.dur - e.days);
    });
    const effects = {};
    for (const tg of targets(s)) effects[tg.id] = diffAt(s, next, cur, tg.id);
    out.push({ entry: e, effects });
    cur = next;
  }
  const agreed = (s.log || []).filter((e) => e.type !== 'delay').map((entry) => ({ entry, effects: Object.fromEntries(targets(s).map((tg) => [tg.id, entry.eff?.[tg.id] ?? 0])) }));
  return { list: [...agreed, ...out.reverse()], pend: ps?.steps ?? [], base: cur };
});
export function milestoneTable(s, causes, stars = new Set(), fx = changeEffects(s)) {
  const rows = [];
  if (!hasAgreed(s)) return rows;
  for (const tg of targets(s)) {
    const ag = tg.id === 'end' ? (() => { const c = completion(s); return c && { o: c.o, f: c.f }; })() : (() => { const a = agreedOf(s, tg.id); return a && { o: a.o, f: a.f }; })();
    if (!ag) continue;
    const exp = expectedOf(s, tg.id), pend = fx.pend.reduce((n, p) => n + (p.effects[tg.id] || 0), 0), delay = wd(s, ag.f, exp) - pend, rev = wd(s, ag.o, ag.f), total = wd(s, ag.o, exp);
    const reachesEnd = tg.id === 'end' || fx.list.some((x) => x.entry.type === 'delay' && x.effects[tg.id] > 0 && x.effects.end > 0);
    const status = delay > 0 ? (reachesEnd ? 'Late' : 'Late · end not affected') : delay < 0 ? 'Early' : pend > 0 ? 'Pending inclusion' : 'On time';
    const by = new Map();
    for (const { entry, effects } of fx.list) {
      const n = effects[tg.id]; if (!n) continue;
      if (entry.type !== 'delay') continue; // causes explain the Delay column; agreed changes are in Revisions
      const label = causeName(causes, entry.cause);
      by.set(label, (by.get(label) || 0) + n);
    }
    const explained = [...by.values()].reduce((n, d) => n + d, 0);
    if (delay !== explained) by.set('Other / unexplained', delay - explained);
    rows.push({ id: tg.id, name: tg.name, orig: ag.o, cur: ag.f, exp, delay, pend, rev, total, status, causes: [...by].map(([name, days]) => ({ name, days })).sort((a, b) => b.days - a.days), starred: tg.id === 'end' || stars.has(tg.id), ms: tg.ms });
  }
  return rows;
}
export const nameOf = (s, id) => s.byId.get(id)?.name ?? (s.log || []).find((e) => e.taskId === id)?.taskName ?? `#${id}`;
// Names the task as well as the change, so a grid row and a waterfall step say where it happened.
const entryLabel = (s, e) => {
  const task = e.taskName || nameOf(s, e.taskId);
  if (e.type === 'revision') return `Revision · ${task}: ${e.reason || 'agreed change'}`;
  if (e.type === 'inclusion') return `Inclusion · ${task}${e.reason ? `: ${e.reason}` : ''}`;
  if (e.type === 'omission') return `Omission · ${task}${e.reason ? `: ${e.reason}` : ''}`;
  return `${nameOf(s, e.taskId)} · own ${sign(e.days)}`;
};
// Task × milestone: each column sums exactly to that milestone's total; the last row is whatever the log cannot explain.
export function impactGrid(s, causes, stars = new Set()) {
  const fx = changeEffects(s), cols = milestoneTable(s, causes, stars, fx);
  const rows = fx.list.map(({ entry, effects }) => ({ entry, effects, label: entryLabel(s, entry) }));
  const order = (r) => (r.entry.type !== 'delay' ? 1e6 + r.entry.id : (s.info.get(r.entry.taskId)?.i ?? 1e5));
  rows.sort((a, b) => order(a) - order(b));
  for (const p of fx.pend) rows.push({ entry: { type: 'pending', id: 0, taskId: p.id }, effects: p.effects, label: `Pending inclusion: ${p.name}` });
  const unexplained = {};
  for (const c of cols) unexplained[c.id] = c.total - rows.reduce((n, r) => n + (r.effects[c.id] || 0), 0);
  return { cols, rows, unexplained };
}
// Steps for one milestone, in the shape the finish waterfall draws: agreed changes, current agreed, delays, pending inclusions, expected.
export function explainSteps(s, causes, id, stars = new Set()) {
  const fx = changeEffects(s), m = milestoneTable(s, causes, stars, fx).find((x) => x.id === id); if (!m) return null;
  const w = s.work, steps = []; let at = m.orig;
  const add = (type, title, days, extra = {}) => { const to = w.shift(at, days); steps.push({ type, title, days, from: at, to, ...extra }); at = to; };
  let changed = 0;
  for (const { entry, effects } of fx.list) {
    if (entry.type === 'delay' || !effects[id]) continue;
    add(entry.type, entryLabel(s, entry), effects[id], { task: entry.taskName || nameOf(s, entry.taskId), reason: entry.reason || '', approvedBy: entry.approvedBy || '', source: entry.source || '' }); changed += effects[id];
  }
  if (m.rev !== changed) add('revision', 'Other agreed changes', m.rev - changed, { task: '', approvedBy: '', reason: '' });
  const agreedAt = at;
  let delayDays = 0;
  for (const { entry, effects } of fx.list) if (entry.type === 'delay' && effects[id]) { add('delay', `${nameOf(s, entry.taskId)} · ${entry.kind || 'Delay'}`, effects[id], { task: nameOf(s, entry.taskId), cause: causeName(causes, entry.cause), party: entry.party || '', own: entry.days }); delayDays += effects[id]; }
  if (m.delay !== delayDays) add('residual', 'Other / unexplained', m.delay - delayDays, { task: '', cause: '' });
  for (const p of fx.pend) if (p.effects[id]) add('pending', `Pending inclusion: ${p.name}`, p.effects[id], { task: p.name });
  return { id, name: m.name, orig: m.orig, agreed: agreedAt, exp: m.exp, total: m.total, steps, status: m.status };
}
// Owners are charged only with the delay that started at their own tasks. Unclassified is part of Own; Inherited is summed per task, so it is not additive with Own.
export function ownerTable(s) {
  const owners = new Map();
  for (const t of leaves(s)) {
    const name = t.owner || 'Unassigned', r = row(s, t.id);
    if (!owners.has(name)) owners.set(name, { owner: name, tasks: 0, own: 0, inherited: 0, unclassified: 0, revisions: 0 });
    const x = owners.get(name); x.tasks++;
    if (r) { x.own += Math.max(0, r.own); x.inherited += r.inherited; }
    // Revisions are counted where they were recorded: a revision that only pushed a later task is not that task owner's.
    for (const e of entriesOf(s, t.id, 'revision')) x.revisions += e.days;
    for (const e of entriesOf(s, t.id)) if (!e.cause) x.unclassified += Math.max(0, e.days);
  }
  return [...owners.values()].filter((o) => o.own || o.inherited || o.revisions || o.unclassified).sort((a, b) => b.own - a.own || b.inherited - a.inherited);
}
// own + inherited + pending inclusion + revision = total for every task (a task whose numbers do not reconcile is returned).
export function reconcile(s) {
  const bad = [];
  for (const t of leaves(s)) { const r = row(s, t.id); if (r && r.own + r.inherited + r.pend + r.rev !== r.total) bad.push(t.id); }
  return bad;
}
export function delayLog(s, causes) {
  const label = { delay: 'Delay', revision: 'Revision', inclusion: 'Inclusion', omission: 'Omission' };
  return (s.log || []).map((e) => ({ ...e, taskName: s.byId.get(e.taskId)?.name ?? e.taskName, typeLabel: e.type === 'delay' && e.days < 0 ? 'Recovery' : label[e.type], causeLabel: e.type === 'delay' ? causeName(causes, e.cause) : '' }));
}

// ---- version types ----
export const versionTypeOf = (v) => (VERSION_TYPE_IDS.includes(v?.type) ? v.type : null);
export const latestBaseline = (versions) => [...versions].reverse().find((v) => v.type === 'baseline') || null;

// ---- mutations. Each goes through store.tx / store.amend, so undo and redo cover the agreed dates and the log ----
export function snapshotBefore(s) {
  const fins = new Map(), starts = new Map(), sched = new Map();
  for (const t of leaves(s)) { fins.set(t.id, fin(s, t.id)); starts.set(t.id, s.info.get(t.id).start); sched.set(t.id, t.scheduling); }
  return { fins, starts, sched, end: endDay(s) };
}
// Entries are stored in the same clean shape a reload produces, so undo and a file round trip give identical data.
const push = (store, e) => { store.log.push(...cleanLog([{ id: store.nextLog++, at: Date.now(), ...e }])); };
const norm = (store, t, day) => store.workFor(t).next(day);
const need = (v) => !String(v ?? '').trim();
// Agreed dates of milestones and of the completion: what an agreed change moved is the difference before and after.
function markMap(s) {
  const m = new Map(); for (const t of leaves(s)) if (t.ms && t.agr) m.set(t.id, t.agr.f);
  const end = agreedEnd(s); if (end != null) m.set('end', end);
  return m;
}
function effSince(s, before) {
  const eff = {};
  for (const [k, v] of markMap(s)) { if (!before.has(k)) continue; const d = wd(s, before.get(k), v, k === 'end' ? null : k); if (d) eff[k] = d; }
  return eff;
}
// Set the agreed finish of one task. Changing an existing agreed date is a revision: it needs a reason and an approver.
export function setAgreed(store, id, finishDay, { reason = '', approvedBy = '' } = {}) {
  const err = store.structureError(); if (err) return err;
  const t = store.byId.get(id); if (!t) return 'Task no longer exists';
  if (store.info.get(id).summary) return 'Summary dates come from their tasks';
  if (!Number.isSafeInteger(finishDay)) return 'Choose a date';
  const day = norm(store, t, finishDay), changes = !!t.agr && t.agr.f !== day;
  if (changes && (need(reason) || need(approvedBy))) return 'Changing an agreed date needs a reason and who approved it';
  store.tx(() => {
    const m0 = markMap(store), from = t.agr?.f;
    t.agr = { s: t.agr?.s ?? store.info.get(id).start, f: day, o: t.agr?.o ?? day };
    delete t.inc;
    if (changes) push(store, { type: 'revision', taskId: id, taskName: t.name, days: wd(store, from, day, id), op: 'finish', reason: reason.trim(), approvedBy: approvedBy.trim(), source: 'deadline', eff: effSince(store, m0) });
  });
  return null;
}
// Agreed dates that agreeing a baseline now would change (tasks whose agreed date differs from the expected date).
export function baselineChanges(s) {
  return leaves(s).filter((t) => t.agr && !t.inc && t.agr.f !== fin(s, t.id)).map((t) => ({ id: t.id, name: t.name, from: t.agr.f, to: fin(s, t.id), days: wd(s, t.agr.f, fin(s, t.id), t.id) }));
}
export const pendingInclusions = (s) => leaves(s).filter((t) => t.inc).map((t) => ({ id: t.id, name: t.name }));
// The original agreed completion and summary dates, frozen with the first baseline.
function freezeOriginals(store) {
  const kids = leaves(store).filter((k) => k.agr); if (!kids.length) return;
  const sums = {};
  for (const t of store.tasks) {
    const f = store.info.get(t.id); if (!f.summary) continue;
    const under = store.tasks.slice(f.i + 1, f.sub + 1).filter((k) => !store.info.get(k.id).summary && k.agr);
    if (under.length) sums[t.id] = Math.max(...under.map((k) => k.agr.o));
  }
  store.agreedOrig = { end: Math.max(...kids.map((k) => k.agr.o)), ...(Object.keys(sums).length ? { sums } : {}) };
}
// An inclusion becomes agreed: the new task gets its agreed date, and every agreed task it pushes later gets its agreed date
// moved by the same amount (so it shows no delay), measured by scheduling the plan without the new work.
function agreeIncl(store, t, finishDay, reason, approvedBy) {
  const id = t.id, wo = without(store, [id]), m0 = markMap(store), shifts = [];
  for (const k of leaves(store)) {
    if (k.id === id || !k.agr || !wo.byId.has(k.id)) continue;
    const d = Math.max(0, wd(store, fin(wo, k.id), fin(store, k.id), k.id)), ds = Math.max(0, wd(store, wo.info.get(k.id).start, store.info.get(k.id).start, k.id));
    if (d || ds) shifts.push([k, d, ds]);
  }
  const day = norm(store, t, finishDay ?? fin(store, id));
  t.agr = { s: t.ms ? day : store.info.get(id).start, f: day, o: day }; delete t.inc;
  for (const [k, d, ds] of shifts) { const w = store.workFor(k); k.agr = { s: k.ms ? w.shift(k.agr.f, d) : w.shift(k.agr.s, ds), f: w.shift(k.agr.f, d), o: k.agr.o }; }
  push(store, { type: 'inclusion', taskId: id, taskName: t.name, days: t.ms ? 0 : t.dur, reason: reason.trim(), approvedBy: approvedBy.trim(), to: day, eff: effSince(store, m0) });
}
// Every task without an agreed date gets its expected one. Agreed dates already set are kept unless `replace` is chosen,
// which records a revision for each and needs a reason and an approver. `includePending` agrees waiting inclusions with it.
export function agreeBaseline(store, { replace = false, reason = '', approvedBy = '', includePending = false } = {}) {
  const err = store.structureError(); if (err) return err;
  const waiting = includePending ? leaves(store).filter((t) => t.inc) : [];
  if ((waiting.length || (replace && baselineChanges(store).length)) && (need(reason) || need(approvedBy))) return waiting.length ? 'Agreeing inclusions needs a reason and who approved it' : 'Changing agreed dates needs a reason and who approved it';
  store.tx(() => {
    for (const t of waiting) agreeIncl(store, t, null, reason, approvedBy);
    for (const t of leaves(store)) {
      if (t.inc) continue;
      const e = fin(store, t.id), start = store.info.get(t.id).start;
      if (!t.agr) { t.agr = { s: t.ms ? e : start, f: e, o: e }; continue; }
      if (replace && t.agr.f !== e) {
        const m0 = markMap(store), from = t.agr.f;
        t.agr = { s: t.ms ? e : start, f: e, o: t.agr.o };
        push(store, { type: 'revision', taskId: t.id, taskName: t.name, days: wd(store, from, e, t.id), op: 'finish', reason: reason.trim(), approvedBy: approvedBy.trim(), source: 'baseline', eff: effSince(store, m0) });
      }
    }
    if (!store.baselined) freezeOriginals(store);
    store.baselined = true;
  });
  return null;
}
// An edit just moved `id` later. `pre` is snapshotBefore() taken before it. Records a delay or a revision at that task;
// a revision also moves the agreed dates of the tasks it pushed, so only the edited task shows variance against its new date.
export function record(store, id, pre, entry, { anchor = false } = {}) {
  const t = store.byId.get(id), a = t?.agr; if (!a) return 'This task has no agreed date';
  if (entry.type === 'revision' && (need(entry.reason) || need(entry.approvedBy))) return 'A revision needs a reason and who approved it';
  const now = fin(store, id), from = Math.max(pre.fins.get(id) ?? now, a.f), days = Math.max(1, wd(store, from, now, id));
  const pushes = [];
  for (const k of leaves(store)) {
    if (k.id === id || !k.agr || !pre.fins.has(k.id)) continue;
    const d = wd(store, pre.fins.get(k.id), fin(store, k.id), k.id), ds = wd(store, pre.starts.get(k.id), store.info.get(k.id).start, k.id);
    if (d > 0 || ds > 0) pushes.push([k, Math.max(0, d), Math.max(0, ds)]);
  }
  store.amend(() => {
    const m0 = markMap(store);
    const e = { type: entry.type, taskId: id, taskName: t.name, days, op: entry.op === 'start' ? 'start' : 'finish', note: entry.note || '' };
    if (entry.type === 'revision') Object.assign(e, { reason: entry.reason.trim(), approvedBy: entry.approvedBy.trim() });
    else Object.assign(e, { kind: KINDS.includes(entry.kind) ? entry.kind : e.op === 'start' ? 'Late start' : 'Overrun', cause: entry.cause || null, party: String(entry.party || '').trim() });
    if (anchor && t.scheduling === 'manual') t.scheduling = 'anchor';
    if (e.type === 'revision') { // the agreed date moves by the days of this change only; earlier delays on the task stay delays
      const w = store.workFor(t), ds = e.op === 'start' ? Math.max(0, wd(store, pre.starts.get(id) ?? a.s, store.info.get(id).start, id)) : 0;
      t.agr = { s: t.ms ? w.shift(a.f, days) : w.shift(a.s, ds), f: w.shift(a.f, days), o: a.o };
      for (const [k, d, dStart] of pushes) { const kw = store.workFor(k); k.agr = { s: k.ms ? kw.shift(k.agr.f, d) : kw.shift(k.agr.s, dStart), f: kw.shift(k.agr.f, d), o: k.agr.o }; }
      e.eff = effSince(store, m0);
    }
    push(store, e);
  });
  return null;
}
// Re-classify a recorded delay (cause, party, kind, note). One undo step.
export function reclassify(store, entryId, patch) {
  const e = store.log.find((x) => x.id === entryId); if (!e || e.type !== 'delay') return 'That entry no longer exists';
  store.tx(() => {
    if ('cause' in patch) e.cause = patch.cause || null;
    if ('party' in patch) e.party = String(patch.party || '').trim().slice(0, 80);
    if ('kind' in patch && KINDS.includes(patch.kind)) e.kind = patch.kind;
    if ('note' in patch) e.note = String(patch.note || '').trim().slice(0, 500);
  });
  return null;
}
// Recorded delays (not recoveries) that still have no cause: the soft check when an Agreed baseline is saved.
export const unclassifiedDelays = (s) => (s.log || []).filter((e) => e.type === 'delay' && !e.cause && e.days > 0);
export const delaysOf = (s, taskId) => (s.log || []).filter((e) => e.type === 'delay' && e.taskId === taskId);
export function agreeInclusion(store, id, { finishDay = null, reason = '', approvedBy = '' } = {}) {
  const err = store.structureError(); if (err) return err;
  const t = store.byId.get(id); if (!t?.inc) return 'This task is not a pending inclusion';
  if (need(reason) || need(approvedBy)) return 'An agreed inclusion needs a reason and who approved it';
  store.tx(() => agreeIncl(store, t, finishDay, reason, approvedBy));
  return null;
}
// What an omission would cut out of the chain: the tasks before the removed rows and the tasks after them.
export function omitChain(s, id) {
  const f = s.info.get(id); if (!f) return { preds: [], succs: [] };
  const set = new Set(s.tasks.slice(f.i, f.sub + 1).map((t) => t.id));
  const preds = [...new Set(s.links.filter((l) => set.has(l.to) && !set.has(l.from)).map((l) => l.from))];
  const succs = [...new Set(s.links.filter((l) => set.has(l.from) && !set.has(l.to)).map((l) => l.to))];
  return { preds, succs };
}
// Omit from scope (agreed): the rows go and a record stays in the log for every agreed task removed. With `relink` the
// predecessors are connected to the successors so the rest of the chain keeps its order; the days that pulls in move the
// agreed dates of the tasks that finish earlier, so an agreed omission is not a recovery.
export function omit(store, id, { reason = '', approvedBy = '', relink = true } = {}) {
  const err = store.structureError(); if (err) return err;
  const f = store.info.get(id); if (!f) return 'Task no longer exists';
  if (need(reason) || need(approvedBy)) return 'An agreed omission needs a reason and who approved it';
  store.tx(() => {
    const rows = store.tasks.slice(f.i, f.sub + 1), pre = snapshotBefore(store), m0 = markMap(store), chain = omitChain(store, id);
    const agreedRows = rows.filter((g) => !store.info.get(g.id).summary && g.agr);
    if (relink) for (const p of chain.preds) for (const q of chain.succs) if (p !== q && !store.linksBetween(p, q).length) store.links.push({ id: `l${store.nextLink++}`, from: p, to: q, type: 'FS', lag: 0 });
    store.removeRows(id); store.settle();
    for (const k of leaves(store)) {
      if (!k.agr || !pre.fins.has(k.id)) continue;
      const d = Math.min(0, wd(store, pre.fins.get(k.id), fin(store, k.id), k.id)), ds = Math.min(0, wd(store, pre.starts.get(k.id), store.info.get(k.id).start, k.id));
      if (d || ds) { const w = store.workFor(k); k.agr = { s: k.ms ? w.shift(k.agr.f, d) : w.shift(k.agr.s, ds), f: w.shift(k.agr.f, d), o: k.agr.o }; }
    }
    const eff = effSince(store, m0);
    agreedRows.forEach((g, i) => push(store, { type: 'omission', taskId: g.id, taskName: g.name, days: g.ms ? 0 : g.dur, reason: reason.trim(), approvedBy: approvedBy.trim(), from: g.agr.f, ...(i === 0 ? { eff } : {}) }));
  });
  return null;
}
export const hasAgreedRows = (s, id) => { const f = s.info.get(id); return !!f && s.tasks.slice(f.i, f.sub + 1).some((t) => t.agr); };
