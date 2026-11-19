// Ordered schedule replay for the finish waterfall. Snapshots preserve endpoints, not an edit
// history or a unique causal decomposition. Every step is the marginal effect of a documented
// group of changes, measured in the compared calendar. No live Store is loaded or mutated.
import { Store } from './model.js';
import { WorkingCalendar } from './calendar.js';
import { workDelta, fmtDay, signed } from './versiondiff.js';

export const WATERFALL_METHOD = 'Calendar first, then task additions/removals and dependencies, then revisions in dependency order. Independent revisions are grouped. Contributions depend on this order; snapshots do not contain edit history.';
export const WATERFALL_TYPES = { calendar: 'Calendar revised', added: 'Item added', removed: 'Item removed', revised: 'Item revised', scope: 'Items added / removed', links: 'Dependencies revised', parallel: 'Parallel revisions', scheduling: 'Scheduling revised', residual: 'Unexplained difference', delay: 'Recorded delay', revision: 'Agreed revision', inclusion: 'Agreed inclusion', omission: 'Agreed omission', pending: 'Pending inclusion', subtotal: 'Current agreed date' };
const clone = (value) => JSON.parse(JSON.stringify(value));
const pair = (l) => `${l.from}>${l.to}`;
const mode = (t) => t.scheduling || 'auto';
const finish = (view) => view.project.end - 1;
const leaves = (view) => view.tasks.filter((t) => !view.info.get(t.id).summary).map((t) => ({ ...t }));
const linkData = (l) => ({ id: l.id, from: l.from, to: l.to, type: l.type, lag: l.lag });
const nameOf = (id, a, b) => b.byId.get(id)?.name ?? a.byId.get(id)?.name ?? `#${id}`;

// Flat leaves retain the actual schedule; hierarchy contributes only through leaf conversions.
// Critical scope is deliberately project completion, and completed tasks' float still matters.
function replayView(source, auto) {
  const v = Object.create(Store.prototype);
  Object.assign(v, { tasks: leaves(source).map((t) => ({ ...t, level: 0 })), links: source.links.map(linkData), calendar: clone(source.calendar), work: new WorkingCalendar(source.calendar), collapsed: new Set(), listeners: [], auto, frozen: false, critical: true, criticalTargetId: null });
  v.recalc(); return v;
}
function acyclic(view) {
  const indeg = new Map(view.tasks.map((t) => [t.id, 0]));
  for (const l of view.links) indeg.set(l.to, indeg.get(l.to) + 1);
  const q = [...indeg].filter(([, n]) => !n).map(([id]) => id);
  for (let i = 0; i < q.length; i++) for (const l of view.outgoing(q[i])) { indeg.set(l.to, indeg.get(l.to) - 1); if (!indeg.get(l.to)) q.push(l.to); }
  return q.length === view.tasks.length;
}
const isDriver = (v, id) => v.info.get(id)?.float != null && v.info.get(id).float <= 0;

function pathsFrom(view, ids) {
  const memo = new Map();
  // Store successor pointers rather than copying every suffix of a long dependency chain.
  for (const id of view.topo().reverse()) {
    if (!isDriver(view, id)) continue;
    const t = view.byId.get(id);
    let path = view.finish(t) === view.project.end ? { next: null, length: 1 } : null;
    for (const l of view.outgoing(id)) {
      if (l.slack > 0 || mode(view.byId.get(l.to)) === 'manual') continue;
      const next = memo.get(l.to); if (next && (!path || next.length + 1 > path.length)) path = { next: l.to, length: next.length + 1 };
    }
    if (path) memo.set(id, path);
  }
  const paths = ids.filter((id) => memo.has(id)).map((id) => { const names = []; for (let next = id; next != null; next = memo.get(next).next) names.push(view.byId.get(next).name); return names; });
  return [...new Map(paths.map((p) => [p.join(' → '), p])).values()];
}

function topologyGroups(A, B) {
  const a = new Map(leaves(A).map((t) => [t.id, t])), b = new Map(leaves(B).map((t) => [t.id, t]));
  const la = new Map(A.links.map((l) => [pair(l), linkData(l)])), lb = new Map(B.links.map((l) => [pair(l), linkData(l)]));
  const nodes = [...new Set([...a.keys(), ...b.keys()])].filter((id) => !a.has(id) || !b.has(id));
  const edges = [...new Set([...la.keys(), ...lb.keys()])].filter((key) => !la.has(key) || !lb.has(key) || la.get(key).type !== lb.get(key).type || la.get(key).lag !== lb.get(key).lag);
  const parent = new Map(), find = (id) => { if (!parent.has(id)) parent.set(id, id); let root = id; while (parent.get(root) !== root) root = parent.get(root); while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; } return root; };
  for (const id of nodes) find(id);
  for (const key of edges) { const l = lb.get(key) || la.get(key); parent.set(find(l.to), find(l.from)); }
  const groups = new Map();
  const group = (id) => { const root = find(id); if (!groups.has(root)) groups.set(root, { nodes: [], edges: [] }); return groups.get(root); };
  for (const id of nodes) group(id).nodes.push(id);
  for (const key of edges) group((lb.get(key) || la.get(key)).from).edges.push(key);
  return { groups: [...groups.values()], a, b, la, lb };
}

function structuralStep(g, topo, A, B) {
  const { a, b, la, lb } = topo;
  const items = g.nodes.map((id) => ({ id, name: nameOf(id, A, B), kind: b.has(id) ? 'added' : 'removed', before: a.has(id) ? `${a.get(id).dur} working days` : 'Not in baseline', after: b.has(id) ? `${b.get(id).dur} working days` : 'Removed' }));
  const relationships = g.edges.map((key) => {
    const old = la.get(key), now = lb.get(key), l = now || old;
    const text = (v) => v ? `${v.type}${v.lag ? ` ${signed(v.lag)}` : ''}` : 'None';
    return { from: l.from, to: l.to, name: `${nameOf(l.from, A, B)} → ${nameOf(l.to, A, B)}`, before: text(old), after: text(now) };
  });
  const kinds = new Set(items.map((i) => i.kind));
  const type = !items.length ? 'links' : kinds.size > 1 ? 'scope' : items[0].kind;
  return {
    type, title: items.length ? items.map((i) => i.name).join(' + ') : relationships.map((l) => l.name).join('; '), items, relationships,
    ids: [...new Set([...g.nodes, ...relationships.flatMap((l) => [l.from, l.to])])],
    reason: 'Task scope and its connected dependency edits are applied together so inserted or removed work is evaluated with its connections. A connected replacement has a joint effect; separate per-item shares are not implied.',
    apply(v) {
      const removed = new Set(g.nodes.filter((id) => !b.has(id)));
      v.tasks = v.tasks.filter((t) => !removed.has(t.id));
      for (const id of g.nodes) if (b.has(id) && !a.has(id)) v.tasks.push({ ...b.get(id), level: 0 });
      const keys = new Set(g.edges);
      v.links = v.links.filter((l) => !keys.has(pair(l)) && !removed.has(l.from) && !removed.has(l.to));
      for (const key of g.edges) if (lb.has(key)) v.links.push({ ...lb.get(key) });
    },
  };
}

function revisionSteps(B, topo) {
  const candidates = new Map();
  for (const [id, t] of topo.b) {
    const a = topo.a.get(id); if (!a) continue;
    const fields = ['dur', 'ms', 'scheduling'].filter((k) => (k === 'scheduling' ? mode(a) !== mode(t) : a[k] !== t[k]));
    // A linked Auto task's start is an output. Manual, anchored, unlinked and paused dates are inputs.
    const dateInput = !B.auto || mode(t) !== 'auto' || !B.incoming(id).length;
    if (dateInput && a.start !== t.start) fields.push('start');
    if (!fields.length) continue;
    const format = (task) => `${task.ms ? 'Milestone' : `${task.dur} working days`}${dateInput ? ` · ${fmtDay(task.start)}` : ''} · ${mode(task)}`;
    candidates.set(id, { id, name: t.name, kind: 'revised', before: format(a), after: format(t), fields });
  }
  // Rank only revised ancestors, so revisions at different physical depths but on independent
  // branches still share an antichain. No arbitrary individual shares are assigned within it.
  const ranks = new Map(), groups = new Map();
  for (const id of B.topo()) {
    const rank = Math.max(0, ...B.incoming(id).map((l) => ranks.get(l.from) || 0));
    ranks.set(id, rank + (candidates.has(id) ? 1 : 0));
    if (candidates.has(id)) { if (!groups.has(rank)) groups.set(rank, []); groups.get(rank).push(candidates.get(id)); }
  }
  return [...groups.values()].map((items) => ({
    type: items.length > 1 ? 'parallel' : 'revised', title: items.map((i) => i.name).join(' + '), items, relationships: [], ids: items.map((i) => i.id),
    reason: items.length > 1 ? 'Independent task revisions are recalculated together. Their combined effect includes competition between parallel paths; no individual share is implied.' : 'Only scheduling inputs are revised. Downstream Auto dates are recalculated, so their propagated movement is counted once.',
    apply(v) { const map = new Map(v.tasks.map((t) => [t.id, t])); for (const item of items) { const t = map.get(item.id), b = topo.b.get(item.id); for (const key of item.fields) t[key] = b[key]; } },
  }));
}

// Returns a reconciled bridge, including zero-effect changes and an explicit residual when
// saved dates differ from what replay can reproduce. Zero working days can still move a date.
export function finishWaterfall(A, B) {
  const baseline = finish(A), compared = finish(B), total = { days: compared - baseline, work: workDelta(B.work, baseline, compared) };
  const out = { available: true, baseline, compared, ...total, steps: [], method: WATERFALL_METHOD, paused: !B.auto };
  if (!leaves(A).length || !leaves(B).length) return { ...out, available: false, note: 'Both plans need at least one task or milestone to explain a finish-date change.' };
  const topo = topologyGroups(A, B), v = replayView(A, !!B.auto);
  if (!acyclic(v) || !acyclic(replayView(B, false))) return { ...out, available: false, note: 'The waterfall needs dependency graphs without cycles. Resolve the circular relationships to calculate contributions.' };
  const addStep = (spec) => {
    const before = replayView(v, false), from = finish(v);
    spec.apply(v); v.work = new WorkingCalendar(v.calendar); v.recalc();
    if (!acyclic(v)) return false;
    v.settle();
    const to = finish(v), ids = spec.ids || [];
    out.steps.push({ id: `wf${out.steps.length}`, type: spec.type, title: spec.title, items: spec.items, relationships: spec.relationships || [], reason: spec.reason, from, to, days: to - from, work: workDelta(B.work, from, to), driversBefore: ids.filter((id) => isDriver(before, id)).map((id) => nameOf(id, A, B)), driversAfter: ids.filter((id) => isDriver(v, id)).map((id) => nameOf(id, A, B)), paths: [...new Map([...pathsFrom(before, ids), ...pathsFrom(v, ids)].map((p) => [p.join(' → '), p])).values()] });
    return true;
  };
  // Establish a consistent baseline before edits: otherwise an unrelated calendar rename or
  // scope change could receive credit for merely enabling Auto on previously frozen dates.
  const aligned = replayView(v, !!B.auto); aligned.settle();
  if (aligned.tasks.some((t) => t.start !== v.byId.get(t.id).start)) {
    const resumed = !A.auto && B.auto;
    addStep({ type: resumed ? 'scheduling' : 'residual', title: resumed ? 'Auto-schedule resumed' : 'Baseline dates require scheduling alignment', items: aligned.tasks.filter((t) => t.start !== v.byId.get(t.id).start).map((t) => ({ id: t.id, name: t.name, before: fmtDay(v.byId.get(t.id).start), after: fmtDay(t.start) })), reason: resumed ? 'Enabling Auto recalculates linked Auto tasks before the other revisions are applied.' : 'The saved baseline dates do not reproduce under its scheduling rules. This alignment is kept separate from task revisions rather than assigned to an unrelated edit.', apply() {} });
  }
  if (JSON.stringify(A.calendar) !== JSON.stringify(B.calendar)) addStep({ type: 'calendar', title: 'Project working calendar', items: [{ name: 'Working weekdays and holidays', before: calendarLabel(A.calendar), after: calendarLabel(B.calendar) }, ...calendarItems(A.calendar, B.calendar)], reason: 'The compared calendar is applied to the baseline schedule, including its working weekdays and holidays.', apply(view) { view.calendar = clone(B.calendar); for (const t of view.tasks) if (!t.calendar) t.start = new WorkingCalendar(view.calendar).next(t.start); } });
  const revisedCalendars = [...topo.b].filter(([id, t]) => topo.a.has(id) && JSON.stringify(topo.a.get(id).calendar) !== JSON.stringify(t.calendar));
  if (revisedCalendars.length) addStep({
    type: 'calendar', title: 'Task working calendars', ids: revisedCalendars.map(([id]) => id),
    items: revisedCalendars.map(([id, t]) => ({ id, name: t.name, before: topo.a.get(id).calendar ? calendarLabel(topo.a.get(id).calendar) : 'Global calendar', after: t.calendar ? calendarLabel(t.calendar) : 'Global calendar', details: calendarItems(topo.a.get(id).calendar || A.calendar, t.calendar || B.calendar) })).flatMap(({ details, ...item }) => [item, ...details.map((d) => ({ ...d, name: `${item.name} · ${d.name}` }))]),
    reason: 'Task calendars replace the global weekdays and holidays. Starts on days off move forward; durations stay fixed and Auto successors recalculate using their own calendars.',
    apply(view) {
      for (const [id, t] of revisedCalendars) {
        const task = view.byId.get(id);
        if (t.calendar) task.calendar = clone(t.calendar); else delete task.calendar;
        task.start = new WorkingCalendar(task.calendar || view.calendar).next(task.start);
      }
    },
  });
  // Validate intermediate topology before replay. If components would create a temporary cycle,
  // merge the transition rather than use a partial/invalid schedule to claim an effect.
  let groups = topo.groups;
  const trial = replayView(v, false);
  for (const g of groups) { structuralStep(g, topo, A, B).apply(trial); trial.recalc(); if (!acyclic(trial)) { groups = [{ nodes: groups.flatMap((s) => s.nodes), edges: groups.flatMap((s) => s.edges) }]; break; } }
  for (const g of groups) addStep(structuralStep(g, topo, A, B));
  for (const step of revisionSteps(B, topo)) addStep(step);
  const from = finish(v);
  if (from !== compared) {
    const items = leaves(B).filter((t) => { const old = v.byId.get(t.id); return !old || old.start !== t.start || v.finish(old) !== B.finish(t); }).map((t) => ({ id: t.id, name: t.name, before: v.byId.has(t.id) ? fmtDay(v.finish(v.byId.get(t.id)) - (t.ms ? 0 : 1)) : 'Absent', after: fmtDay(B.finish(t) - (t.ms ? 0 : 1)) }));
    out.steps.push({ id: `wf${out.steps.length}`, type: 'residual', title: 'Saved dates not reproduced by replay', items, relationships: [], reason: 'These snapshots contain a finish difference that the scheduling inputs above do not reproduce. This may include paused Auto dates, retained date anchors or inconsistent saved dependencies; it is not attributed to a task as a proven cause.', from, to: compared, days: compared - from, work: workDelta(B.work, from, compared), driversBefore: [], driversAfter: [], paths: [] });
  }
  out.note = !B.auto ? 'Auto-schedule is paused in the compared plan. Replay uses saved dates and does not propagate dependency changes.' : 'Project completion is used regardless of the sheet’s selected critical-path target. Completed activities remain eligible to explain finish movement.';
  return out;
}

export function calendarLabel(calendar) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${calendar.workdays.map((d) => days[d]).join(', ')}; ${calendar.holidays.length} holiday${calendar.holidays.length === 1 ? '' : 's'}`;
}

function calendarItems(a, b) {
  const ha = new Map(a.holidays.map((h) => [h.date, h.name])), hb = new Map(b.holidays.map((h) => [h.date, h.name]));
  return [...new Set([...ha.keys(), ...hb.keys()])].filter((date) => ha.get(date) !== hb.get(date)).map((date) => ({ name: `${date} · ${hb.get(date) ?? ha.get(date)}`, before: ha.has(date) ? `Holiday: ${ha.get(date)}` : 'No holiday', after: hb.has(date) ? `Holiday: ${hb.get(date)}` : 'No holiday' }));
}
