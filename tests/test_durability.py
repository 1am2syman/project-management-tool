"""Atomic structural patch, accounting, trust boundary and cost regressions."""
import copy
import json
import queue
import random
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from test_storage import STATE, http_request

from src.project_management_tool import create_server
from src.project_management_tool import persistence as p


def set_value(path, value):
    return {"op": "set", "path": path, "value": value}


def splice(path, start, count, items):
    return {"op": "splice", "path": path, "start": start, "deleteCount": count, "items": items}


def remove(path):
    return {"op": "remove", "path": path}


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="Plan durability Ω ")
        self.addCleanup(self.temp.cleanup)
        self.storage = p.ProjectStorage(self.temp.name)
        self.state = copy.deepcopy(STATE)
        self.revision = self.storage.write(None, self.state)["revision"]

    def apply(self, *changes):
        result = self.storage.apply_changes(self.revision, list(changes))
        self.revision = result["revision"]
        return result

    def saved_state(self):
        state = self.storage.read()["state"]
        assert isinstance(state, dict)
        return state

    def accounting(self):
        state = self.saved_state()
        with closing(self.storage.connect()) as db:
            total = db.execute("SELECT bytes FROM workspace").fetchone()[0]
            independent = sum(p.node_bytes(p.decode(raw)) for (raw,) in db.execute(
                "SELECT o.value FROM current c JOIN objects o ON o.hash=c.hash"))
        self.assertEqual(total, len(p.json_bytes(state)))
        self.assertEqual(total, independent)
        return total

    def database_contents(self):
        with closing(self.storage.connect()) as db:
            return {"objects": db.execute("SELECT * FROM objects ORDER BY 1").fetchall(),
                    "current": db.execute("SELECT * FROM current ORDER BY 1").fetchall(),
                    "versions": db.execute("SELECT * FROM versions ORDER BY 1").fetchall(),
                    "workspace": db.execute("SELECT * FROM workspace ORDER BY 1").fetchall()}

    def test_field_edit_history_conflict_and_noop(self):
        self.apply(set_value(["workbook", "sheets", 0, "name"], "Accepted Ω"))
        self.state["workbook"]["sheets"][0]["name"] = "Accepted Ω"
        self.assertEqual(self.saved_state(), self.state)
        self.assertEqual(self.storage.version(1)["state"], STATE)
        self.assertEqual(self.storage.version(2)["state"], self.state)
        with self.assertRaises(p.ConflictError):
            self.storage.apply_changes("1", [set_value(["preferences", "auto"], True)])
        before = self.database_contents()
        self.apply(set_value(["preferences", "auto"], True), set_value(["preferences", "auto"], False))
        self.apply(set_value(["browser", "new"], "cancelled"), remove(["browser", "new"]))
        self.apply(remove(["preferences", "auto"]), set_value(["preferences", "auto"], False))
        self.apply()
        self.assertEqual(self.revision, "2")
        self.assertEqual(self.database_contents(), before)
        self.accounting()

    def test_splice_cancellation_and_reordered_shifted_object_are_true_noops(self):
        self.apply(set_value(["templates"], [{"a": 1, "b": 2}]))
        before = self.database_contents()
        revision = self.revision
        self.apply(splice(["templates"], 0, 0, [1]),
                   set_value(["templates", 1], {"b": 2, "a": 1}),
                   splice(["templates"], 0, 1, []))
        self.assertEqual(self.revision, revision)
        self.assertEqual(self.database_contents(), before)

    def test_key_order_only_splice_replacement_is_a_true_noop_f10(self):
        self.apply(set_value(["templates"], [{"a": 1, "nested": {"x": 2, "y": 3}}]))
        before = self.database_contents()
        revision = self.revision
        self.apply(splice(["templates"], 0, 1, [{"nested": {"y": 3, "x": 2}, "a": 1}]))
        self.assertEqual(self.revision, revision)
        self.assertEqual(self.database_contents(), before)

    def test_remove_readd_reordered_nested_subtree_is_a_true_noop(self):
        self.apply(set_value(["browser", "nested"], {"a": 1, "child": {"x": 2, "y": 3}}))
        revision = self.revision
        before = self.database_contents()
        self.apply(remove(["browser", "nested"]),
                   set_value(["browser", "nested"], {"child": {"y": 3, "x": 2}, "a": 1}))
        self.assertEqual(self.revision, revision)
        self.assertEqual(self.database_contents(), before)

    def test_exact_escaped_ranges_and_object_keys(self):
        values = {"%": {"deep": 1}, "_": 2, "a": {"x": [1, 2]}, "ab": {"x": 8},
                  "a/b": {"~x": 9}, "a~1b": 10, "Ω": {"": 4}, "": {"/": 7}, "0": 3}
        self.apply(set_value(["browser"], values))
        self.apply(remove(["browser", "a"]), set_value(["browser", "%"], False),
                   remove(["browser", "a/b"]), set_value(["browser", "Ω", ""], [1]))
        expected = copy.deepcopy(values)
        del expected["a"], expected["a/b"]
        expected["%"] = False
        expected["Ω"][""] = [1]
        self.assertEqual(self.saved_state()["browser"], expected)
        self.assertEqual(self.storage.version(2)["state"]["browser"], values)
        self.accounting()

    def test_splice_remaps_nested_paths_in_both_directions_and_replays(self):
        original = [{"id": i, "nested/key": [i, {"~": str(i)}]} for i in range(15)]
        self.apply(set_value(["templates"], original))
        states = [self.saved_state()]
        expected = copy.deepcopy(original)
        for start, count, items in [(1, 0, [{"new": 1}, 2]), (0, 4, []), (3, 2, [None]),
                                    (len(expected), 0, [])]:
            # Last no-op is valid only at the then-current array end.
            start = min(start, len(expected))
            self.apply(splice(["templates"], start, count, items))
            expected[start:start + count] = items
            self.assertEqual(self.saved_state()["templates"], expected)
            self.accounting()
            states.append(self.saved_state())
        self.assertEqual(self.storage.version(2)["state"], states[0])
        for revision, state in enumerate(states[1:4], 3):
            self.assertEqual(self.storage.version(revision)["state"], state)

    def test_undo_cap_shifts_existing_hashes_without_decoding_or_hashing_snapshots(self):
        snapshots = [f"snapshot-{i:03d}:" + ("Ω" * 5000) for i in range(150)]
        self.apply(set_value(["history", "s1", "u"], snapshots))
        with closing(self.storage.connect()) as db:
            old = dict(db.execute("SELECT path,hash FROM current WHERE path>=? AND path<?",
                                  ("/history/s1/u/", "/history/s1/u0")))
        real_decode, real_encode = p.decode, p.encode
        def guarded_decode(raw):
            value = real_decode(raw)
            if value[0] == "value" and isinstance(value[1], str) and value[1].startswith("snapshot-"):
                self.fail("A retained snapshot was decoded during remap")
            return value
        def guarded_encode(value):
            if isinstance(value, list) and value[0] == "value" and isinstance(value[1], str) and value[1].startswith("snapshot-"):
                self.fail("A retained snapshot was encoded during remap")
            return real_encode(value)
        with patch.object(p, "decode", side_effect=guarded_decode), patch.object(p, "encode", side_effect=guarded_encode), \
             patch.object(p, "inflate", side_effect=AssertionError("ordinary inflate")):
            self.apply(splice(["history", "s1", "u"], 0, 1, []),
                       splice(["history", "s1", "u"], 149, 0, ["new snapshot"]))
        with closing(self.storage.connect()) as db:
            new = dict(db.execute("SELECT path,hash FROM current WHERE path>=? AND path<?",
                                  ("/history/s1/u/", "/history/s1/u0")))
        for i in range(149):
            self.assertEqual(new[f"/history/s1/u/{i}"], old[f"/history/s1/u/{i + 1}"])
        self.assertEqual(self.saved_state()["history"]["s1"]["u"], snapshots[1:] + ["new snapshot"])
        self.accounting()

    def test_nested_snapshot_remap_never_decodes_retained_object_headers(self):
        snapshots = [{"snapshotBody": f"snapshot-{i}", "serial": i} for i in range(20)]
        self.apply(set_value(["history", "s1", "u"], snapshots))
        real_decode = p.decode
        def guarded(raw):
            value = real_decode(raw)
            if value[0] == "object" and "snapshotBody" in value[1]:
                self.fail("A remapped object header was decoded")
            if value[0] == "value" and isinstance(value[1], str) and value[1].startswith("snapshot-"):
                self.fail("A remapped value was decoded")
            return value
        with patch.object(p, "decode", side_effect=guarded):
            self.apply(splice(["history", "s1", "u"], 0, 0, [{"newBody": 1}]))
        self.assertEqual(self.saved_state()["history"]["s1"]["u"], [{"newBody": 1}] + snapshots)
        self.accounting()

    def test_metrics_measure_hashes_net_writes_and_remaps(self):
        result = self.apply(set_value(["preferences", "auto"], True))
        self.assertEqual(result["metrics"]["nodesHashed"], 1)
        self.assertEqual(result["metrics"]["nodesWritten"], 1)
        self.assertEqual(result["metrics"]["nodesRemapped"], 0)
        self.assertGreater(result["metrics"]["nodesVisited"], 0)
        result = self.apply(set_value(["preferences", "auto"], True))
        self.assertEqual(result["metrics"]["nodesWritten"], 0)
        self.apply(set_value(["templates"], [1, 2, 3]))
        result = self.apply(splice(["templates"], 0, 1, []))
        self.assertEqual(result["metrics"]["nodesRemapped"], 2)
        self.assertEqual(result["metrics"]["nodesHashed"], 1, "only array header is hashed")

    def test_equal_length_splice_does_not_visit_untouched_tail(self):
        self.apply(set_value(["templates"], list(range(100))))
        rows = p._PatchTransaction.rows
        visited = []
        def checked(transaction, path):
            visited.append(path)
            return rows(transaction, path)
        with patch.object(p._PatchTransaction, "rows", checked):
            self.apply(splice(["templates"], 1, 1, ["replacement"]))
        self.assertEqual(set(visited), {"/templates/1"})

    def test_net_changes_use_original_hashes_once_after_overlapping_operations(self):
        before = self.database_contents()["current"]
        self.apply(set_value(["templates"], [{"a": 1}, {"b": 2}]),
                   splice(["templates"], 0, 1, [3, 4]),
                   set_value(["templates", 1], {"done": True}),
                   remove(["browser", "pm-density"]), set_value(["browser", "pm-density"], "compact"))
        with closing(self.storage.connect()) as db:
            changes = p.decode(db.execute("SELECT changes FROM versions WHERE revision=2").fetchone()[0])
            after = dict(db.execute("SELECT path,hash FROM current"))
        before = dict(before)
        self.assertEqual(changes, {key: [before.get(key), after.get(key)]
                                  for key in before.keys() | after.keys() if before.get(key) != after.get(key)})
        self.assertEqual(self.storage.version(2), self.storage.read())
        self.accounting()

    def test_invalid_dialect_paths_counts_and_json_are_atomic(self):
        invalid = [None, {}, [None], [{"op": "unknown", "path": ["x"]}],
                   [set_value([], {})], [set_value("browser", {})], [set_value([True], 2)],
                   [set_value(["templates", "0"], 2)], [set_value(["templates", 0], 2)],
                   [set_value(["browser", 0], 2)], [set_value(["browser", "missing", "x"], 2)],
                   [set_value(["preferences", "auto", "x"], 2)], [remove(["templates", 0])],
                   [remove(["browser", "missing"])], [splice(["browser"], 0, 0, [])],
                   [splice(["templates"], 1, 0, [])], [splice(["templates"], 0, 1, [])],
                   [splice(["templates"], True, 0, [])], [splice(["templates"], 0, -1, [])],
                   [splice(["templates"], 0, 0, {})], [set_value(["browser", "x"], float("nan"))],
                   [set_value(["browser", "x"], float("inf"))], [set_value(["browser", "x"], {1: 2})],
                   [set_value(["browser", "x"], (1, 2))], [set_value(["browser", "x"], "\ud800")],
                   [{**set_value(["browser", "x"], 1), "extra": 1}],
                   [set_value(["browser", "x"], 1)] * (p.MAX_CHANGES + 1)]
        before = self.database_contents()
        for changes in invalid:
            with self.subTest(changes=repr(changes)[:100]):
                with self.assertRaises((ValueError, UnicodeError)):
                    self.storage.apply_changes(self.revision, changes)
                self.assertEqual(self.database_contents(), before)
        for revision in (True, 1, "01", "0", "-1", "١", "9223372036854775808", [], {}):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                self.storage.apply_changes(revision, [])

    def test_invariant_headers_and_compound_project_changes(self):
        invalid = [remove(["workbook"]), set_value(["workbook"], []), remove(["workbook", "active"]),
                   set_value(["workbook", "active"], []), set_value(["workbook", "sheets"], []),
                   set_value(["workbook", "sheets", 0, "data", "tasks"], {}),
                   remove(["workbook", "sheets", 0, "data", "links"]),
                   set_value(["templates"], {}), set_value(["history"], []),
                   set_value(["preferences"], []), set_value(["browser"], []),
                   splice(["workbook", "sheets"], 1, 0, [copy.deepcopy(STATE["workbook"]["sheets"][0])])]
        before = self.database_contents()
        for change in invalid:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.apply(set_value(["browser", "temporary"], 1), change)
            self.assertEqual(self.database_contents(), before)
        second = copy.deepcopy(STATE["workbook"]["sheets"][0])
        second["id"] = "s2"
        self.apply(splice(["workbook", "sheets"], 1, 0, [second]), set_value(["workbook", "active"], "s2"))
        self.apply(splice(["workbook", "sheets"], 0, 1, []))
        self.assertEqual(self.saved_state()["workbook"]["sheets"], [second])
        self.accounting()

    def test_task_record_types_identity_and_dates_are_strict_and_atomic(self):
        path = ["workbook", "sheets", 0, "data", "tasks", 0]
        invalid = [("id", True), ("id", 0), ("id", 1.5), ("id", "1"), ("id", 2**53),
                   ("name", []), ("name", ""), ("name", "a" * 201), ("owner", 4),
                   ("email", "invalid"), ("level", -1), ("level", 1.5), ("start", "today"),
                   ("dur", 0), ("dur", -1), ("dur", 1.5), ("progress", 101), ("progress", "5"),
                   ("ms", 1), ("noRem", "false"), ("scheduling", "broken"),
                   ("actualStart", None), ("actualEnd", "later"), ("notes", {}),
                   ("agr", {"s": 1, "f": 2.5, "o": 2}), ("inc", False),
                   ("calendar", {"workdays": [], "holidays": []})]
        before = self.database_contents()
        for field, value in invalid:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.apply(set_value(path + [field], value))
            self.assertEqual(self.database_contents(), before)
        for values in ({"actualStart": 10, "actualEnd": 9}, {"ms": True, "dur": 2},
                       {"ms": True, "actualEnd": 3}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.apply(*(set_value(path + [key], value) for key, value in values.items()))
            self.assertEqual(self.database_contents(), before)
        # Compound milestone conversion can temporarily violate cross-field rules.
        self.apply(set_value(path + ["dur"], 0), set_value(path + ["ms"], True),
                   set_value(path + ["actualStart"], 4))
        self.assertTrue(self.saved_state()["workbook"]["sheets"][0]["data"]["tasks"][0]["ms"])

    def test_task_link_uniqueness_references_hierarchy_and_cycles(self):
        data_path = ["workbook", "sheets", 0, "data"]
        task2 = {"id": 2, "name": "Second", "level": 0}
        self.apply(splice(data_path + ["tasks"], 1, 0, [task2]))
        link = {"id": "l1", "from": 1, "to": 2, "type": "FS", "lag": 0}
        self.apply(splice(data_path + ["links"], 0, 0, [link]))
        before = self.database_contents()
        invalid = [set_value(data_path + ["tasks", 1, "id"], 1),
                   splice(data_path + ["tasks"], 1, 0, [{"id": 1, "name": "Duplicate"}]),
                   splice(data_path + ["tasks"], 0, 1, []),
                   set_value(data_path + ["tasks", 1, "level"], 1),
                   set_value(data_path + ["tasks", 0, "level"], 1),
                   set_value(data_path + ["links", 0, "id"], "bad"),
                   set_value(data_path + ["links", 0, "id"], "l01"),
                   set_value(data_path + ["links", 0, "from"], 99),
                   set_value(data_path + ["links", 0, "to"], 1),
                   set_value(data_path + ["links", 0, "type"], "XX"),
                   set_value(data_path + ["links", 0, "lag"], "2"),
                   splice(data_path + ["links"], 1, 0, [link]),
                   splice(data_path + ["links"], 1, 0, [{**link, "id": "l2", "from": 2, "to": 1}]),
                   set_value(data_path + ["nextId"], 2), set_value(data_path + ["nextLink"], 1)]
        for change in invalid:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.apply(change)
            self.assertEqual(self.database_contents(), before)
        self.apply(splice(data_path + ["links"], 0, 1, []), splice(data_path + ["tasks"], 0, 1, []))
        self.assertEqual(self.saved_state()["workbook"]["sheets"][0]["data"]["tasks"], [task2])
        self.accounting()

    def test_sparse_legacy_unknown_fields_stay_inert_and_bootstrap_checks_records(self):
        task = {"id": 1, "name": "Legacy sparse", "futurePlugin": {"arbitrary": [None, "inert"]}}
        self.apply(set_value(["workbook", "sheets", 0, "data", "tasks", 0], task))
        self.assertEqual(self.saved_state()["workbook"]["sheets"][0]["data"]["tasks"][0], task)
        self.apply(set_value(["workbook", "sheets", 0, "data", "tasks", 0, "name"], "Edited sparse"))
        self.assertEqual(self.saved_state()["workbook"]["sheets"][0]["data"]["tasks"][0]["futurePlugin"], task["futurePlugin"])
        for tasks, links in (([None], []), ([{"id": 1, "name": "A"}, {"id": 1, "name": "B"}], []),
                             ([task], [{"id": "l1", "from": 1, "to": 2, "type": "FS", "lag": 0}])):
            state = copy.deepcopy(STATE)
            state["workbook"]["sheets"][0]["data"].update(tasks=tasks, links=links)
            with self.assertRaises(ValueError):
                self.storage.write(self.revision, state)

    def test_summary_fields_and_sparse_valid_link_unknown_metadata(self):
        data_path = ["workbook", "sheets", 0, "data"]
        self.apply(splice(data_path + ["tasks"], 1, 0, [{"id": 2, "name": "Child", "level": 1}]))
        for field, value in (("actualStart", 1), ("actualEnd", 2),
                             ("calendar", {"workdays": [1, 2, 3, 4, 5], "holidays": []})):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.apply(set_value(data_path + ["tasks", 0, field], value))
        # Agreement is historical leaf metadata retained by real summary conversion.
        self.apply(set_value(data_path + ["tasks", 0, "agr"], {"s": 1, "f": 2, "o": 2}))
        self.apply(set_value(data_path + ["tasks", 1, "level"], 0))
        link = {"id": "l1", "from": 1, "to": 2, "type": "SF", "lag": -3, "plugin": {"future": True}}
        self.apply(splice(data_path + ["links"], 0, 0, [link]))
        self.assertEqual(self.saved_state()["workbook"]["sheets"][0]["data"]["links"], [link])
        self.accounting()

    def test_task_name_edit_does_not_scan_other_task_ids_or_bodies(self):
        self.apply(splice(["workbook", "sheets", 0, "data", "tasks"], 1, 0,
                          [{"id": i, "name": "untouched-task-body"} for i in range(2, 102)]))
        real_node = p._PatchTransaction.node
        def guard(transaction, path):
            if path.startswith("/workbook/sheets/0/data/tasks/") and not path.startswith("/workbook/sheets/0/data/tasks/0/") and path != "/workbook/sheets/0/data/tasks/0":
                self.fail("Name edit scanned unrelated task: " + path)
            return real_node(transaction, path)
        with patch.object(p._PatchTransaction, "node", guard):
            self.apply(set_value(["workbook", "sheets", 0, "data", "tasks", 0, "name"], "Only touched task"))

    def test_real_production_candidate_contract_matrix_preserves_historical_agreement(self):
        script = r'''
import {Store} from './src/project_management_tool/web/js/model.js';
import {appState} from './src/project_management_tool/web/js/appstate.js';
import {changesBetween} from './src/project_management_tool/web/js/changes.js';
import * as DL from './src/project_management_tool/web/js/delays.js';
const task = id => ({id, name: 'Task ' + id, start: 20000, dur: 5, level: 0,
                    ms: false, scheduling: 'auto', progress: 0});
const cases = [
 ['baseline', s => s.snapshotAgreed(d => DL.agreeBaseline(d), {type:'baseline'})],
 ['insertchild', s => s.insertTask(1, false, 'child')],
 ['indent', s => s.indent(2, 1)],
 ['movechild', s => s.moveTask(2, 1, 'child')],
 ['milestone', s => s.setTaskKind(1, true)],
 ['updateMilestone', s => s.updateTask(1, {ms:true})],
 ['actualCalendarSummary', s => s.insertTask(1, false, 'child')],
];
const out = [];
for (const [name, action] of cases) {
 appState.restore({}, {disk:true});
 const tasks = [task(1), task(2), task(3)];
 if (name === 'actualCalendarSummary') Object.assign(tasks[0], {
   actualStart: 19999, actualEnd: 20002, calendar: {workdays:[1,2,3,4,5], holidays:[]}});
 const s = new Store({workbook:{active:'s1',sheets:[{id:'s1',name:'One',data:{tasks,links:[],nextId:4,nextLink:1}}]},
                      templates:[], history:{}, preferences:{}}, {disk:true});
 if (name !== 'baseline') DL.agreeBaseline(s);
 const initial = s.savedState(), steps = [];
 s.hook = {forDraft:d => DL.createDelayHook(d, () => ({type:'delay', cause:null}))};
 s.enableCommits(async (candidate, base) => {
   steps.push({candidate, changes:changesBetween(base,candidate)});
   return {revision:String(steps.length + 1)};
 });
 const result = await action(s);
 if (result?.error || typeof result === 'string') throw new Error(name + ': ' + JSON.stringify(result));
 if (steps.length !== 1) throw new Error(name + ': expected originating transaction');
 const first = steps[0].candidate.workbook.sheets[0].data.tasks[0];
 if (['insertchild','indent','movechild','actualCalendarSummary'].includes(name) && !first.agr) throw new Error(name + ': missing historical agreement');
 if (['milestone','updateMilestone'].includes(name) && (!first.ms || first.agr.s === first.agr.f)) throw new Error(name + ': expected historical multiday agreement');
 if (name === 'actualCalendarSummary' && ('actualStart' in first || 'actualEnd' in first || 'calendar' in first)) throw new Error('summary cleanup missing');
 if (name === 'baseline') {
   await s.setCell(1, 'name', 'After baseline');
   await s.undo(); await s.redo();
   if (steps.length !== 4) throw new Error(name + ': post-baseline undo/redo transport missing');
 } else {
   await s.undo(); await s.redo();
   if (steps.length !== 3) throw new Error(name + ': undo/redo transport missing');
 }
 // Unrelated substantive edit must accept retained historical agreement too.
 await s.renameSheet('s1','Renamed');
 out.push({name,initial,steps});
}
console.log(JSON.stringify(out));
'''
        result = subprocess.run(["node", "--input-type=module"], input=script, capture_output=True,
                                text=True, timeout=30, check=False, cwd=Path(__file__).resolve().parents[1])
        self.assertEqual(result.returncode, 0, result.stderr)
        cases = json.loads(result.stdout)
        self.assertEqual({case["name"] for case in cases}, {"baseline", "insertchild", "indent", "movechild",
                                                          "milestone", "updateMilestone", "actualCalendarSummary"})
        for case in cases:
            with self.subTest(case=case["name"]), tempfile.TemporaryDirectory() as directory:
                storage = p.ProjectStorage(directory)
                revision = storage.write(None, case["initial"])["revision"]
                for step in case["steps"]:
                    p.validate_state(step["candidate"])
                    revision = storage.apply_changes(revision, step["changes"])["revision"]
                    self.assertEqual(storage.read()["state"], step["candidate"])
                    self.assertEqual(storage.version(int(revision))["state"], step["candidate"])
                # A restart/bootstrap of each actual resulting candidate also validates.
                for step in case["steps"]:
                    storage.write(storage.read()["revision"], step["candidate"])

    def test_request_result_size_and_depth_limits_roll_back(self):
        base = self.accounting()
        before = self.database_contents()
        with patch.object(p, "MAX_BYTES", base + 50), self.assertRaisesRegex(ValueError, "workspace limit"):
            self.apply(set_value(["browser", "large"], "a" * 60))
        self.assertEqual(self.database_contents(), before)
        with patch.object(p, "MAX_BYTES", base + 50), self.assertRaisesRegex(ValueError, "request limit"):
            self.apply(set_value(["browser", "large"], "a" * (base + 100)))
        value = 1
        for _ in range(p.MAX_DEPTH):
            value = [value]
        with self.assertRaisesRegex(ValueError, "nesting"):
            self.apply(set_value(["browser", "deep"], value))
        self.assertEqual(self.database_contents(), before)

    def test_statement_failures_roll_back_objects_current_history_and_accounting(self):
        for table, operation in [("objects", "INSERT"), ("current", "DELETE"),
                                 ("current", "INSERT"), ("workspace", "UPDATE"), ("versions", "INSERT")]:
            before = self.database_contents()
            with closing(self.storage.connect()) as db, db:
                db.execute(f"CREATE TRIGGER fail_patch BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'disk full'); END")
            try:
                with self.assertRaises(sqlite3.DatabaseError):
                    self.apply(set_value(["browser", "pm-density"], "must roll back"),
                               splice(["templates"], 0, 0, [{"new": "object"}]))
                self.assertEqual(self.database_contents(), before)
            finally:
                with closing(self.storage.connect()) as db, db:
                    db.execute("DROP TRIGGER fail_patch")
        self.accounting()

    def test_commit_failure_rolls_back_all_tables(self):
        before = self.database_contents()
        with closing(self.storage.connect()) as db, db:
            db.execute("CREATE TRIGGER fail_commit AFTER INSERT ON versions BEGIN "
                       "INSERT INTO current(path,hash) VALUES ('/fault','missing-object'); END")
        real_connect = self.storage.connect
        statements = []
        def defer_constraints():
            db = real_connect()
            db.execute("PRAGMA defer_foreign_keys=ON")
            db.set_trace_callback(statements.append)
            return db
        with patch.object(self.storage, "connect", side_effect=defer_constraints), \
             self.assertRaisesRegex(sqlite3.IntegrityError, "FOREIGN KEY"):
            self.apply(set_value(["preferences", "auto"], True))
        self.assertIn("COMMIT", statements)
        self.assertIn("ROLLBACK", statements)
        self.assertEqual(self.database_contents(), before)

    def test_process_death_before_and_after_commit_reopens_atomically(self):
        script = '''
import sys
# The bundled Windows interpreter is isolated (._pth): neither the working directory
# nor PYTHONPATH is searched, so the repository root is passed explicitly.
sys.path.insert(0, sys.argv[3])
from src.project_management_tool.persistence import ProjectStorage
storage = ProjectStorage(sys.argv[1])
mode = sys.argv[2]
if mode == 'before':
    finish = storage._finish
    def paused(*args):
        result = finish(*args)
        print('READY', flush=True)
        sys.stdin.readline()
        return result
    storage._finish = paused
storage.apply_changes('1', [{'op':'set','path':['preferences','auto'],'value':True}])
print('READY', flush=True)
sys.stdin.readline()
'''
        for mode in ("before", "after"):
            proc = subprocess.Popen([sys.executable, "-B", "-c", script, self.temp.name, mode,
                                     str(Path(__file__).resolve().parents[1])],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, cwd=Path(__file__).resolve().parents[1])
            try:
                ready = queue.Queue()
                assert proc.stdout is not None
                output = proc.stdout
                threading.Thread(target=lambda stream=output, result=ready: result.put(stream.readline()), daemon=True).start()
                self.assertEqual(ready.get(timeout=10), "READY\n")
                proc.kill()
                proc.communicate(timeout=10)
                saved = p.ProjectStorage(self.temp.name).read()
                self.assertEqual(saved["revision"], "1" if mode == "before" else "2")
                assert isinstance(saved["state"], dict)
                self.assertEqual(saved["state"]["preferences"]["auto"], mode == "after")
                self.assertEqual(len(self.storage.history()["entries"]), 1 if mode == "before" else 2)
                self.accounting()
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.communicate(timeout=10)

    def test_concurrent_patch_and_lost_response_retry_only_one_revision_wins(self):
        changes = [set_value(["browser", "accepted"], True)]
        def write(_):
            try:
                return self.storage.apply_changes("1", changes)["revision"]
            except p.ConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(write, range(2))), ["2", "conflict"])
        # Simulate losing the winning acknowledgement and retrying its immutable request.
        with self.assertRaises(p.ConflictError):
            self.storage.apply_changes("1", changes)
        self.assertTrue(self.saved_state()["browser"]["accepted"])
        self.assertEqual(len(self.storage.history()["entries"]), 2)

    def test_ordinary_edit_work_does_not_hash_or_flatten_unrelated_data(self):
        measurements = []
        for unrelated in (0, 80):
            state = copy.deepcopy(STATE)
            state["templates"] = [{"payload": "untouched" * 500} for _ in range(unrelated)]
            state["history"]["s1"]["u"] = ["snapshot" * 1000 for _ in range(unrelated)]
            revision = self.storage.write(self.storage.read()["revision"], state)["revision"]
            real_flatten, real_decode = p.flatten, p.decode
            decoded, flattened = [], []
            def read(raw, decode=real_decode, visited=decoded):
                value = decode(raw)
                self.assertNotIn("untouched", repr(value))
                self.assertNotIn("snapshot", repr(value))
                visited.append(value)
                return value
            def flatten(value, visit=real_flatten, visited=flattened):
                visited.append(value)
                return visit(value)
            with patch.object(p, "inflate", side_effect=AssertionError("ordinary inflate")), \
                 patch.object(p, "flatten", side_effect=flatten), patch.object(p, "decode", side_effect=read), \
                 patch.object(p, "encode", wraps=p.encode) as encoded, patch.object(p.hashlib, "sha256", wraps=p.hashlib.sha256) as hashed:
                self.storage.apply_changes(revision, [set_value(["workbook", "sheets", 0, "name"], "Changed")])
                measurements.append((len(decoded), flattened, encoded.call_count, hashed.call_count))
        self.assertEqual(measurements[0], measurements[1])
        self.assertEqual(measurements[0][1], ["Changed"])
        self.assertEqual(measurements[0][3], 1)

    def test_unrelated_project_bodies_are_not_decoded_or_hashed(self):
        state = copy.deepcopy(STATE)
        for index in range(1, 20):
            sheet = copy.deepcopy(STATE["workbook"]["sheets"][0])
            sheet["id"] = f"s{index + 1}"
            sheet["data"]["tasks"] = [{"id": i, "name": "unrelated-project-body"} for i in range(1, 51)]
            state["workbook"]["sheets"].append(sheet)
        self.revision = self.storage.write(self.revision, state)["revision"]
        decode = p.decode
        def checked(raw):
            value = decode(raw)
            self.assertNotIn("unrelated-project-body", repr(value))
            return value
        with patch.object(p, "decode", side_effect=checked), patch.object(p.hashlib, "sha256", wraps=p.hashlib.sha256) as hashes:
            self.apply(set_value(["workbook", "sheets", 0, "name"], "First project edit"))
        self.assertEqual(hashes.call_count, 1)

    def test_subtree_lookup_uses_index_without_scanning_unrelated_rows(self):
        # Count SQLite VM instructions as well as returned nodes: a full scan can
        # return two rows and still hide all unrelated work from nodesVisited.
        costs = []
        for unrelated in (0, 20000):
            with closing(sqlite3.connect(':memory:')) as db:
                db.execute('CREATE TABLE current(path TEXT PRIMARY KEY, hash TEXT NOT NULL)')
                db.execute('CREATE TABLE workspace(id INTEGER PRIMARY KEY, bytes INTEGER NOT NULL)')
                db.execute('INSERT INTO workspace VALUES (1,0)')
                expected = [('/browser/a', 'root'), ('/browser/a/child', 'child')]
                rows = expected + [(f'/unrelated/{i}', 'other') for i in range(unrelated)] + [('/browser/ab', 'sibling'), ('/browser/a-b', 'before-slash'), ('/browser/a.x', 'before-slash'), ('/browser/a0', 'upper-bound'), ('/browser/A', 'case')]
                db.executemany('INSERT INTO current VALUES (?,?)', rows)
                transaction = p._PatchTransaction(db)
                steps = 0
                def progress():
                    nonlocal steps
                    steps += 1
                    return 0
                db.set_progress_handler(progress, 1)
                try:
                    self.assertEqual(sorted(transaction.rows('/browser/a')), expected)
                finally:
                    db.set_progress_handler(None, 0)
                costs.append(steps)
        self.assertLessEqual(costs[1], costs[0] + 20, costs)
        self.assertLess(costs[1], 100, costs)

    def test_small_edit_metrics_are_constant_with_1_or_100_projects(self):
        results = []
        for count in (1, 100):
            with tempfile.TemporaryDirectory() as directory:
                storage = p.ProjectStorage(directory)
                state = copy.deepcopy(STATE)
                first = state["workbook"]["sheets"][0]
                state["workbook"]["sheets"] = [{**copy.deepcopy(first), "id": f"s{i + 1}"} for i in range(count)]
                storage.write(None, state)
                result = storage.apply_changes("1", [set_value(["workbook", "sheets", 0, "name"], "Changed")])
                results.append(result["metrics"])
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0]["nodesHashed"], 1)
        self.assertEqual(results[0]["nodesWritten"], 1)

    def test_identity_changes_validate_unchanged_project_ids(self):
        second = copy.deepcopy(STATE["workbook"]["sheets"][0])
        second["id"] = "s2"
        self.apply(splice(["workbook", "sheets"], 1, 0, [second]))
        before = self.database_contents()
        for change in (set_value(["workbook", "sheets", 1, "id"], "s1"),
                       set_value(["workbook", "active"], "missing")):
            with self.assertRaises(ValueError):
                self.apply(change)
            self.assertEqual(self.database_contents(), before)
        self.apply(set_value(["workbook", "active"], "s2"))
        self.assertEqual(self.saved_state()["workbook"]["active"], "s2")

    def test_randomized_splice_set_remove_replay_and_accounting(self):
        rng = random.Random(781)
        expected = copy.deepcopy(STATE)
        for step in range(100):
            items = expected["templates"]
            start = rng.randrange(len(items) + 1)
            count = rng.randrange(len(items) - start + 1)
            added = [{"id": step, "nested/~": [rng.randrange(100), "Ω"]} for _ in range(rng.randrange(4))]
            changes = [splice(["templates"], start, count, added)]
            items[start:start + count] = added
            if step % 3:
                changes.append(set_value(["browser", "random"], step))
                expected["browser"]["random"] = step
            elif "random" in expected["browser"]:
                changes.append(remove(["browser", "random"]))
                del expected["browser"]["random"]
            self.apply(*changes)
            self.assertEqual(self.saved_state(), expected)
            self.assertEqual(self.storage.version(int(self.revision))["state"], expected)
            self.accounting()


class AccountingUpgradeTests(unittest.TestCase):
    def legacy(self, directory, state=STATE):
        storage = p.ProjectStorage(directory)
        storage.write(None, state)
        storage.apply_changes("1", [set_value(["preferences", "auto"], True)])
        with closing(sqlite3.connect(storage.path)) as db, db:
            db.execute("DROP TABLE workspace")
            db.execute("ALTER TABLE objects DROP COLUMN bytes")
            db.execute("PRAGMA user_version=1")
        return storage

    def test_upgrade_preserves_history_and_scans_only_once(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = self.legacy(directory)
            with patch.object(p, "inflate", wraps=p.inflate) as inflated:
                self.assertEqual(storage.read()["revision"], "2")
                self.assertEqual(inflated.call_count, 2, "one upgrade scan and one requested full read")
            with patch.object(p, "inflate", side_effect=AssertionError("upgrade repeated")):
                storage.apply_changes("2", [set_value(["preferences", "auto"], False)])
            self.assertEqual(storage.version(1)["state"], STATE)
            with closing(storage.connect()) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
                self.assertEqual(db.execute("SELECT bytes FROM workspace").fetchone()[0], len(p.json_bytes(STATE)))

    def test_concurrent_upgrade_and_empty_legacy_database(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = self.legacy(directory)
            with ThreadPoolExecutor(max_workers=2) as pool:
                states = list(pool.map(lambda _: p.ProjectStorage(directory).read(), range(2)))
            self.assertEqual(states[0], states[1])
            self.assertEqual(states[0]["revision"], "2")
            with closing(sqlite3.connect(storage.path)) as db, db:
                db.execute("DELETE FROM current")
                db.execute("DELETE FROM versions")
                db.execute("DROP TABLE workspace")
                db.execute("ALTER TABLE objects DROP COLUMN bytes")
                db.execute("PRAGMA user_version=1")
            self.assertEqual(storage.read(), {"revision": None, "state": None})
            with closing(storage.connect()) as db:
                self.assertEqual(db.execute("SELECT bytes FROM workspace").fetchone()[0], 0)
            self.assertEqual(storage.write(None, STATE)["revision"], "1")

    def test_failed_upgrade_rolls_back_schema_and_data(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = self.legacy(directory)
            with closing(sqlite3.connect(storage.path)) as db:
                before = db.execute("SELECT * FROM objects ORDER BY hash").fetchall()
            with patch.object(p, "node_bytes", side_effect=ValueError("injected accounting failure")), \
                 self.assertRaisesRegex(ValueError, "accounting failure"):
                storage.read()
            with closing(sqlite3.connect(storage.path)) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT * FROM objects ORDER BY hash").fetchall(), before)
                self.assertNotIn("workspace", [row[0] for row in db.execute("SELECT name FROM sqlite_master")])
            self.assertEqual(storage.read()["revision"], "2")


class PatchHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="Plan HTTP patch ")
        self.addCleanup(self.temp.cleanup)
        self.server = create_server(0, self.temp.name, native_files=False)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def request(self, body, endpoint="/api/projects/changes", headers=None):
        raw = body if isinstance(body, bytes) else p.json_bytes(body)
        status, _, response = http_request(self.server.server_port, endpoint, raw,
                                           {"Content-Type": "application/json", **(headers or {})})
        return status, json.loads(response)

    def test_bootstrap_patch_identity_stale_and_incompatible_full_client(self):
        status, result = self.request({"revision": None, "state": STATE}, "/api/projects")
        self.assertEqual(status, 200)
        identity = str((Path(self.temp.name) / "plan.db").resolve())
        self.assertEqual(result["dataFile"], identity)
        for endpoint in ("/api/health", "/api/projects"):
            self.assertEqual(json.loads(http_request(self.server.server_port, endpoint)[2])["dataFile"], identity)
        status, refused = self.request({"revision": "1", "state": STATE}, "/api/projects")
        self.assertEqual(status, 400)
        self.assertIn("bootstrap-only", refused["error"])
        self.assertEqual(refused["dataFile"], identity)
        status, result = self.request({"revision": "1", "changes": [set_value(["preferences", "auto"], True)]})
        self.assertEqual((status, result["revision"], result["dataFile"]), (200, "2", identity))
        self.assertEqual(self.request({"revision": "1", "changes": []})[0], 409)
        self.assertEqual(self.request({"revision": None, "state": STATE}, "/api/projects")[0], 409)

    def test_malformed_task_records_are_rejected_at_http_boundary(self):
        self.assertEqual(self.request({"revision": None, "state": STATE}, "/api/projects")[0], 200)
        for change in (set_value(["workbook", "sheets", 0, "data", "tasks", 0, "id"], "1"),
                       splice(["workbook", "sheets", 0, "data", "tasks"], 1, 0, [{"id": 1, "name": "Duplicate"}]),
                       set_value(["workbook", "sheets", 0, "data", "tasks", 0, "progress"], 150)):
            status, body = self.request({"revision": "1", "changes": [change]})
            self.assertEqual(status, 400, body)
        saved = json.loads(http_request(self.server.server_port, "/api/projects")[2])
        self.assertEqual((saved["revision"], saved["state"]), ("1", STATE))

    def test_strict_fields_duplicates_numbers_and_request_size(self):
        invalid = [b'{"revision":null,"revision":"1","changes":[]}',
                   b'{"revision":null,"changes":[],"extra":1}',
                   b'{"revision":true,"changes":[]}',
                   b'{"revision":null,"changes":[{"op":"set","path":["x"],"value":1e999}]}',
                   b'{"revision":null,"changes":[{"op":"set","path":["x"],"value":NaN}]}']
        for raw in invalid:
            self.assertEqual(self.request(raw)[0], 400)
        self.assertEqual(self.request({}, headers={"Content-Length": str(p.MAX_BYTES + 1)})[0], 413)
        self.assertEqual(self.request({}, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request({}, headers={"Origin": "https://other.example"})[0], 403)
        self.assertFalse((Path(self.temp.name) / "plan.db").exists())


if __name__ == "__main__":
    unittest.main()
