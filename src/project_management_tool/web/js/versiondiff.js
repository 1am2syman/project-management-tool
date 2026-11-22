// Version analysis: compares two computed project views (a saved version and another version
// or the live plan). Pure data, no DOM, so every figure can be tested independently of the UI.
// Tasks and relationships are matched by their stable IDs; a task pair has at most one relationship.

const calendarText = (calendar) => calendar ? `${calendar.workdays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}; ${calendar.holidays.length ? calendar.holidays.map((h) => `${h.date}${h.name ? ' · ' + h.name : ''}`).join('; ') : 'no holidays'}` : 'Global calendar';

const SCHEDULE = { auto: 'Auto', manual: 'Manual', anchor: 'Date anchor', summary: 'Summary' };

// Signed working days between two finish days, counted in the compared view's calendar.
export function workDelta(work, a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return 0;
  return b > a ? work.count(a + 1, b + 1) : -work.count(b + 1, a + 1);
}

// Per-task facts with dates as shown in the sheet: inclusive finish, working-day duration.
export function facts(view) {
  const out = new Map(), stack = [];
  view.tasks.forEach((t, order) => {
    const f = view.info.get(t.id);
    while (stack.length && stack.at(-1).level >= t.level) stack.pop();
    const ms = !!t.ms && !f.summary;
    out.set(t.id, {
      id: t.id, name: t.name, level: t.level, order, parent: stack.at(-1)?.id ?? null, summary: f.summary, ms,
      start: f.start, finish: ms ? f.start : f.end - 1, end: f.end, dur: view.duration(t.id), progress: Math.round(f.progress),
      calendar: f.summary ? null : t.calendar || null, owner: t.owner || '', email: t.email || '', scheduling: f.summary ? 'summary' : t.scheduling || 'auto',
      actualStart: f.summary ? null : t.actualStart ?? null, actualEnd: f.summary || ms ? null : t.actualEnd ?? null, notes: t.notes || '',
      critical: !f.summary && !!f.critical, float: f.summary ? null : f.float,
    });
    stack.push(t);
  });
  return out;
}

export function metrics(view) {
  const leaves = view.tasks.filter((t) => !view.info.get(t.id).summary);
  let weight = 0, done = 0;
  for (const t of leaves) { const w = Math.max(t.dur, 0.0001); weight += w; done += w * t.progress; }
  const P = view.project, target = view.criticalTarget();
  return {
    start: P.start, finish: P.end - 1, end: P.end, calendarDays: P.end - P.start, workDays: view.work.count(P.start, P.end),
    tasks: leaves.filter((t) => !t.ms).length, milestones: leaves.filter((t) => t.ms).length, rows: view.tasks.length,
    links: view.links.length, progress: weight ? Math.round(done / weight) : 0, critical: view.critCount,
    criticalMethod: view.criticalLabel(), violated: view.links.filter((l) => l.violated).length, target: target ? target.name : null,
  };
}

const pairKey = (l) => `${l.from}>${l.to}`;
const lagText = (lag) => (lag ? `${lag > 0 ? '+' : ''}${lag}d` : '');
export const linkText = (l, names) => `${names(l.from)} → ${names(l.to)} (${l.type}${lagText(l.lag)})`;

function taskChanges(a, b) {
  const out = [];
  const add = (field, label, before, after, kind = 'text', extra = {}) => out.push({ field, label, before, after, kind, ...extra });
  if (a.name !== b.name) add('name', 'Renamed', a.name, b.name);
  if (a.parent !== b.parent || a.level !== b.level) add('parent', 'Moved in hierarchy', a.parent, b.parent, 'parent');
  if (a.ms !== b.ms && !a.summary && !b.summary) add('kind', 'Converted', a.ms ? 'Milestone' : 'Task', b.ms ? 'Milestone' : 'Task');
  if (a.summary !== b.summary) add('kind', 'Structure', a.summary ? 'Summary' : 'Task', b.summary ? 'Summary' : 'Task');
  // A summary's dates and progress roll up from its tasks; those changes are listed on the tasks themselves.
  if (a.summary && b.summary) return finishTaskChanges(a, b, add, out);
  if (JSON.stringify(a.calendar) !== JSON.stringify(b.calendar)) add('calendar', 'Task calendar', calendarText(a.calendar), calendarText(b.calendar));
  if (a.start !== b.start) add('start', 'Start moved', a.start, b.start, 'date', { delta: b.start - a.start });
  if (a.finish !== b.finish && !b.ms) add('finish', 'Finish moved', a.finish, b.finish, 'date', { delta: b.finish - a.finish });
  if (a.dur !== b.dur && !a.ms && !b.ms) add('dur', 'Duration changed', a.dur, b.dur, 'days', { delta: b.dur - a.dur });
  if (a.progress !== b.progress) add('progress', 'Progress', a.progress, b.progress, 'percent', { delta: b.progress - a.progress });
  if (a.actualStart !== b.actualStart) add('actualStart', 'Actual start', a.actualStart, b.actualStart, 'date');
  if (a.actualEnd !== b.actualEnd) add('actualEnd', 'Actual finish', a.actualEnd, b.actualEnd, 'date');
  return finishTaskChanges(a, b, add, out);
}

function finishTaskChanges(a, b, add, out) {
  if (a.owner !== b.owner || a.email !== b.email) add('owner', 'Owner changed', a.owner || 'Unassigned', b.owner || 'Unassigned');
  if (a.scheduling !== b.scheduling && a.scheduling !== 'summary' && b.scheduling !== 'summary') add('scheduling', 'Scheduling mode', SCHEDULE[a.scheduling], SCHEDULE[b.scheduling]);
  if (a.notes !== b.notes) add('notes', 'Notes updated', a.notes || 'None', b.notes || 'None');
  return out;
}

function calendarChanges(A, B) {
  const a = A.calendar, b = B.calendar, out = [];
  if (a.workdays.join() !== b.workdays.join()) out.push({ kind: 'changed', label: 'Working weekdays changed', before: a.workdays, after: b.workdays, field: 'workdays' });
  const ha = new Map(a.holidays.map((h) => [h.date, h.name])), hb = new Map(b.holidays.map((h) => [h.date, h.name]));
  for (const [date, name] of hb) if (!ha.has(date)) out.push({ kind: 'added', label: 'Holiday added', date, name, field: 'holiday' });
  for (const [date, name] of ha) if (!hb.has(date)) out.push({ kind: 'removed', label: 'Holiday removed', date, name, field: 'holiday' });
  for (const [date, name] of hb) if (ha.has(date) && ha.get(date) !== name) out.push({ kind: 'changed', label: 'Holiday renamed', date, before: ha.get(date), after: name, field: 'holiday' });
  return out;
}

// Most likely reasons a task finishes later, from the compared plan's own relationships.
function slipCauses(row, B, fa, fb, linksA, calendarChanged) {
  const causes = [], a = row.a, b = row.b, name = (id) => fb.get(id)?.name ?? fa.get(id)?.name ?? `#${id}`;
  if (b.dur > a.dur) causes.push(`Duration +${b.dur - a.dur} working day${b.dur - a.dur === 1 ? '' : 's'}`);
  if (b.scheduling === 'manual' && a.scheduling !== 'manual') causes.push('Switched to manual dates');
  else if (b.scheduling === 'manual' && b.start !== a.start) causes.push('Manual date change');
  if (b.scheduling !== 'manual') {
    for (const l of B.incoming(b.id)) {
      const before = linksA.get(pairKey(l)), pa = fa.get(l.from), pb = fb.get(l.from);
      if (!before) { causes.push(`New dependency on “${name(l.from)}”`); continue; }
      if (l.lag > before.lag) causes.push(`Lag after “${name(l.from)}” +${l.lag - before.lag}d`);
      if (l.type !== before.type) causes.push(`Dependency on “${name(l.from)}” changed to ${l.type}`);
      const driving = l.slack <= 0, endpoint = l.type[0] === 'F' ? 'finish' : 'start';
      const moved = pa && pb ? pb[endpoint] - pa[endpoint] : 0;
      if (driving && moved > 0) {
        const days = workDelta(B.workFor(b.id), pa[endpoint], pb[endpoint]);
        const delay = days ? `${days}d` : `${moved} calendar day${moved === 1 ? '' : 's'}`;
        causes.push(`Predecessor “${name(l.from)}” slipped ${delay}`);
      }
    }
  }
  if (JSON.stringify(a.calendar) !== JSON.stringify(b.calendar)) causes.push('Task calendar change');
  if (!causes.length && calendarChanged && !b.calendar) causes.push('Calendar change');
  if (!causes.length && b.start !== a.start) causes.push(`Start moved ${b.start - a.start} day${Math.abs(b.start - a.start) === 1 ? '' : 's'}`);
  return causes.slice(0, 3);
}

// Removed tasks appear after the nearest preceding task that still exists.
function comparisonRows(fa, fb, rowsById) {
  const after = new Map(), order = [...fa.values()].sort((x, y) => x.order - y.order);
  let anchor = null;
  for (const t of order) {
    if (fb.has(t.id)) { anchor = t.id; continue; }
    if (!after.has(anchor)) after.set(anchor, []);
    after.get(anchor).push(rowsById.get(t.id));
  }
  const out = [...(after.get(null) || [])];
  for (const t of [...fb.values()].sort((x, y) => x.order - y.order)) out.push(rowsById.get(t.id), ...(after.get(t.id) || []));
  return out;
}

export function compareViews(A, B) {
  const fa = facts(A), fb = facts(B), ma = metrics(A), mb = metrics(B);
  const nameOf = (id) => fb.get(id)?.name ?? fa.get(id)?.name ?? `#${id}`;
  const rowsById = new Map(), tasks = [];
  for (const id of new Set([...fa.keys(), ...fb.keys()])) {
    const a = fa.get(id) || null, b = fb.get(id) || null;
    const row = { id, name: (b || a).name, a, b, status: !a ? 'added' : !b ? 'removed' : 'same', changes: [] };
    if (a && b) {
      row.changes = taskChanges(a, b);
      row.status = row.changes.length ? 'changed' : 'same';
      row.startDelta = b.start - a.start; row.finishDelta = b.finish - a.finish;
      row.finishDeltaWork = workDelta(B.workFor(id), a.finish, b.finish); row.durDelta = b.dur - a.dur;
    }
    rowsById.set(id, row); tasks.push(row);
  }
  const linksA = new Map(A.links.map((l) => [pairKey(l), l])), linksB = new Map(B.links.map((l) => [pairKey(l), l]));
  const links = { added: [], removed: [], changed: [] };
  for (const [key, l] of linksB) {
    const before = linksA.get(key);
    if (!before) links.added.push(l);
    else if (before.type !== l.type || before.lag !== l.lag) links.changed.push({ a: before, b: l });
  }
  for (const [key, l] of linksA) if (!linksB.has(key)) links.removed.push(l);
  const calendar = calendarChanges(A, B);

  const milestones = [];
  for (const row of tasks) {
    const a = row.a?.ms ? row.a : null, b = row.b?.ms ? row.b : null;
    if (!a && !b) continue;
    const delta = a && b ? workDelta(B.workFor(row.id), a.start, b.start) : null;
    const status = !a ? 'new' : !b ? 'removed' : delta > 0 ? 'slipped' : delta < 0 ? 'early' : 'on time';
    milestones.push({ id: row.id, name: row.name, a: a?.start ?? null, b: b?.start ?? null, delta, days: a && b ? b.start - a.start : null, status, done: (b || a).progress >= 100, order: (b || a).order });
  }
  milestones.sort((x, y) => (x.b ?? x.a) - (y.b ?? y.a) || x.order - y.order);

  const leaves = tasks.filter((r) => r.a && r.b && !r.a.summary && !r.b.summary);
  const slips = leaves.filter((r) => r.finishDelta > 0)
    .sort((x, y) => y.finishDeltaWork - x.finishDeltaWork || y.finishDelta - x.finishDelta || x.b.order - y.b.order)
    .map((r) => ({ id: r.id, name: r.name, owner: r.b.owner, a: r.a.finish, b: r.b.finish, days: r.finishDelta, work: r.finishDeltaWork, causes: slipCauses(r, B, fa, fb, linksA, calendar.length > 0) }));
  const earlier = leaves.filter((r) => r.finishDelta < 0).length;

  const critical = {
    became: tasks.filter((r) => r.b?.critical && !r.a?.critical).map((r) => ({ id: r.id, name: r.name, added: !r.a })),
    left: tasks.filter((r) => r.a?.critical && !r.b?.critical).map((r) => ({ id: r.id, name: r.name, removed: !r.b })),
    slack: leaves.filter((r) => r.a.float != null && r.b.float != null && r.a.float !== r.b.float)
      .map((r) => ({ id: r.id, name: r.name, a: r.a.float, b: r.b.float, delta: r.b.float - r.a.float }))
      .sort((x, y) => x.delta - y.delta || x.name.localeCompare(y.name)),
  };

  const owners = new Map();
  const ownerRow = (name) => { const key = name || 'Unassigned'; if (!owners.has(key)) owners.set(key, { owner: key, tasks: 0, slipped: 0, earlier: 0, added: 0, removed: 0, workDelta: 0, maxSlip: 0 }); return owners.get(key); };
  for (const r of tasks) {
    const f = r.b || r.a; if (f.summary) continue;
    const o = ownerRow(f.owner);
    if (r.b) o.tasks++;
    if (r.status === 'added') { o.added++; o.workDelta += r.b.dur; continue; }
    if (r.status === 'removed') { o.removed++; o.workDelta -= r.a.dur; continue; }
    if (r.a.summary) continue;
    o.workDelta += r.durDelta;
    if (r.finishDelta > 0) { o.slipped++; o.maxSlip = Math.max(o.maxSlip, r.finishDeltaWork); }
    else if (r.finishDelta < 0) o.earlier++;
  }

  const changed = tasks.filter((r) => r.status !== 'same');
  return {
    a: ma, b: mb, tasks, rows: comparisonRows(fa, fb, rowsById), nameOf,
    finish: { days: mb.finish - ma.finish, work: workDelta(B.work, ma.finish, mb.finish) },
    start: { days: mb.start - ma.start },
    links, calendar, milestones, slips, earlier, critical,
    owners: [...owners.values()].sort((x, y) => y.slipped - x.slipped || y.maxSlip - x.maxSlip || x.owner.localeCompare(y.owner)),
    counts: { added: changed.filter((r) => r.status === 'added').length, removed: changed.filter((r) => r.status === 'removed').length, changed: changed.filter((r) => r.status === 'changed').length, links: links.added.length + links.removed.length + links.changed.length, calendar: calendar.length + tasks.reduce((n, r) => n + r.changes.filter((c) => c.field === 'calendar').length, 0) },
  };
}

// Forecast finish and milestone dates across a chronological series of views.
export function trends(points) {
  const finish = points.map((p) => metrics(p.view).finish), series = new Map();
  points.forEach((p, i) => {
    for (const t of p.view.tasks) {
      if (!t.ms || p.view.info.get(t.id).summary) continue;
      if (!series.has(t.id)) series.set(t.id, { id: t.id, name: t.name, dates: Array(points.length).fill(null) });
      const s = series.get(t.id); s.name = t.name; s.dates[i] = t.start;
    }
  });
  return { labels: points.map((p) => p.label), at: points.map((p) => p.at), finish, milestones: [...series.values()] };
}

const DAY_MS = 86400000;
export const fmtDay = (d) => (d == null || !Number.isFinite(d) ? '—' : new Date(d * DAY_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }));
export const signed = (n, unit = 'd') => (n > 0 ? `+${n}${unit}` : n < 0 ? `-${-n}${unit}` : `0${unit}`);

// One flat, readable row per change, shared by the overlay and the exports.
export function changeLog(d) {
  const rows = [], span = (f) => (f.ms ? fmtDay(f.start) : `${fmtDay(f.start)} – ${fmtDay(f.finish)} · ${f.dur}d`);
  const value = (c, v) => (c.kind === 'date' ? fmtDay(v) : c.kind === 'days' ? `${v}d` : c.kind === 'percent' ? `${v}%` : c.kind === 'parent' ? (v == null ? 'Top level' : d.nameOf(v)) : String(v));
  for (const r of d.tasks) {
    if (r.status === 'added') rows.push({ area: 'Task', kind: 'added', id: r.id, item: r.name, change: r.b.ms ? 'Milestone added' : r.b.summary ? 'Summary added' : 'Task added', before: '', after: span(r.b) });
    else if (r.status === 'removed') rows.push({ area: 'Task', kind: 'removed', id: r.id, item: r.name, change: r.a.ms ? 'Milestone removed' : r.a.summary ? 'Summary removed' : 'Task removed', before: span(r.a), after: '' });
    else for (const c of r.changes) rows.push({ area: 'Task', kind: 'changed', id: r.id, field: c.field, item: r.name, change: c.delta != null ? `${c.label} ${signed(c.delta, c.kind === 'percent' ? ' pts' : 'd')}` : c.label, before: value(c, c.before), after: value(c, c.after) });
  }
  const link = (l) => `${d.nameOf(l.from)} → ${d.nameOf(l.to)}`, kind = (l) => `${l.type}${l.lag ? ` ${signed(l.lag)}` : ''}`;
  for (const l of d.links.added) rows.push({ area: 'Relationship', kind: 'added', item: link(l), change: 'Relationship added', before: '', after: kind(l) });
  for (const l of d.links.removed) rows.push({ area: 'Relationship', kind: 'removed', item: link(l), change: 'Relationship removed', before: kind(l), after: '' });
  for (const { a, b } of d.links.changed) rows.push({ area: 'Relationship', kind: 'changed', item: link(b), change: a.type !== b.type ? 'Type changed' : 'Lag changed', before: kind(a), after: kind(b) });
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], week = (w) => w.map((n) => DAYS[n]).join(', ');
  for (const c of d.calendar) {
    if (c.field === 'workdays') rows.push({ area: 'Calendar', kind: 'changed', item: 'Working weekdays', change: c.label, before: week(c.before), after: week(c.after) });
    else rows.push({ area: 'Calendar', kind: c.kind, item: `${c.date}${c.name ? ` · ${c.name}` : ''}`, change: c.label, before: c.kind === 'changed' ? c.before : c.kind === 'removed' ? 'Holiday' : '', after: c.kind === 'changed' ? c.after : c.kind === 'added' ? 'Holiday' : '' });
  }
  return rows;
}

// Change-log filters; every row belongs to exactly one.
export const CHANGE_FILTERS = [
  ['added', 'Added'], ['removed', 'Removed'], ['dates', 'Dates'], ['duration', 'Duration'], ['progress', 'Progress'],
  ['owner', 'Owner'], ['structure', 'Structure'], ['scheduling', 'Scheduling'], ['links', 'Relationships'], ['calendar', 'Calendar'],
];
export function changeCategory(row) {
  if (row.area === 'Relationship') return 'links';
  if (row.area === 'Calendar') return 'calendar';
  if (row.kind === 'added' || row.kind === 'removed') return row.kind;
  return { start: 'dates', finish: 'dates', dur: 'duration', progress: 'progress', owner: 'owner', scheduling: 'scheduling', calendar: 'calendar' }[row.field] || 'structure';
}

export const MILESTONE_STATUS = { slipped: 'Slipped', early: 'Early', 'on time': 'On time', new: 'New', removed: 'Removed' };
const plural = (n, word) => `${n} ${word}${Math.abs(n) === 1 ? '' : 's'}`;

// Headline figures: value in the compared plan, the baseline value, and whether the change is good news.
export function summaryCards(d) {
  const a = d.a, b = d.b;
  const tone = (n, worse = 1) => (!n || !worse ? 'same' : n * worse > 0 ? 'bad' : 'good');
  const delta = (n, unit = '') => (n ? signed(n, unit) : 'No change');
  const dur = b.workDays - a.workDays, progress = b.progress - a.progress, total = changeLog(d).length;
  return [
    { key: 'finish', label: 'Finish', value: fmtDay(b.finish), before: fmtDay(a.finish), delta: d.finish.work ? `${signed(d.finish.work, '')} working day${Math.abs(d.finish.work) === 1 ? '' : 's'}` : d.finish.days ? 'Same working day' : 'No change', sub: d.finish.days ? `${signed(d.finish.days, '')} calendar day${Math.abs(d.finish.days) === 1 ? '' : 's'}` : '', tone: tone(d.finish.days) },
    { key: 'start', label: 'Start', value: fmtDay(b.start), before: fmtDay(a.start), delta: delta(d.start.days), sub: '', tone: tone(d.start.days, 0) },
    { key: 'duration', label: 'Duration', value: plural(b.workDays, 'working day'), before: plural(a.workDays, 'working day'), delta: delta(dur), sub: `${b.calendarDays} calendar days`, tone: tone(dur) },
    { key: 'tasks', label: 'Tasks', value: String(b.tasks), before: String(a.tasks), delta: delta(b.tasks - a.tasks), sub: `${plural(d.counts.added, 'row')} added · ${d.counts.removed} removed`, tone: 'same' },
    { key: 'milestones', label: 'Milestones', value: String(b.milestones), before: String(a.milestones), delta: delta(b.milestones - a.milestones), sub: `${d.milestones.filter((m) => m.status === 'slipped').length} slipped`, tone: 'same' },
    { key: 'progress', label: 'Complete', value: `${b.progress}%`, before: `${a.progress}%`, delta: delta(progress, ' pts'), sub: 'Duration-weighted', tone: tone(progress, -1) },
    { key: 'critical', label: 'Critical tasks', value: String(b.critical), before: String(a.critical), delta: delta(b.critical - a.critical), sub: b.target ? `To ${b.target}` : 'To project completion', tone: 'same' },
    { key: 'violated', label: 'Violated links', value: String(b.violated), before: String(a.violated), delta: delta(b.violated - a.violated), sub: `${b.links} relationships`, tone: tone(b.violated - a.violated) },
    { key: 'changes', label: 'Changes', value: String(total), before: '', delta: plural(d.counts.changed, 'task') + ' changed', sub: `${plural(d.counts.links, 'relationship')} · ${plural(d.counts.calendar, 'calendar change')}`, tone: 'same' },
  ];
}
