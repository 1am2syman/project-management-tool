import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, PREVIEW_LOCK, MAX_VERSIONS, cleanVersions, D } from '../src/project_management_tool/web/js/model.js';
import { appState } from '../src/project_management_tool/web/js/appstate.js';
import { encodeProjectFile, openProjectFile, parseProjectFile } from '../src/project_management_tool/web/js/projectfiles.js';

beforeEach(() => {
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), key: (i) => [...memory.keys()][i], get length() { return memory.size; } };
  appState.restore({});
});

const plan = (s) => { const { collapsed, ...rest } = s.sheet().data; void collapsed; return JSON.stringify(rest); };
const dur = (s, id) => s.byId.get(id).dur;

test('a snapshot stores the live plan with a number, name, note, scheduling mode and critical-path target', () => {
  const s = new Store(); s.setCriticalTarget(21);
  const r = s.snapshotVersion({ name: '  Baseline  ', note: 'Approved', by: 'Ada' });
  assert.equal(r.error, undefined);
  assert.deepEqual({ id: r.version.id, n: r.version.n, name: r.version.name, note: r.version.note, by: r.version.by, auto: r.version.auto, target: r.version.target }, { id: 'v1', n: 1, name: 'Baseline', note: 'Approved', by: 'Ada', auto: true, target: 21 });
  assert.equal(JSON.parse(r.version.data).collapsed, undefined, 'view state is not part of a version');
  assert.deepEqual(JSON.parse(r.version.data), JSON.parse(plan(s)));
  assert.equal(s.livePlan(), r.version.data);
  assert(s.unchangedSinceLatest());
  s.setCell(12, 'dur', '20');
  assert(!s.unchangedSinceLatest());
  assert.equal(s.snapshotVersion().version.name, 'Version 2');
  assert.deepEqual(s.versions().map((v) => v.n), [1, 2]);
  assert.equal(s.sheet().nextVersion, 3);
  assert.equal(s.undoStack.length, 1, 'snapshots are not undoable edits');
});

test('collapsing groups does not make the plan look changed since the latest version', () => {
  const s = new Store(); s.snapshotVersion();
  s.toggle(2); assert(s.unchangedSinceLatest());
});

test('versions are refused in stale windows and capped per project', () => {
  const s = new Store(); s.stale = true;
  assert.match(s.snapshotVersion().error, /reload before managing versions/);
  s.stale = false;
  const sheet = s.sheet(); s.snapshotVersion();
  sheet.versions = Array.from({ length: MAX_VERSIONS }, (_, i) => ({ ...sheet.versions[0], id: `v${i + 1}`, n: i + 1 }));
  assert.match(s.snapshotVersion().error, /at most 200 versions/);
});

test('previewing a version shows it read-only and never writes it over the live plan', () => {
  const s = new Store(), kinds = [];
  s.on((k) => kinds.push(k));
  s.snapshotVersion({ name: 'Base' });
  s.setCell(12, 'dur', '20');
  const live = JSON.stringify(s.sheet().data);
  assert.equal(s.previewVersion('v1'), null);
  assert(s.readOnly); assert.equal(s.previewing.id, 'v1'); assert.equal(dur(s, 12), 14);
  s.setCell(12, 'dur', '30'); assert.equal(dur(s, 12), 14); assert(kinds.includes('denied'));
  assert.equal(s.structureError(), PREVIEW_LOCK);
  assert.equal(s.setCriticalTarget(21), PREVIEW_LOCK);
  assert.equal(s.addLink(3, 'f', 21, 's'), PREVIEW_LOCK);
  s.undo(); assert.equal(dur(s, 12), 14);
  s.toggle(2); s.setPref('critical', false); s.save();
  assert.equal(JSON.stringify(s.sheet().data), live, 'saving while previewing keeps the live plan');
  assert.equal(JSON.stringify(s.savedState().workbook.sheets[0].data), live);
  s.exitPreview();
  assert(!s.readOnly); assert.equal(dur(s, 12), 20); assert.equal(s.previewing, null);
  assert(kinds.filter((k) => k === 'version').length >= 2);
});

test('a version keeps the dates it was saved with, even when the live plan auto-schedules', () => {
  const s = new Store(); s.setPref('auto', false);
  const before = s.info.get(15).start;
  s.setCell(15, 'start', '2026-12-28');
  const manualStart = s.info.get(15).start; assert.notEqual(manualStart, before);
  s.snapshotVersion();
  s.setPref('auto', true);
  assert.equal(s.versionView('v1').info.get(15).start, manualStart);
  assert.equal(s.previewVersion('v1'), null);
  assert.equal(s.info.get(15).start, manualStart, 'preview never propagates');
});

test('switching projects, resetting or opening a shared copy leaves the preview', () => {
  const s = new Store(); s.snapshotVersion(); s.newBlank(); s.switchSheet('s1');
  s.previewVersion('v1'); s.switchSheet('s2'); assert.equal(s.preview, null);
  s.switchSheet('s1'); s.previewVersion('v1'); s.resetAll(); assert.equal(s.preview, null);
});

test('restore replaces the plan in one undoable step and never reuses task or relationship IDs', () => {
  const s = new Store();
  s.setCriticalTarget(21);
  s.snapshotVersion({ name: 'Base' });
  const base = s.livePlan();
  s.setCell(12, 'dur', '20');
  const added = s.insertTask(9).id; s.deleteTask(19);
  s.setCriticalTarget(null);
  const nextId = s.nextId, nextLink = s.nextLink, edited = s.livePlan();
  s.previewVersion('v1');
  assert.equal(s.restoreVersion('v1'), null);
  assert.equal(s.preview, null);
  assert.equal(dur(s, 12), 14); assert(!s.byId.has(added)); assert(s.byId.has(19));
  assert.equal(s.nextId, nextId); assert.equal(s.nextLink, nextLink);
  assert.equal(s.criticalTarget()?.id, 21);
  const restored = JSON.parse(s.livePlan()); restored.nextId = JSON.parse(base).nextId; restored.nextLink = JSON.parse(base).nextLink;
  assert.equal(JSON.stringify(restored), base);
  s.undo(); assert.equal(s.livePlan(), edited);
  s.redo(); assert.equal(dur(s, 12), 14);
});

test('restore is refused for shared read-only projects and stale windows', () => {
  const s = new Store(); s.snapshotVersion();
  s.sheet().readOnly = true; assert.equal(s.restoreVersion('v1'), 'This project is read-only');
  s.sheet().readOnly = false; s.stale = true; assert.match(s.restoreVersion('v1'), /reload before restoring/);
  assert.equal(s.restoreVersion('v9'), 'That version no longer exists');
});

test('rename, note and delete; deleted numbers are never reused', () => {
  const s = new Store(); s.snapshotVersion(); s.snapshotVersion();
  assert.equal(s.updateVersion('v1', { name: '  ', note: 'x' }), 'Give the version a name');
  assert.equal(s.updateVersion('v1', { name: 'Kick-off', note: 'Signed' }), null);
  assert.deepEqual([s.version('v1').name, s.version('v1').note], ['Kick-off', 'Signed']);
  s.previewVersion('v2');
  assert.equal(s.deleteVersion('v2'), null); assert.equal(s.preview, null, 'deleting the shown version returns to Current');
  assert.equal(s.snapshotVersion().version.n, 3);
  assert.equal(s.deleteVersion('v2'), 'That version no longer exists');
});

test('versions persist with the workbook and invalid stored versions are dropped', () => {
  const s = new Store(); s.snapshotVersion({ name: 'Base', note: 'n' }); s.snapshotVersion(); s.deleteVersion('v2');
  const reopened = new Store(JSON.parse(JSON.stringify(s.savedState())));
  assert.deepEqual(reopened.versions().map((v) => [v.id, v.name, v.note]), [['v1', 'Base', 'n']]);
  assert.equal(reopened.sheet().nextVersion, 3);
  assert.deepEqual(cleanVersions([{ n: 1, data: '{' }, { n: 0, data: '{"tasks":[],"links":[]}' }, { n: 2, data: '{"tasks":[],"links":[]}', name: '' }, { n: 2, data: '{"tasks":[],"links":[]}' }]).map((v) => [v.id, v.name]), [['v2', 'Version 2']]);
  reopened.newBlank(); assert.equal('versions' in reopened.savedState().workbook.sheets.at(-1), false, 'projects without versions keep their saved shape');
});

test('copy as new project, duplicates and sharing snapshots keep versions separate', () => {
  const s = new Store(); s.setCriticalTarget(21); s.snapshotVersion({ name: 'Base' }); s.setCell(12, 'dur', '20');
  const r = s.copyVersionAsProject('v1');
  assert.equal(s.wb.active, r.id); assert.equal(s.sheet().name, 'Launch plan · Base');
  assert.equal(dur(s, 12), 14); assert.equal(s.versions().length, 0); assert.equal(s.criticalTarget()?.id, 21);
  s.switchSheet('s1');
  const dup = s.duplicateSheet('s1'); assert.equal(s.sheet(dup).versions, undefined);
  s.switchSheet('s1');
  assert.equal(JSON.stringify(s.snapshot()).includes('"versions"'), false);
});

test('.plan files carry versions in format 4 and older files still open', () => {
  const s = new Store(); s.setCriticalTarget(21); s.snapshotVersion({ name: 'Base', note: 'Approved', by: 'Ada' });
  s.setCell(12, 'dur', '20'); s.snapshotVersion({ name: 'Later' }); s.deleteVersion('v2'); s.setCell(12, 'dur', '22');
  s.previewVersion('v1');
  const doc = JSON.parse(encodeProjectFile(s));
  assert.equal(doc.version, 4);
  assert.equal(doc.project.data.tasks.find((t) => t.id === 12).dur, 22, 'the file holds the live plan while a version is shown');
  assert.deepEqual(doc.project.versions.map((v) => [v.n, v.name, v.note, v.by, v.target]), [[1, 'Base', 'Approved', 'Ada', 21]]);
  assert.equal(doc.project.nextVersion, 3);
  assert.equal(doc.project.versions[0].plan.collapsed, undefined);
  s.exitPreview();
  const id = openProjectFile(s, JSON.stringify(doc));
  assert.equal(s.wb.active, id);
  assert.deepEqual(s.versions().map((v) => [v.id, v.name, v.target]), [['v1', 'Base', 21]]);
  assert.equal(s.sheet().nextVersion, 3);
  assert.equal(s.versionView('v1').byId.get(12).dur, 14);
  assert.equal(s.snapshotVersion().version.n, 3);
  s.newBlank(); const plain = JSON.parse(encodeProjectFile(s));
  assert(plain.version < 4); assert.equal(plain.project.versions, undefined);
});

test('.plan versions are validated before anything is opened', () => {
  const s = new Store(); s.snapshotVersion(); s.snapshotVersion();
  const good = JSON.parse(encodeProjectFile(s)), before = JSON.stringify(s.savedState());
  const bad = [
    (d) => { d.version = 3; }, (d) => { d.project.versions = {}; }, (d) => { d.project.versions[1].n = 1; },
    (d) => { d.project.versions[0].name = ' '; }, (d) => { d.project.versions[0].at = 'yesterday'; },
    (d) => { d.project.versions[0].auto = 'yes'; }, (d) => { d.project.versions[0].target = 0; },
    (d) => { delete d.project.versions[0].plan.tasks; }, (d) => { d.project.versions[0].plan.tasks[0].dur = -1; },
    (d) => { d.project.versions[0].plan.nextId = 1; }, (d) => { d.project.nextVersion = 2; },
    (d) => { d.project.versions[0].plan.links[0].to = 99999; },
  ];
  for (const change of bad) {
    const doc = structuredClone(good); change(doc);
    assert.throws(() => openProjectFile(s, JSON.stringify(doc)), /Invalid Plan project/, String(change));
    assert.equal(JSON.stringify(s.savedState()), before);
  }
  assert.equal(parseProjectFile(JSON.stringify(good)).versions.length, 2);
});

void D;
