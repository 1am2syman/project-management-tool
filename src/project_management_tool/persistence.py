"""Single-file SQLite state and retained, deduplicated version history."""
import contextlib
import ctypes
import hashlib
import json
import os
import sqlite3
import uuid
import zlib
from datetime import datetime
from pathlib import Path

APP_ID = 0x504C414E
MAX_BYTES = 64 * 1024 * 1024


def default_data_dir():
    if os.name == "nt":
        # FOLDERID_Documents resolves redirected/OneDrive Documents and Unicode paths.
        folder_id = (ctypes.c_byte * 16).from_buffer_copy(uuid.UUID("fdd39ad0-238f-46af-adb4-6c85480369c7").bytes_le)
        result = ctypes.c_wchar_p()
        shell = ctypes.WinDLL("shell32", use_last_error=True)
        shell.SHGetKnownFolderPath.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
        shell.SHGetKnownFolderPath.restype = ctypes.c_long
        ole = ctypes.WinDLL("ole32", use_last_error=True)
        ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole.CoTaskMemFree.restype = None
        try:
            status = shell.SHGetKnownFolderPath(ctypes.byref(folder_id), 0, None, ctypes.byref(result))
            if status != 0 or not result.value:
                raise OSError("Windows could not locate Documents; choose a folder with --data-dir")
            return Path(result.value) / "Plan"
        finally:
            if result:
                ole.CoTaskMemFree(ctypes.cast(result, ctypes.c_void_p))
    return Path.home() / "Documents" / "Plan"


def reject_constant(value):
    raise ValueError(f"Invalid JSON number: {value}")


def validate_state(state):
    if not isinstance(state, dict) or not isinstance(state.get("workbook"), dict):
        raise ValueError("Expected a workbook")
    workbook = state["workbook"]
    sheets = workbook.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        raise ValueError("A workbook must contain at least one project")
    ids = set()
    for sheet in sheets:
        if not isinstance(sheet, dict) or not isinstance(sheet.get("id"), str) or sheet["id"] in ids:
            raise ValueError("Each project must have a unique ID")
        ids.add(sheet["id"])
        data = sheet.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("tasks"), list) or not isinstance(data.get("links"), list):
            raise ValueError("Each project must contain tasks and relationships")
    if workbook.get("active") not in ids:
        raise ValueError("The active project does not exist")
    for key, kind in [("templates", list), ("preferences", dict), ("history", dict), ("browser", dict)]:
        if key in state and not isinstance(state[key], kind):
            raise ValueError(f"Invalid {key}")


def encode(value):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    compressed = zlib.compress(raw) if len(raw) > 256 else raw
    return b"z" + compressed if len(compressed) < len(raw) else b"j" + raw


def decode(raw):
    try:
        data = zlib.decompress(raw[1:]) if raw[:1] == b"z" else raw[1:]
        return json.loads(data, parse_constant=reject_constant)
    except (ValueError, UnicodeError, zlib.error) as e:
        raise ValueError("The saved app state is damaged") from e


def flatten(state):
    """Small independently updated nodes; identical undo snapshots share one blob."""
    nodes = {}
    def visit(value, path):
        if isinstance(value, dict):
            nodes[path] = ["object", list(value)]
            for key, child in value.items():
                visit(child, path + "/" + str(key).replace("~", "~0").replace("/", "~1"))
        elif isinstance(value, list):
            nodes[path] = ["array", len(value)]
            for index, child in enumerate(value):
                visit(child, path + "/" + str(index))
        else:
            nodes[path] = ["value", value]
    visit(state, "")
    return nodes


def inflate(nodes):
    def visit(path):
        kind, value = nodes[path]
        if kind == "object":
            return {key: visit(path + "/" + key.replace("~", "~0").replace("/", "~1")) for key in value}
        if kind == "array":
            return [visit(path + "/" + str(index)) for index in range(value)]
        if kind == "value":
            return value
        raise ValueError("Unknown saved value format")
    try:
        return visit("")
    except (KeyError, TypeError, RecursionError) as e:
        raise ValueError("The saved app state is incomplete") from e


class ConflictError(Exception):
    pass


class RevisionConflict(ConflictError):
    """The workspace revision moved after a file operation was authorized against it. No file bytes were written."""


class ProjectStorage:
    def __init__(self, directory):
        self.path = Path(directory).resolve() / "plan.db"

    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        try:
            identity = db.execute("PRAGMA application_id").fetchone()[0]
            if identity == 0:
                db.execute("BEGIN IMMEDIATE")
                # Another process may have initialized this file while we waited for its lock.
                identity = db.execute("PRAGMA application_id").fetchone()[0]
                if identity == 0:
                    if db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                        raise ValueError("This SQLite file belongs to another application")
                    db.execute("CREATE TABLE objects (hash TEXT PRIMARY KEY, value BLOB NOT NULL)")
                    db.execute("CREATE TABLE current (path TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES objects(hash))")
                    db.execute("CREATE TABLE versions (revision INTEGER PRIMARY KEY, created TEXT NOT NULL, summary TEXT NOT NULL, changes BLOB NOT NULL, snapshot BLOB)")
                    db.execute("PRAGMA application_id=1347174734")
                    db.execute("PRAGMA user_version=1")
                db.commit()
                identity = db.execute("PRAGMA application_id").fetchone()[0]
            if identity != APP_ID or db.execute("PRAGMA user_version").fetchone()[0] != 1:
                raise ValueError("Unknown Plan database format; keep the original file")
            # DELETE mode leaves no permanent -wal/-shm files. FULL synchronizes commits to disk.
            db.execute("PRAGMA journal_mode=DELETE")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA foreign_keys=ON")
            return db
        except Exception:
            db.close()
            raise

    @staticmethod
    def revision(db):
        value = db.execute("SELECT MAX(revision) FROM versions").fetchone()[0]
        return str(value) if value is not None else None

    def read(self):
        with contextlib.closing(self.connect()) as db:
            db.execute("BEGIN")
            revision = self.revision(db)
            if revision is None:
                return {"revision": None, "state": None}
            nodes = {path: decode(value) for path, value in db.execute("SELECT c.path,o.value FROM current c JOIN objects o ON o.hash=c.hash")}
            state = inflate(nodes)
            validate_state(state)
            return {"revision": revision, "state": state}

    def write(self, revision, state):
        validate_state(state)
        if len(json.dumps(state, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_BYTES:
            raise ValueError("App state exceeds the 64 MB save request limit")
        nodes = flatten(state)
        objects = {path: encode(node) for path, node in nodes.items()}
        hashes = {path: hashlib.sha256(value).hexdigest() for path, value in objects.items()}
        with contextlib.closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")  # serializes writers across threads AND server processes
            current_revision = self.revision(db)
            if current_revision != revision:
                raise ConflictError("App state changed in another window. Reload before editing.")
            old = dict(db.execute("SELECT path,hash FROM current"))
            changes = {path: [old.get(path), hashes.get(path)] for path in old.keys() | hashes.keys() if old.get(path) != hashes.get(path)}
            if not changes:
                return {"revision": current_revision}
            new_revision = int(current_revision or 0) + 1
            inserts = {hashes[path]: objects[path] for path, (_, new) in changes.items() if new is not None}
            for digest, value in inserts.items():
                db.execute("INSERT OR IGNORE INTO objects(hash,value) VALUES (?,?)", (digest, value))
            db.executemany("DELETE FROM current WHERE path=?", [(path,) for path, (_, new) in changes.items() if new is None])
            db.executemany("INSERT OR REPLACE INTO current(path,hash) VALUES (?,?)", [(path, new) for path, (_, new) in changes.items() if new is not None])
            if current_revision is None:
                summary = "Initial app state"
            elif any("/tasks/" in path for path in changes):
                summary = "Edited tasks"
            elif any("/links/" in path for path in changes):
                summary = "Edited relationships"
            elif any(path.startswith("/workbook/sheets/") and "/versions" in path for path in changes):
                summary = "Updated project versions"
            elif any(path.startswith("/workbook") for path in changes):
                summary = "Updated projects"
            elif any(path.startswith("/templates") for path in changes):
                summary = "Updated templates"
            else:
                summary = "Updated app settings or activity"
            snapshot = encode(hashes) if new_revision == 1 or new_revision % 50 == 0 else None
            db.execute("INSERT INTO versions VALUES (?,?,?,?,?)", (new_revision, datetime.now().astimezone().isoformat(), summary, encode(changes), snapshot))
            return {"revision": str(new_revision)}

    @contextlib.contextmanager
    def file_authorization(self, row):
        """Hold the same SQLite writer lock used by workspace saves during file commit."""
        with contextlib.closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                if self.revision(db) != row['revision']:
                    raise RevisionConflict('App state changed in another window. Reload before saving.')
                nodes = {path: decode(value) for path, value in db.execute(
                    'SELECT c.path,o.value FROM current c JOIN objects o ON o.hash=c.hash')}
                state: dict = inflate(nodes)  # type: ignore[assignment]
                validate_state(state)
                sheet = next((item for item in state['workbook']['sheets'] if item['id'] == row['sheet']), None)
                if not sheet:
                    raise ConflictError('The project no longer exists.')
                if row['kind'] == 'save':
                    if sheet.get('readOnly') or sheet.get('fileToken') != row['token']:
                        raise ConflictError('This project is read-only or no longer connected to that file.')
                elif row.get('source_token') != sheet.get('fileToken'):
                    raise ConflictError('The project file connection changed.')
                yield sheet
            finally:
                db.rollback()

    @contextlib.contextmanager
    def file_attach_authorization(self, sheet_id, token, revision):
        with contextlib.closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                if self.revision(db) != revision:
                    raise RevisionConflict('App state changed in another window.')
                nodes = {path: decode(value) for path, value in db.execute(
                    'SELECT c.path,o.value FROM current c JOIN objects o ON o.hash=c.hash')}
                state: dict = inflate(nodes)  # type: ignore[assignment]
                validate_state(state)
                sheet = next((item for item in state['workbook']['sheets'] if item['id'] == sheet_id), None)
                if not sheet or sheet.get('fileToken') != token:
                    raise ConflictError('The project connection is not saved in this workspace.')
                yield
            finally:
                db.rollback()

    def history(self, before=None, limit=50):
        with contextlib.closing(self.connect()) as db:
            rows = db.execute("SELECT revision,created,summary FROM versions WHERE revision < ? ORDER BY revision DESC LIMIT ?", (before if before is not None else 2**63 - 1, limit + 1)).fetchall()
            return {"entries": [{"revision": str(rev), "at": created, "summary": summary} for rev, created, summary in rows[:limit]], "more": len(rows) > limit}

    def version(self, revision):
        with contextlib.closing(self.connect()) as db:
            db.execute("BEGIN")
            if not db.execute("SELECT 1 FROM versions WHERE revision=?", (revision,)).fetchone():
                raise LookupError("Saved version does not exist")
            base, snapshot = db.execute("SELECT revision,snapshot FROM versions WHERE revision<=? AND snapshot IS NOT NULL ORDER BY revision DESC LIMIT 1", (revision,)).fetchone()
            hashes = decode(snapshot)
            for (changes,) in db.execute("SELECT changes FROM versions WHERE revision>? AND revision<=? ORDER BY revision", (base, revision)):
                for path, (_, new) in decode(changes).items():
                    if new is None:
                        hashes.pop(path, None)
                    else:
                        hashes[path] = new
            values = {}
            for key in set(hashes.values()):
                row = db.execute("SELECT value FROM objects WHERE hash=?", (key,)).fetchone()
                if row is None:
                    raise ValueError("The saved version is incomplete")
                values[key] = decode(row[0])
            state = inflate({path: values[key] for path, key in hashes.items()})
            validate_state(state)
            return {"revision": str(revision), "state": state}
