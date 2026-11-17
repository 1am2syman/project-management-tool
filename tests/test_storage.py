"""SQLite, history and launcher integration tests; standard library only."""
import copy
import json
import queue
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.project_management_tool import MAX_BYTES, create_server
from src.project_management_tool import persistence as persistence

ROOT = Path(__file__).resolve().parents[1]
STATE = {"workbook": {"active": "s1", "nextSheet": 2, "sheets": [
    {"id": "s1", "name": "Project Ω", "data": {"tasks": [{"id": 1, "name": "Saved task"}], "links": []}}
]}, "templates": [], "preferences": {"auto": False, "critical": True},
    "history": {"s1": {"u": [], "r": []}}, "browser": {"pm-density": "roomy"}}


def http_request(port, path="/api/projects", body=None, headers=None):
    # Fixed loopback host and numeric port: these tests cannot open file/custom URL schemes.
    with closing(HTTPConnection("127.0.0.1", int(port), timeout=5)) as connection:
        connection.request("POST" if body is not None else "GET", path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.headers, response.read()


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="Plan projects ")
        self.directory = Path(self.temp.name) / "data"
        self.start_server()

    def start_server(self):
        self.server = create_server(0, self.directory, native_files=False)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def tearDown(self):
        self.stop_server()
        self.temp.cleanup()

    def request(self, body=None, *, headers=None, path="/api/projects"):
        raw = json.dumps(body).encode() if body is not None else None
        status, _, response = http_request(self.server.server_port, path, raw, {"Content-Type": "application/json", **(headers or {})})
        return status, json.loads(response)

    def test_removed_integration_routes_assets_and_launcher_options_are_unavailable(self):
        port = self.server.server_port
        for path in ['/api/native/status', '/api/reminder-feasibility/status', '/m365.config.json', '/redirect.html', '/reminder-feasibility.html', '/js/m365.js', '/vendor/msal-browser.min.js']:
            with self.subTest(path=path):
                self.assertEqual(http_request(port, path)[0], 404)
        for path in ['/api/native/connect', '/api/native/install', '/api/native/mail-send', '/api/reminder-feasibility/install']:
            self.assertEqual(http_request(port, path, b'{}', {'Content-Type': 'application/json'})[0], 404)
        self.assertFalse((self.directory / 'plan.db').exists())
        result = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'start.py'), '--help'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        for option in ['reminder-feasibility', 'background-setup', 'production', 'browser-only-test']:
            self.assertNotIn(option, result.stdout)

    def test_legacy_metadata_roundtrips_as_inert_local_data(self):
        state = copy.deepcopy(STATE)
        state['browser'].update({'pm-reminder-owner-v2': 'native-v1', 'pm-rem-ledger-v1:test@example.com': '{"old":"record"}'})
        state['workbook']['sheets'][0]['rem'] = {'on': True, 'auto': True, 'timezone': 'UTC'}
        self.assertEqual(self.request({'revision': None, 'state': state})[0], 200)
        self.assertEqual(self.request()[1]['state'], state)
        self.assertEqual(self.request(path='/api/history')[1]['entries'][0]['revision'], '1')
        self.assertEqual({p.name for p in self.directory.iterdir()}, {'plan.db'})

    def test_runtime_diagnostics_describes_build_without_reading_or_exposing_user_data(self):
        self.assertFalse((self.directory / "plan.db").exists())
        status, result = self.request(path="/api/diagnostics")
        self.assertEqual(status, 200)
        self.assertEqual(result["app"], "plan-local")
        self.assertRegex(result["sourceFingerprint"], r"^[a-f0-9]{64}$")
        self.assertEqual(result["python"]["bitness"], 64 if sys.maxsize > 2**32 else 32)
        self.assertIn("version", result["python"])
        self.assertIn("system", result["operatingSystem"])
        self.assertEqual(result["sqliteVersion"], sqlite3.sqlite_version)
        self.assertFalse((self.directory / "plan.db").exists(), "diagnostics cannot initialize or modify project storage")
        raw = json.dumps(result)
        for private in [str(self.directory), str(ROOT), str(Path.home()), str(Path(sys.executable))]:
            self.assertNotIn(private, raw)
        self.assertEqual(self.request(path="/api/diagnostics")[1]["sourceFingerprint"], result["sourceFingerprint"])
        fake_web = Path(self.temp.name) / "private-installation" / "web"
        (fake_web / "js").mkdir(parents=True)
        script = fake_web / "js" / "main.js"
        script.write_text("first build", encoding="utf-8")
        with patch("src.project_management_tool.WEB", fake_web):
            first = self.request(path="/api/diagnostics")[1]
            script.write_text("second build", encoding="utf-8")
            second = self.request(path="/api/diagnostics")[1]
        self.assertNotEqual(first["sourceFingerprint"], second["sourceFingerprint"])
        self.assertNotIn("private-installation", json.dumps(second))

    def test_round_trip_and_server_restart(self):
        status, empty = self.request()
        self.assertEqual(status, 200)
        self.assertEqual((empty["revision"], empty["state"]), (None, None))
        self.assertEqual(empty["dataFile"], str(self.directory / "plan.db"))
        status, saved = self.request({"revision": None, "state": STATE})
        self.assertEqual(status, 200)
        self.assertEqual(saved["revision"], "1")
        self.stop_server()
        self.start_server()
        status, loaded = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(loaded["state"], STATE)
        self.assertEqual(loaded["revision"], saved["revision"])
        self.assertEqual((self.directory / "plan.db").read_bytes()[:16], b"SQLite format 3\x00")

    def test_single_permanent_file_and_deduplicated_compressed_history(self):
        state = copy.deepcopy(STATE)
        snapshot = json.dumps({"tasks": [{"id": 1, "name": "Example task " * 100}], "links": []})
        state["history"]["s1"]["u"] = [snapshot, snapshot]
        _, first = self.request({"revision": None, "state": state})
        state["workbook"]["sheets"][0]["name"] = "Changed"
        self.assertEqual(self.request({**first, "state": state})[0], 200)
        self.assertEqual([path.name for path in self.directory.iterdir()], ["plan.db"])
        with closing(sqlite3.connect(self.directory / "plan.db")) as db, db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")
            rows = db.execute("SELECT hash FROM current WHERE path LIKE '/history/s1/u/%'").fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0], rows[1])
            blob = db.execute("SELECT value FROM objects WHERE hash=?", rows[0]).fetchone()[0]
            self.assertEqual(blob[:1], b"z")
            self.assertLess(len(blob), len(snapshot.encode()))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM versions").fetchone()[0], 2)

    def test_history_reconstructs_changes_deletions_and_checkpoints(self):
        storage = persistence.ProjectStorage(self.directory)
        revision = None
        versions = []
        for index in range(55):
            state = copy.deepcopy(STATE)
            state["workbook"]["sheets"][0]["name"] = f"Version {index}"
            state["browser"]["pm-special/~key"] = f"Value {index}"
            if index % 2:
                state["templates"] = [{"name": "Template", "tasks": []}]
            result = storage.write(revision, state)
            revision = result["revision"]
            versions.append(state)
        for index in [1, 2, 25, 49, 50, 51, 55]:
            self.assertEqual(storage.version(index)["state"], versions[index - 1])
        status, first = self.request(path="/api/history")
        self.assertEqual(status, 200)
        self.assertEqual(len(first["entries"]), 50)
        self.assertTrue(first["more"])
        _, second = self.request(path="/api/history?before=" + first["entries"][-1]["revision"])
        self.assertEqual(len(second["entries"]), 5)
        self.assertFalse(second["more"])
        self.assertEqual(self.request(path="/api/history/1")[1]["state"], versions[0])
        self.assertEqual(self.request(path="/api/history/999")[0], 404)
        self.assertEqual(storage.read()["state"], versions[-1])

    def test_saved_project_versions_are_stored_once_and_named_in_history(self):
        storage = persistence.ProjectStorage(self.directory)
        revision = storage.write(None, STATE)["revision"]
        state = copy.deepcopy(STATE)
        plan = json.dumps(state["workbook"]["sheets"][0]["data"])
        state["workbook"]["sheets"][0]["versions"] = [{"id": "v1", "n": 1, "name": "Baseline", "note": "", "at": 1, "by": "", "auto": False, "target": None, "data": plan}]
        state["workbook"]["sheets"][0]["nextVersion"] = 2
        revision = storage.write(revision, state)["revision"]
        self.assertEqual(storage.history()["entries"][0]["summary"], "Updated project versions")
        self.assertEqual(storage.read()["state"], state)
        state = copy.deepcopy(state)
        state["workbook"]["sheets"][0]["data"]["tasks"][0]["name"] = "Edited after the snapshot"
        storage.write(revision, state)
        self.assertEqual(storage.history()["entries"][0]["summary"], "Edited tasks")
        with closing(sqlite3.connect(storage.path)) as db:
            stored = [persistence.decode(value) for (value,) in db.execute("SELECT value FROM objects")]
        self.assertEqual(sum(1 for value in stored if value == ["value", plan]), 1)

    def test_stale_revision_cannot_overwrite_newer_save(self):
        self.request({"revision": None, "state": STATE})
        self.assertEqual(self.request({"revision": None, "state": STATE})[0], 409)
        self.assertEqual(self.request()[1]["state"], STATE)
        self.assertEqual(len(self.request(path="/api/history")[1]["entries"]), 1)

    def test_concurrent_independent_connections_have_one_winner(self):
        persistence.ProjectStorage(self.directory).read()
        def save(index):
            state = copy.deepcopy(STATE)
            state["workbook"]["sheets"][0]["name"] = f"Writer {index}"
            return self.request({"revision": None, "state": state})[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(save, [1, 2])), [200, 409])

    def test_separate_processes_cannot_both_overwrite_the_same_revision(self):
        persistence.ProjectStorage(self.directory).read()
        script = f"import sys; sys.path.insert(0, {str(ROOT)!r})\n" + """import json,sys
from src.project_management_tool.persistence import ProjectStorage, ConflictError
try:
 ProjectStorage(sys.argv[1]).write(None,json.loads(sys.argv[2]))
 print('SAVED')
except ConflictError:
 print('CONFLICT')
"""
        def save(_):
            return subprocess.run([sys.executable, "-c", script, str(self.directory), json.dumps(STATE)], cwd=ROOT, capture_output=True, text=True, timeout=10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, [1, 2]))
        self.assertTrue(all(result.returncode == 0 for result in results), [result.stderr for result in results])
        self.assertEqual(sorted(result.stdout.strip() for result in results), ["CONFLICT", "SAVED"])

    def test_invalid_writes_preserve_saved_state(self):
        _, saved = self.request({"revision": None, "state": STATE})
        for state in [None, {}, {"workbook": {"sheets": []}}, {**STATE, "templates": "invalid"},
                      {**STATE, "history": []}, {**STATE, "workbook": {**STATE["workbook"], "active": "missing"}}]:
            self.assertEqual(self.request({**saved, "state": state})[0], 400)
            self.assertEqual(self.request()[1]["state"], STATE)
        self.assertEqual(self.request({**saved, "state": STATE}, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request({**saved, "state": STATE}, headers={"Origin": "https://unrelated.example"})[0], 403)
        self.assertEqual(self.request({**saved, "state": STATE}, headers={"Origin": self.url})[0], 200)

    def test_corrupt_file_is_not_replaced(self):
        self.directory.mkdir()
        path = self.directory / "plan.db"
        path.write_bytes(b"broken SQLite file")
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(self.request({"revision": None, "state": STATE})[0], 503)
        self.assertEqual(path.read_bytes(), b"broken SQLite file")

    def test_foreign_sqlite_file_is_not_adopted(self):
        self.directory.mkdir()
        with closing(sqlite3.connect(self.directory / "plan.db")) as db, db:
            db.execute("CREATE TABLE other_app(secret TEXT)")
            db.execute("INSERT INTO other_app VALUES ('keep me')")
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(self.request({"revision": None, "state": STATE})[0], 400)
        with closing(sqlite3.connect(self.directory / "plan.db")) as db, db:
            self.assertEqual(db.execute("SELECT secret FROM other_app").fetchone()[0], "keep me")

    def test_failed_transaction_rolls_back_state_and_history(self):
        _, saved = self.request({"revision": None, "state": STATE})
        with closing(sqlite3.connect(self.directory / "plan.db")) as db, db:
            db.execute("CREATE TRIGGER fail_save BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'Simulated write failure'); END")
        changed = copy.deepcopy(STATE)
        changed["workbook"]["sheets"][0]["name"] = "Must roll back"
        self.assertEqual(self.request({**saved, "state": changed})[0], 503)
        self.assertEqual(self.request()[1]["state"], STATE)
        self.assertEqual(self.request(path="/api/history")[1]["entries"][0]["revision"], saved["revision"])
        with closing(sqlite3.connect(self.directory / "plan.db")) as db, db:
            db.execute("DROP TRIGGER fail_save")
        self.assertEqual(self.request({**saved, "state": changed})[0], 200)

    def test_parameterized_values_cannot_become_sql(self):
        state = copy.deepcopy(STATE)
        state["workbook"]["sheets"][0]["name"] = "'); DROP TABLE versions; --"
        self.assertEqual(self.request({"revision": None, "state": state})[0], 200)
        self.assertEqual(self.request()[1]["state"], state)
        self.assertEqual(len(self.request(path="/api/history")[1]["entries"]), 1)

    def test_oversized_and_malformed_requests_are_rejected(self):
        for raw, headers, code in [
            (b"{}", {"Content-Length": str(MAX_BYTES + 1)}, 413),
            (b'{"revision":null,"state":NaN}', {}, 400),
        ]:
            status, _, _ = http_request(self.server.server_port, body=raw, headers={"Content-Type": "application/json", **headers})
            self.assertEqual(status, code)
        self.assertFalse((self.directory / "plan.db").exists())

    def test_javascript_mime_and_database_not_served_as_static_file(self):
        status, headers, _ = http_request(self.server.server_port, "/js/storage.js")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/javascript")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(http_request(self.server.server_port, "/plan.db")[0], 404)

    def test_isolated_source_launcher_from_path_with_spaces_and_second_launch_reuse(self):
        with tempfile.TemporaryDirectory(prefix="Plan copy with spaces ") as destination:
            root = Path(destination)
            shutil.copy(ROOT / "start.py", root)
            shutil.copytree(ROOT / "src", root / "src", ignore=shutil.ignore_patterns("__pycache__"))
            python = ROOT / "runtime/windows-x64/python.exe" if sys.platform == "win32" else sys.executable
            args = [str(python), "-I", "-B", str(root / "start.py"), "--no-open", "--file-access", "off", "--data-dir", str(self.directory), "--port"]
            proc = subprocess.Popen([*args, "0"], cwd=self.temp.name, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                lines = queue.Queue()
                assert proc.stdout is not None
                output = proc.stdout
                threading.Thread(target=lambda: lines.put(output.readline()), daemon=True).start()
                first = lines.get(timeout=10)
                self.assertTrue(first.startswith("Plan is running: http://127.0.0.1:"), first)
                url = first.split("Plan is running: ", 1)[1].strip()
                port = url.rsplit(":", 1)[1].strip("/")
                status, _, raw = http_request(port, "/api/health")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(raw)["dataFile"], str(self.directory / "plan.db"))
                body = json.dumps({"revision": None, "state": STATE}).encode()
                status, _, raw = http_request(port, body=body, headers={"Content-Type": "application/json"})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(raw)["revision"], "1")
                status, _, raw = http_request(port)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(raw)["state"], STATE)
                self.assertEqual(http_request(port, "/js/main.js")[0], 200)
                second = subprocess.run([*args, port], cwd=self.temp.name, capture_output=True, text=True, timeout=10)
                self.assertEqual(second.returncode, 0, second.stderr)
                self.assertIn("already running", second.stdout)
            finally:
                proc.terminate()
                proc.communicate(timeout=10)

    def test_windows_documents_uses_known_folder_and_frees_pointer(self):
        documents = str(Path(self.temp.name) / "OneDrive redirected Documents Ω")
        def known_folder(folder_id, flags, token, result):
            result._obj.value = documents
            return 0
        shell = SimpleNamespace(SHGetKnownFolderPath=Mock(side_effect=known_folder))
        ole = SimpleNamespace(CoTaskMemFree=Mock())
        with patch.object(persistence, "os", SimpleNamespace(name="nt")), patch.object(persistence.ctypes, "WinDLL", create=True, side_effect=[shell, ole]):
            self.assertEqual(persistence.default_data_dir(), Path(documents) / "Plan")
        shell.SHGetKnownFolderPath.assert_called_once()
        ole.CoTaskMemFree.assert_called_once()


if __name__ == "__main__":
    unittest.main()
