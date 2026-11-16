"""Isolated feasibility runner. Deliberately never reads projects or schedules them."""
import contextlib
import json
import signal
import sqlite3
import threading
import time
import uuid

from . import AgentError
from .auth import NativeAuth
from .protected import atomic_write, file_lock, private_root
from .registration import source_version


class ProbeLedger:
    """One-shot, explicitly queued self-tests; in-flight restarts are never replayed."""
    def __init__(self, root):
        self.path = root / "feasibility.sqlite3"
        with self.connection() as database:
            version = database.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, 1}:
                raise AgentError("ledger_version_unsupported", "This feasibility ledger requires a newer Plan version.")
            database.execute("CREATE TABLE IF NOT EXISTS probes (id TEXT PRIMARY KEY, account TEXT NOT NULL, created REAL NOT NULL, state TEXT NOT NULL, finished REAL, code TEXT, correlation TEXT)")
            database.execute("PRAGMA user_version=1")

    @contextlib.contextmanager
    def connection(self):
        with contextlib.closing(sqlite3.connect(self.path, timeout=5)) as database, database:
            yield database

    def queue(self, account):
        with self.connection() as database:
            database.execute("BEGIN IMMEDIATE")
            if database.execute("SELECT 1 FROM probes WHERE state IN ('pending', 'submitting', 'uncertain') LIMIT 1").fetchone():
                raise AgentError("probe_unresolved", "A test is pending or has an unknown outcome. Review activity and the test mailbox before requesting another.")
            identifier = str(uuid.uuid4())
            database.execute("INSERT INTO probes VALUES (?,?,?,'pending',NULL,NULL,NULL)", (identifier, account, time.time()))
            return {"state": "pending", "id": identifier}

    def recover(self):
        with self.connection() as database:
            database.execute("UPDATE probes SET state='uncertain', code='interrupted_submission', finished=? WHERE state='submitting'", (time.time(),))

    def claim(self):
        with self.connection() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute("SELECT id,account,created FROM probes WHERE state='pending' ORDER BY created LIMIT 1").fetchone()
            if not row:
                return None
            if time.time() - row[2] > 3600:
                database.execute("UPDATE probes SET state='expired', code='test_expired',finished=? WHERE id=?", (time.time(), row[0]))
                return None
            database.execute("UPDATE probes SET state='submitting' WHERE id=?", (row[0],))
            return row[:2]

    def finish(self, identifier, state, code=None, correlation=None):
        with self.connection() as database:
            database.execute("UPDATE probes SET state=?,code=?,correlation=?,finished=? WHERE id=? AND state='submitting'", (state, code, correlation, time.time(), identifier))

    def activity(self):
        with self.connection() as database:
            database.row_factory = sqlite3.Row
            return [dict(row) for row in database.execute("SELECT id,created,state,finished,code,correlation FROM probes ORDER BY created DESC LIMIT 20")]


def tick(root, ledger, auth_factory, expected_version=None):
    probe = ledger.claim()
    if not probe:
        return
    identifier, owner = probe
    try:
        if (root / "feasibility.paused").exists():
            raise AgentError("paused", "The feasibility task is paused.")
        auth = auth_factory()
        account = auth.status().get("account")
        if not account or json.dumps({k: account[k] for k in ("homeAccountId", "tenantId", "graphId")}, sort_keys=True) != owner:
            raise AgentError("account_mismatch", "This test belongs to a different native account.")
        result = auth.send_test(expected_binding=json.loads(owner), can_submit=lambda: not (root / "feasibility.paused").exists() and (expected_version is None or source_version() == expected_version))
        ledger.finish(identifier, "accepted", correlation=result.get("correlationId"))
    except AgentError as error:
        ledger.finish(identifier, "uncertain" if error.code == "uncertain" else "failed", code=error.code)
    # Unexpected exceptions/crashes intentionally leave 'submitting' for recovery.


def run(data_dir, expected_version, *, root=None, auth_factory=None, stop=None):
    root = root if root is not None else private_root(data_dir)
    auth_factory = auth_factory or (lambda: NativeAuth(data_dir))
    stop = stop or threading.Event()
    try:
        with file_lock(root / "feasibility-worker.lock", timeout=0):
            ledger = ProbeLedger(root)
            ledger.recover()
            while not stop.is_set():
                if (root / "feasibility.paused").exists():
                    break
                if source_version() != expected_version:
                    atomic_write(root / "feasibility-health.json", json.dumps({"state": "source_changed", "heartbeat": time.time()}).encode())
                    break
                tick(root, ledger, auth_factory, expected_version=expected_version)
                atomic_write(root / "feasibility-health.json", json.dumps({"state": "feasibility_only", "heartbeat": time.time(), "sourceVersion": expected_version}).encode())
                stop.wait(60)
    except AgentError as error:
        if error.code != "connection_busy":
            raise


def install_signals(stop):
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            with contextlib.suppress(ValueError, OSError):
                signal.signal(getattr(signal, name), lambda *_: stop.set())
