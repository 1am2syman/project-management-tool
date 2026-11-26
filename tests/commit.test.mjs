import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import * as DL from '../src/project_management_tool/web/js/delays.js';

beforeEach(() => {
  globalThis.localStorage = { getItem() { throw new Error('Production read browser storage'); }, setItem() { throw new Error('Production wrote browser storage'); } };
  appState.restore({}, { disk: true });
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const task = (id, name, start = 20000) => ({ id, name, start, dur: 5, level: 0, ms: false, scheduling: 'auto', progress: 0 });
  const data = { calendar: { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] }, tasks: [task(1, 'First'), task(2, 'Second', 20005)], links: [], nextId: 3, nextLink: 1, collapsed: [] };
  return new Store({ workbook: { active: 's1', nextSheet: 3, sheets: [{ id: 's1', name: 'One', data }, { id: 's2', name: 'Unrelated', data: structuredClone(data), versions: [{ n: 1, data: JSON.stringify(data) }] }] }, templates: [], preferences: {}, history: { s2: { u: [JSON.stringify(data)], r: [] } } }, { disk: true });
}
function transport(store, wait = null) {
  const calls = [];
  store.enableCommits(async (candidate, base) => { calls.push({ candidate, base }); if (wait) await wait.promise; return { revision: String(calls.length) }; });
  return calls;
}
function hook(store, decide) { store.hook = { forDraft: draft => DL.createDelayHook(draft, decide) }; }

test('explicit default never reads legacy bytes; static commands stay synchronous', () => {
  const s = new Store(null, { disk: true });
  assert(s.tasks.length);
  const f = fixture(); assert.equal(f.setCell(1, 'name', 'Static'), null); assert.equal(f.byId.get(1).name, 'Static');
});

test('acknowledgement precedes adoption, history and observers; unrelated components are shared', async () => {
  const s = fixture(), wait = deferred(), calls = transport(s, wait), events = [];
  const base = s.savedState(), original = s.byId.get(1);
  s.on(kind => { if (!['pending', 'idle', 'suspended'].includes(kind)) events.push({ kind, name: s.byId.get(1).name, pending: s.pending }); });
  const action = s.updateTask(1, { name: 'Accepted', dur: 8 }); await tick();
  assert(s.pending); assert.equal(s.byId.get(1), original); assert.equal(original.name, 'First'); assert.equal(s.undoStack.length, 0); assert.equal(events.length, 0);
  const { candidate } = calls[0];
  assert.equal(candidate.workbook.sheets[1].data, base.workbook.sheets[1].data);
  assert.equal(candidate.workbook.sheets[1].versions, base.workbook.sheets[1].versions);
  assert.equal(candidate.history.s2, base.history.s2);
  assert(Object.isFrozen(candidate.workbook.sheets[0].data.tasks[0]));
  await assert.rejects(s.setOwner(1, 'Too early', ''), /pending/);
  wait.resolve(); assert.equal(await action, null);
  assert.equal(s.byId.get(1).name, 'Accepted'); assert.equal(s.undoStack.length, 1);
  assert(events.length); assert(events.every(e => e.name === 'Accepted' && !e.pending));
});

test('storage failures preserve committed objects and immutable attempted data; retry adopts only exact result', async () => {
  const s = fixture(), failure = new Error('lost response'), events = [];
  s.enableCommits(async () => { throw failure; }); s.on(k => { if (!['pending', 'idle', 'suspended'].includes(k)) events.push(k); });
  const base = s.savedState(), original = s.tasks;
  await assert.rejects(s.setCell(1, 'name', 'Unconfirmed'), failure);
  assert.equal(s.tasks, original); assert.equal(s.savedState(), base); assert.equal(events.length, 0); assert(s.suspended);
  const attempted = s.pendingCandidate;
  assert.equal(attempted.workbook.sheets[0].data.tasks[0].name, 'Unconfirmed'); assert(Object.isFrozen(attempted));
  await assert.rejects(s.newBlank(), failure); await assert.rejects(s.whenIdle(), failure);
  assert.throws(() => s.adoptPending(base), /exact/);
  s.adoptPending(structuredClone(attempted), { revision: 'new' });
  assert.equal(s.byId.get(1).name, 'Unconfirmed'); assert(!s.suspended); assert.equal(s.pendingCandidate, null); await s.whenIdle();
});

test('validation errors and thrown draft callbacks discard all staged changes without suspending', async () => {
  const s = fixture(); let fail = true;
  s.enableCommits(async () => { if (fail) throw Object.assign(new Error('invalid candidate'), { validation: true, status: 400 }); });
  await assert.rejects(s.setCell(1, 'name', 'Bad'), /invalid candidate/); assert(!s.suspended); assert.equal(s.pendingCandidate, null); assert.equal(s.byId.get(1).name, 'First');
  fail = false;
  await assert.rejects(s.commit(draft => { draft.setCell(1, 'name', 'Throw'); throw new Error('discard'); }), /discard/);
  assert.equal(s.byId.get(1).name, 'First'); await s.setCell(1, 'name', 'Corrected'); assert.equal(s.byId.get(1).name, 'Corrected');
});

test('definitive rejection reaches current waiters while subsequent idle barriers recover', async () => {
  const failures = [Object.assign(new Error('bad request'), { status: 400 }),
    Object.assign(new Error('invalid input'), { status: 422 }),
    Object.assign(new Error('too large'), { status: 413, validation: true }), new Error('draft callback failed')];
  for (const failure of failures) {
    const s = fixture(), wait = deferred(), callbackFailure = failure.status === undefined;
    s.enableCommits(async () => wait.promise);
    const action = callbackFailure ? s.commit(async draft => {
      draft.setCell(1, 'name', 'Rejected'); await wait.promise;
    }) : s.setCell(1, 'name', 'Rejected');
    const actionRejected = assert.rejects(action, failure);
    const idleRejected = assert.rejects(s.whenIdle(), failure);
    await tick(); wait.reject(failure);
    await Promise.all([actionRejected, idleRejected]);
    assert(!s.pending); assert(!s.suspended); assert.equal(s.pendingCandidate, null);
    assert.equal(s.byId.get(1).name, 'First');
    await s.whenIdle();
    // Clearing the coordinator's reference cannot change the original result.
    await assert.rejects(action, failure);
  }
});

test('accepted child insertion/move reveals its collapsed parent while later user folds stay local', async () => {
  const group = () => {
    const s = fixture(); s.tasks[1].level = 1; s.tasks.push({ ...s.tasks[0], id: 3, name: 'Other', start: 20010, level: 0 }); s.nextId = 4;
    s.sheet().data = JSON.parse(s.serialize()); return new Store(s.savedState(), { disk: true });
  };
  for (const command of [s => s.insertTask(1, false, 'child'), s => s.moveTask(3, 1, 'child')]) {
    const s = group(), wait = deferred(); transport(s, wait); s.toggle(1);
    assert(s.collapsed.has(1));
    const pending = command(s); await tick(); wait.resolve(); await pending;
    assert(!s.collapsed.has(1), 'command-requested reveal is adopted'); assert.deepEqual(s.savedState().workbook.sheets[0].data.collapsed, []);
    assert(s.rows.length >= 2);
  }
  const s = group(), wait = deferred(); transport(s, wait); s.toggle(1);
  const pending = s.insertTask(1, false, 'child'); await tick(); s.toggle(1);
  wait.resolve(); await pending;
  assert(!s.collapsed.has(1), 'second toggle reopens the group; its newer user choice is preserved, not overwritten');
});

test('loading accepted data never schedules unacknowledged dates; auto change acknowledges every project', async () => {
  const s = fixture(); s.addLink(1, 'f', 2, 's'); s.setPref('auto', false);
  s.byId.get(1).start = 20040; s.sheet().data = JSON.parse(s.serialize());
  const stored = new Store(s.savedState(), { disk: true }); stored.auto = false; const calls = transport(stored);
  const before = stored.byId.get(2).start;
  stored.switchSheet('s2'); stored.switchSheet('s1');
  assert.equal(stored.byId.get(2).start, before, 'navigation leaves accepted plan unscheduled');
  assert.equal(calls.length, 0); assert.equal(stored.savedState().workbook.sheets[0].data.tasks[1].start, before);
  const view = stored.view('s1'); assert.equal(view.byId.get(2).start, before);
  stored.auto = false; stored.switchSheet('s2'); await stored.setPref('auto', true);
  stored.switchSheet('s1');
  assert.equal(stored.byId.get(2).start, stored.savedState().workbook.sheets[0].data.tasks[1].start, 'visible schedule equals committed schedule');
});

test('compound commands resolve IDs on the draft and make one transaction and undo step', async () => {
  const s = fixture(), calls = transport(s);
  await s.commit(async draft => { const { id } = draft.insertTask(1); await Promise.resolve(); draft.updateTask(id, { name: 'Inserted', dur: 2 }); draft.setOwner(2, 'Owner', ''); });
  assert.equal(calls.length, 1); assert.equal(s.undoStack.length, 1); assert.equal(s.tasks[1].name, 'Inserted');
  await s.undo(); assert.deepEqual(s.tasks.map(t => t.name), ['First', 'Second']); assert.equal(s.redoStack.length, 1);
  await s.redo(); assert.equal(s.tasks[1].name, 'Inserted'); assert.equal(calls.length, 3);
  const live = s.byId.get(1);
  await assert.rejects(s.tx(() => { live.name = 'Captured live'; }), TypeError);
  assert.notEqual(s.byId.get(1).name, 'Captured live');
});

test('no-op commands and cosmetic navigation/folding and read operations do not write', async () => {
  const s = fixture(), calls = transport(s), base = s.savedState();
  s.snapshot(); s.livePlan(); s.view('s1'); s.unchangedSinceLatest();
  await s.setCell(1, 'name', 'First'); assert.equal(calls.length, 0);
  s.switchSheet('s2'); s.toggle(1); s.snapshot(); s.livePlan(); s.view('s1');
  assert.equal(calls.length, 0); assert.equal(s.savedState(), base); assert.equal(base.workbook.active, 's1');
  await s.setCell(1, 'name', 'Other sheet'); assert.equal(calls.length, 1); assert.equal(s.savedState().workbook.active, 's1');
  assert.equal(s.wb.active, 's2');
  await s.deleteSheet('s1'); assert.equal(s.savedState().workbook.active, 's2');
});

test('preferences, templates, projects and version metadata all wait for acknowledgement', async () => {
  const operations = [
    s => s.setPref('auto', false), s => s.setCriticalMode('off'), s => s.setRem({ on: true }),
    s => s.renameSheet('s1', 'Renamed'), s => s.moveSheet('s2', 0), s => s.newBlank(), s => s.duplicateSheet('s1'),
    s => s.saveTemplate('Template'), s => s.snapshotVersion({ name: 'Saved' }), s => s.deleteSheet('s2'),
    s => s.setKeyMilestone(1, true), s => s.setShare('s1', { driveId: 'd', itemId: 'i' }),
  ];
  for (const operation of operations) {
    const s = fixture(), wait = deferred(), calls = transport(s, wait), base = s.savedState();
    const pending = operation(s); assert(pending instanceof Promise); await tick();
    assert.equal(calls.length, 1, operation.toString()); assert.equal(s.savedState(), base);
    wait.resolve(); await pending; assert.notEqual(s.savedState(), base);
  }
});

test('named-version previews are isolated and never replace committed tasks', async () => {
  const s = fixture(), calls = transport(s);
  const { version } = await s.snapshotVersion({ name: 'Before' }); await s.setCell(1, 'name', 'Current');
  const live = s.tasks, count = calls.length;
  assert.equal(s.previewVersion(version.id), null); assert.equal(s.tasks, live); assert.equal(s.byId.get(1).name, 'Current');
  assert.equal(s.presentation.byId.get(1).name, 'First'); assert(s.presentation.readOnly);
  assert.equal(s.presentation.wb, s.wb); assert.equal(s.presentation.versions().length, 1);
  assert.equal(s.presentation.view(s.wb.active).byId.get(1).name, 'Current');
  assert.equal(s.presentation.versionView(version.id).byId.get(1).name, 'First');
  assert.equal(s.presentation.snapshot().data.tasks[0].name, 'Current'); assert.equal(s.presentation.undoStack, s.undoStack);
  assert.match(await s.setCell(1, 'name', 'Rejected'), /saved version/); assert.equal(calls.length, count);
  s.exitPreview(); assert.equal(s.presentation.byId.get(1).name, 'Current');
  await s.restoreVersion(version.id); assert.equal(s.byId.get(1).name, 'First'); await s.undo(); assert.equal(s.byId.get(1).name, 'Current');
});

test('drag frames affect only the preview; release commits once and cancellation writes nothing', async () => {
  const s = fixture(), calls = transport(s), original = s.byId.get(1).start;
  s.beginDrag(); s.dragApply(draft => draft.dragMove(1, 4));
  assert.equal(s.byId.get(1).start, original); assert.equal(s.presentation.byId.get(1).start, original + 4); assert.equal(calls.length, 0);
  await assert.rejects(s.setCell(1, 'name', 'Blocked'), /pending/);
  await s.endDrag(false); assert.equal(s.byId.get(1).start, original); assert.equal(calls.length, 0);
  s.beginDrag(); s.dragApply(draft => draft.dragMove(1, 2)); await s.endDrag();
  assert.equal(s.byId.get(1).start, original + 2); assert.equal(calls.length, 1); assert.equal(s.undoStack.length, 1);
});

test('draft app-state context suppresses side effects and isolates async continuation settings', async () => {
  const s = fixture(), wait = deferred(), calls = transport(s, wait);
  appState.adopt('pm-delay-causes', 'old');
  const pending = s.commit(async draft => { appState.setItem('pm-delay-causes', 'candidate'); await Promise.resolve(); draft.appState.setItem('pm-custom', 'after await'); draft.setCell(1, 'name', 'With settings'); });
  await tick(); assert.equal(appState.getItem('pm-delay-causes'), 'old');
  appState.setItem('pm-grid-scroll', 'new view');
  const candidate = calls[0].candidate;
  assert.equal(candidate.browser['pm-delay-causes'], 'candidate'); assert.equal(candidate.browser['pm-custom'], 'after await'); assert.equal(candidate.browser['pm-grid-scroll'], undefined);
  wait.resolve(); await pending;
  assert.equal(appState.getItem('pm-delay-causes'), 'candidate'); assert.equal(appState.getItem('pm-grid-scroll'), 'new view'); assert.equal(candidate.browser['pm-grid-scroll'], undefined);
});

test('delay Record and Skip stage origin and record together; Cancel discards both', async () => {
  for (const decision of [{ type: 'delay', cause: 'c1' }, { type: 'delay', cause: null }, null]) {
    const s = fixture(); DL.agreeBaseline(s); const baseline = s.snap(), wait = deferred(), calls = transport(s);
    hook(s, (_option, draft) => { assert.notEqual(draft, s); assert.equal(draft.byId.get(1).dur, 8); assert.equal(s.byId.get(1).dur, 5); return wait.promise; });
    const pending = s.setCell(1, 'dur', '8'); await tick(); assert.equal(calls.length, 0); assert(s.pending);
    wait.resolve(decision); const result = await pending;
    if (!decision) { assert.deepEqual(result, { cancelled: true }); assert.equal(s.snap(), baseline); assert.equal(calls.length, 0); }
    else { assert.equal(calls.length, 1); assert.equal(s.byId.get(1).dur, 8); assert.equal(s.log.at(-1).cause, decision.cause); await s.undo(); assert.equal(s.snap(), baseline); }
  }
});

test('deterministic delay recovery amends inside its candidate before transport', async () => {
  const s = fixture(); DL.agreeBaseline(s); const calls = transport(s); hook(s);
  await s.setCell(1, 'dur', '3');
  assert.equal(calls.length, 1); assert.equal(calls[0].candidate.workbook.sheets[0].data.log.at(-1).days, -2);
  assert.equal(s.undoStack.length, 2); await s.undo(); assert.equal(s.byId.get(1).dur, 5); assert.equal(s.log.length, 0);
});

test('baseline/version agreement, restoration and overdue edit plus reason are atomic', async () => {
  const s = fixture(), calls = transport(s);
  await s.snapshotAgreed(draft => DL.agreeBaseline(draft), { type: 'baseline' });
  assert.equal(calls.length, 1); assert(s.baselined); assert.equal(s.undoStack.length, 0); assert.equal(s.versions().length, 1);
  await s.commit(draft => { const pre = DL.snapshotBefore(draft); draft.applyCell(1, 'dur', '9'); return DL.record(draft, 1, pre, { type: 'delay', cause: 'c1' }); });
  assert.equal(calls.length, 2); assert.equal(s.undoStack.length, 1); await s.undo(); assert.equal(s.byId.get(1).dur, 5); assert.equal(s.log.length, 0);
});

test('locked production tabs reject every direct boundary; incompatible live hooks fail safely', async () => {
  const s = fixture(), calls = transport(s); s.locked = true;
  assert(s.readOnly); await assert.rejects(s.newBlank(), /read-only/); await assert.rejects(s.commit(d => d.setPref('auto', false)), /read-only/); assert.equal(calls.length, 0);
  s.locked = false; s.hook = { before() { throw new Error('live hook ran'); } };
  await assert.rejects(s.setCell(1, 'name', 'Unsafe'), /forDraft/); assert.equal(calls.length, 0); assert(!s.pending); assert(!s.suspended);
});

test('fault matrix covers task/link/calendar/structure/version/template/history/project entrypoints', async () => {
  const cases = [
    ['cell', s => s.setCell(1, 'name', 'Changed')],
    ['task dialog', s => s.updateTask(1, { owner: 'New', dur: 6 })],
    ['link add', s => s.addLink(1, 'f', 2, 's')],
    ['link update', s => s.updateLink('l1', { lag: 3 }), s => s.addLink(1, 'f', 2, 's')],
    ['link remove', s => s.removeLink('l1'), s => s.addLink(1, 'f', 2, 's')],
    ['calendar', s => s.setCalendar({ workdays: [1, 2, 3, 4], holidays: [] })],
    ['scheduling', s => s.setScheduling(1, 'manual')],
    ['kind', s => s.setTaskKind(1, true)],
    ['insert', s => s.insertTask(1)], ['delete', s => s.deleteTask(1)], ['move', s => s.moveTask(2, 1, 'before')],
    ['indent', s => s.indent(2, 1)], ['star', s => s.setKeyMilestone(1, true)],
    ['version snapshot', s => s.snapshotVersion()],
    ['version metadata', s => s.updateVersion('v1', { name: 'Changed' }), s => s.snapshotVersion()],
    ['version delete', s => s.deleteVersion('v1'), s => s.snapshotVersion()],
    ['version restore', s => s.restoreVersion('v1'), s => { s.snapshotVersion(); s.setCell(1, 'name', 'Later'); }],
    ['copy version', s => s.copyVersionAsProject('v1'), s => s.snapshotVersion()],
    ['agreed version', s => s.snapshotAgreed(d => DL.agreeBaseline(d), { type: 'baseline' })],
    ['template save', s => s.saveTemplate('Named')],
    ['template delete', s => s.deleteTemplate(s.templates[0].id), s => s.saveTemplate('Named')],
    ['template instantiate', s => s.instantiate(s.allTemplates()[0], 20000, 'Instantiated')],
    ['preferences', s => s.setPref('auto', false)], ['critical preference', s => s.setCriticalMode('off')],
    ['undo', s => s.undo(), s => s.setCell(1, 'name', 'Before undo')],
    ['redo', s => s.redo(), s => { s.setCell(1, 'name', 'Before undo'); s.undo(); }],
    ['new project', s => s.newBlank()], ['delete project', s => s.deleteSheet('s1')],
    ['rename project', s => s.renameSheet('s1', 'Changed')], ['reorder projects', s => s.moveSheet('s2', 0)],
    ['duplicate project', s => s.duplicateSheet('s1')], ['reset workspace', s => s.resetAll()],
    ['agreed date', s => DL.setAgreed(s, 1, 20004)], ['baseline', s => DL.agreeBaseline(s)],
  ];
  for (const [name, command, setup] of cases) {
    const s = fixture(); setup?.(s); const calls = [];
    s.enableCommits(async candidate => { calls.push(candidate); throw new Error(`fault: ${name}`); });
    const state = s.savedState(), snap = s.snap(), tasks = s.tasks, undo = [...s.undoStack], events = [];
    s.on(kind => { if (!['pending', 'idle', 'suspended'].includes(kind)) events.push(kind); });
    await assert.rejects(command(s), /fault:/, name);
    assert.equal(calls.length, 1, name); assert.equal(s.savedState(), state, name); assert.equal(s.tasks, tasks, name);
    assert.equal(s.snap(), snap, name); assert.deepEqual(s.undoStack, undo, name); assert.deepEqual(events, [], name); assert(s.suspended, name);
  }
});

test('compound edits group undo for each affected sheet, and saved active identity stays valid', async () => {
  const s = fixture(), calls = transport(s);
  await s.commit(draft => {
    draft.setCell(1, 'name', 'First project');
    draft.switchSheet('s2'); draft.setCell(1, 'name', 'Second project'); draft.setOwner(2, 'Another owner', '');
  });
  assert.equal(calls.length, 1); assert.equal(s.wb.active, 's2'); assert.equal(s.undoStack.length, 2);
  await s.undo(); assert.equal(s.byId.get(1).name, 'First'); assert.equal(s.byId.get(2).owner, '');
  s.switchSheet('s1'); assert.equal(s.undoStack.length, 1); await s.undo(); assert.equal(s.byId.get(1).name, 'First');
});

test('an acknowledged key milestone is adopted, while later cosmetic navigation stays local', async () => {
  const s = fixture(), wait = deferred(), calls = transport(s, wait);
  const pending = s.setKeyMilestone(1, true); await tick();
  assert(!s.stars.has(1)); assert.deepEqual(calls[0].candidate.workbook.sheets[0].data.stars, [1]);
  s.switchSheet('s2'); wait.resolve(); await pending;
  assert.equal(s.wb.active, 's2'); assert.equal(s.savedState().workbook.active, 's1');
  s.switchSheet('s1'); assert(s.stars.has(1));
});

test('delay storage failure retains the complete origin plus record, without accepted changes', async () => {
  const s = fixture(); DL.agreeBaseline(s); const before = s.snap();
  s.enableCommits(async () => { throw new Error('disk full'); }); hook(s, () => ({ type: 'delay', cause: 'c1' }));
  await assert.rejects(s.setCell(1, 'dur', '8'), /disk full/);
  assert.equal(s.snap(), before); assert.equal(s.log.length, 0);
  const data = s.pendingCandidate.workbook.sheets[0].data;
  assert.equal(data.tasks[0].dur, 8); assert.equal(data.log.length, 1); assert.equal(s.pendingSheetId, 's1');
});

test('amend at the 150-entry undo cap retains one outer step and existing snapshot strings', async () => {
  const s = fixture(); DL.agreeBaseline(s);
  const snapshot = s.snap(); s.undoStack = Array.from({ length: 150 }, () => snapshot);
  const calls = transport(s); hook(s, () => ({ type: 'delay', cause: null }));
  await s.setCell(1, 'dur', '8');
  assert.equal(calls.length, 1); assert.equal(s.undoStack.length, 150); assert.equal(s.undoStack.at(-1), snapshot);
  await s.undo(); assert.equal(s.byId.get(1).dur, 5); assert.equal(s.log.length, 0);
});

test('draft hook factory scopes settings and captured live relationship mutations fail safely', async () => {
  const s = fixture(); s.addLink(1, 'f', 2, 's'); const calls = transport(s);
  appState.adopt('pm-test', 'live');
  s.hook = { forDraft(draft) { appState.setItem('pm-test', 'draft'); return DL.createDelayHook(draft); } };
  const link = s.links[0];
  await assert.rejects(s.tx(() => { link.lag = 9; }), TypeError);
  assert.equal(calls.length, 0); assert.equal(appState.getItem('pm-test'), 'live'); assert.equal(s.links[0].lag, 0);
  await s.setCell(1, 'name', 'Accepted'); assert.equal(appState.getItem('pm-test'), 'draft');
});

test('cosmetic changes cannot turn a no-op into a transaction, and submission captures the target synchronously', async () => {
  const s = fixture(), calls = transport(s);
  s.toggle(1); appState.setItem('pm-grid-scroll', 'changed');
  await s.setCell(1, 'name', 'First'); assert.equal(calls.length, 0);
  const pending = s.setCell(1, 'name', 'Submitted on first'); s.switchSheet('s2'); await pending;
  assert.equal(s.wb.active, 's2'); assert.equal(s.byId.get(1).name, 'First');
  s.switchSheet('s1'); assert.equal(s.byId.get(1).name, 'Submitted on first');
});

test('status lifecycle events carry no candidate adoption; suspend blocks further commands', async () => {
  const s = fixture(), wait = deferred(); transport(s, wait); const status = [];
  s.on(kind => status.push({ kind, pending: s.pending, value: s.byId.get(1).name }));
  const pending = s.setCell(1, 'name', 'Accepted');
  assert.deepEqual(status[0], { kind: 'pending', pending: true, value: 'First' });
  wait.resolve(); await pending;
  assert(status.some(s => s.kind === 'change' && s.value === 'Accepted' && !s.pending));
  assert.equal(status.at(-1).kind, 'idle');
  s.suspend(new Error('conflict')); await assert.rejects(s.newBlank(), /conflict/); await assert.rejects(s.whenIdle(), /conflict/);
});

test('candidate and structural transport patches survive strict JSON without lost optional values', async () => {
  const { changesBetween, sameJSON } = await import('../src/project_management_tool/web/js/changes.js');
  const s = new Store(null, { disk: true }), calls = [];
  s.enableCommits(async (candidate, base) => {
    const wire = JSON.parse(JSON.stringify(candidate));
    assert(sameJSON(candidate, wire), 'immutable attempted result must equal its exact JSON representation');
    const changes = changesBetween(base, candidate), encoded = JSON.parse(JSON.stringify(changes));
    assert.deepEqual(encoded, changes);
    for (const operation of encoded) if (operation.op === 'set') assert(Object.hasOwn(operation, 'value'), 'strict patch set requires a JSON value');
    calls.push(encoded);
  });
  await s.updateTask(8, { name: 'Ordinary edit' });
  await s.commit(draft => { draft.sheet().optional = undefined; draft.setOwner(8, 'Edited', ''); });
  assert.equal(calls.length, 2);
  assert(!Object.hasOwn(s.savedState().workbook.sheets[0], 'optional'));
  assert(!calls.flat().some(op => ['source', 'share'].includes(op.path.at(-1))));
});

test('compound callbacks preserve arbitrary success results and navigation clears a saved-version preview', async () => {
  const s = fixture(), calls = transport(s);
  assert.equal(await s.commit(draft => { draft.setCell(1, 'name', 'Result'); return 'done'; }), 'done');
  assert.equal(s.byId.get(1).name, 'Result'); assert.equal(calls.length, 1);
  const { version } = await s.snapshotVersion(); s.previewVersion(version.id); s.switchSheet('s2');
  assert.equal(s.previewView, null); assert.equal(s.presentation.byId.get(1).name, 'First');
});

test('failed overdue date plus reason validation discards both parts (F1)', async () => {
  const s = fixture(); DL.agreeBaseline(s); const before = s.snap(), calls = transport(s);
  const error = await s.commit(draft => {
    const pre = DL.snapshotBefore(draft), error = draft.applyCell(1, 'dur', '9');
    if (error) return error;
    return DL.record(draft, 1, pre, { type: 'revision', reason: '', approvedBy: '' });
  }, { errorStrings: true });
  assert.match(error, /revision needs/); assert.equal(calls.length, 0); assert.equal(s.snap(), before); assert.equal(s.log.length, 0);
});

test('resetAll adopts a clean workbook and cannot resurrect deleted undo history (F3)', async () => {
  const s = fixture(), calls = transport(s);
  await s.setCell(1, 'name', 'Before Reset'); await s.setCell(1, 'name', 'Second edit'); await s.undo();
  assert(s.undoStack.length); assert(s.redoStack.length);
  await s.resetAll(); assert.equal(calls.length, 4); assert.equal(s.wb.sheets.length, 1);
  assert.deepEqual(s.undoStack, []); assert.deepEqual(s.redoStack, []);
  assert.deepEqual(s.savedState().history, { s1: { u: [], r: [] } });
  const reset = s.snap(); await s.undo(); await s.redo(); assert.equal(s.snap(), reset);
});

test('delay drafts identify exact adoption only after acceptance, including verified retry', async () => {
  for (const failure of ['validation', 'transport', 'lost', 'none']) {
    const s = fixture(); DL.agreeBaseline(s); let draft, writes = 0;
    hook(s, (_option, candidate) => { draft = candidate; return failure === 'validation' ? { type: 'revision', reason: '', approvedBy: '' } : { type: 'delay', kind: 'Overrun', cause: 'c1' }; });
    s.enableCommits(async () => {
      writes++;
      if (failure === 'transport') throw Object.assign(new Error('Rejected candidate'), { status: 400, validation: true });
      if (failure === 'lost') throw new Error('Lost acknowledgement');
    });
    const before = s.savedState(), change = s.setCell(1, 'dur', '8');
    if (failure === 'none') await change;
    else {
      await assert.rejects(change, failure === 'validation' ? /revision needs/ : failure === 'transport' ? /Rejected candidate/ : /Lost acknowledgement/);
      assert.equal(draft._acceptedCandidate, undefined); assert.equal(s.savedState(), before);
      if (failure === 'lost') s.adoptPending(s.pendingCandidate);
      else { assert.equal(s.suspended, false); assert.equal(s.pendingCandidate, null); }
    }
    assert.equal(writes, failure === 'validation' ? 0 : 1);
    if (failure === 'none' || failure === 'lost') {
      assert.equal(draft._acceptedCandidate, s.savedState()); assert.equal(s.byId.get(1).dur, 8); assert.equal(s.log.length, 1);
    }
  }
});

test('legacy and imported task names trim before limiting and map whitespace to Untitled', async () => {
  const s = fixture(), data = JSON.parse(s.serialize());
  data.tasks[0].name = ' \t\n '; data.tasks[1].name = `  ${'N'.repeat(205)}  `;
  transport(s); await s.load(data);
  assert.equal(s.byId.get(1).name, 'Untitled'); assert.equal(s.byId.get(2).name, 'N'.repeat(200));
  const accepted = JSON.parse(JSON.stringify(s.savedState()));
  assert.deepEqual(accepted.workbook.sheets[0].data.tasks.map(t => t.name), ['Untitled', 'N'.repeat(200)]);
  const reloaded = new Store(accepted, { disk: true });
  assert.equal(reloaded.byId.get(1).name, 'Untitled'); assert.equal(reloaded.byId.get(2).name, 'N'.repeat(200));
});

test('inline names reject oversized text before mutation and accept corrected limits', async () => {
  const s = fixture(), calls = transport(s), before = s.savedState();
  assert.match(await s.setCell(1, 'name', 'N'.repeat(201)), /200 characters or fewer/);
  assert.match(await s.setCell(1, 'owner', 'O'.repeat(81)), /80 characters or fewer/);
  assert.match(await s.setCell(1, 'owner', `${'O'.repeat(81)} <owner@example.com>`), /80 characters or fewer/);
  assert.equal(calls.length, 0); assert.equal(s.savedState(), before); assert.equal(s.undoStack.length, 0); assert.equal(s.suspended, false);
  assert.equal(await s.setCell(1, 'name', 'N'.repeat(200)), null);
  assert.equal(await s.setCell(1, 'owner', 'O'.repeat(80)), null);
  assert.equal(s.byId.get(1).name, 'N'.repeat(200)); assert.equal(s.byId.get(1).owner, 'O'.repeat(80)); assert.equal(calls.length, 2);
});
