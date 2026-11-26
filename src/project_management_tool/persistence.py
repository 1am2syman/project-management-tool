"""Single-file SQLite state and retained, deduplicated version history."""
import contextlib
import ctypes
import hashlib
import json
import math
import os
import re
import sqlite3
import uuid
import zlib
from datetime import datetime
from pathlib import Path
from typing import cast

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


MAX_DEPTH = 128
MAX_CHANGES = 10000


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def validate_json(value):
    """Reject Python-only values, ambiguous keys, non-finite numbers and excessive depth."""
    stack = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        if depth > MAX_DEPTH:
            raise ValueError("JSON nesting exceeds the 128-level limit")
        kind = type(item)
        if kind is dict:
            if any(type(key) is not str for key in item):
                raise ValueError("JSON object keys must be strings")
            stack.extend((child, depth + 1) for child in item.values())
        elif kind is list:
            stack.extend((child, depth + 1) for child in item)
        elif kind not in (str, int, float, bool, type(None)):
            raise ValueError("Expected JSON values")
        elif kind is float and not math.isfinite(item):
            raise ValueError("Invalid JSON number")
    # Also validates UTF-8 strings (including object keys) and JSON integer encoding limits.
    return len(json_bytes(value))


def validate_revision(revision):
    if revision is not None and (type(revision) is not str or not revision.isascii()
            or not revision.isdigit() or revision.startswith("0") or len(revision) > 19
            or int(revision) >= 2**63):
        raise ValueError("Expected a canonical saved revision string or null")


def child_path(path, segment):
    return path + "/" + str(segment).replace("~", "~0").replace("/", "~1")


def node_bytes(node):
    """Contribution to compact logical JSON, independent of compression and path location."""
    kind, value = node
    if kind == "object":
        return 2 + max(0, len(value) - 1) + sum(len(json_bytes(key)) + 1 for key in value)
    if kind == "array":
        return 2 + max(0, value - 1)
    if kind == "value":
        return len(json_bytes(value))
    raise ValueError("Unknown saved value format")


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON object member")
        result[key] = value
    return result


JS_SAFE_INTEGER = 2**53 - 1
DAY_LIMIT = 99999999


def integer(value, minimum=0, maximum=JS_SAFE_INTEGER):
    return type(value) in (int, float) and minimum <= value <= maximum and value == int(value)


def validate_task(task):
    """Sparse legacy defaults and unknown fields remain inert; provided fields are never coerced."""
    if type(task) is not dict or not integer(task.get("id"), 1):
        raise ValueError("Task IDs must be positive safe integers")
    for key, limit in [("name", 200), ("owner", 80), ("email", 254), ("notes", 2000)]:
        if key in task and (type(task[key]) is not str or len(task[key].encode("utf-16-le")) // 2 > limit):
            raise ValueError("Invalid task " + key)
    if type(task.get("name")) is not str or not task["name"].strip():
        raise ValueError("Tasks must have a nonempty name")
    if task.get("email") and not re.fullmatch(r'[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+', task["email"]):
        raise ValueError("Invalid task email")
    for key in ("ms", "noRem", "inc"):
        if key in task and type(task[key]) is not bool:
            raise ValueError("Invalid task " + key)
    for key, low, high in [("level", 0, JS_SAFE_INTEGER), ("start", -DAY_LIMIT, DAY_LIMIT),
                           ("dur", 0 if task.get("ms") else 1, DAY_LIMIT), ("progress", 0, 100),
                           ("actualStart", -DAY_LIMIT, DAY_LIMIT), ("actualEnd", -DAY_LIMIT, DAY_LIMIT)]:
        if key in task and not integer(task[key], low, high):
            raise ValueError("Invalid task " + key)
    if task.get("ms") and (("dur" in task and task["dur"] != 0) or "actualEnd" in task):
        raise ValueError("Milestones require zero duration and cannot have an actual finish")
    if "actualStart" in task and "actualEnd" in task and task["actualEnd"] < task["actualStart"]:
        raise ValueError("Actual finish cannot precede actual start")
    if "scheduling" in task and task["scheduling"] not in ("auto", "manual", "anchor"):
        raise ValueError("Invalid task scheduling mode")
    if "agr" in task:
        agreed = task["agr"]
        if (type(agreed) is not dict or not all(integer(agreed.get(key), -DAY_LIMIT, DAY_LIMIT) for key in ("s", "f", "o"))
                or "inc" in task):
            raise ValueError("Invalid task agreed dates")
    if "inc" in task and task["inc"] is not True:
        raise ValueError("Invalid task inclusion flag")
    if "calendar" in task:
        validate_calendar(task["calendar"])


def validate_calendar(calendar):
    if type(calendar) is not dict:
        raise ValueError("Invalid working calendar")
    days, holidays = calendar.get("workdays"), calendar.get("holidays")
    if (type(days) is not list or not days or any(not integer(day, 0, 6) for day in days)
            or len(set(days)) != len(days) or type(holidays) is not list or len(holidays) > 10000):
        raise ValueError("Invalid working calendar")
    dates = set()
    for holiday in holidays:
        if type(holiday) is not dict or type(holiday.get("date")) is not str or type(holiday.get("name")) is not str:
            raise ValueError("Invalid working calendar holiday")
        day = holiday["date"]
        try:
            parsed = datetime.strptime(day, "%Y-%m-%d")
        except ValueError as error:
            raise ValueError("Invalid working calendar holiday") from error
        if parsed.strftime("%Y-%m-%d") != day or day in dates or len(holiday["name"]) > 100:
            raise ValueError("Invalid working calendar holiday")
        dates.add(day)


def validate_link(link):
    if type(link) is not dict:
        raise ValueError("Relationships must be objects")
    identity = link.get("id")
    if (type(identity) is not str or not re.fullmatch(r"l[1-9][0-9]{0,15}", identity)
            or not integer(int(identity[1:]), 1)):
        raise ValueError("Relationship IDs must use a positive safe lN identifier")
    if not integer(link.get("from"), 1) or not integer(link.get("to"), 1):
        raise ValueError("Relationship endpoints must be positive safe task IDs")
    if link.get("type") not in ("FS", "SS", "FF", "SF") or not integer(link.get("lag"), -DAY_LIMIT, DAY_LIMIT):
        raise ValueError("Invalid relationship type or lag")


def validate_relations(tasks, links, next_id=None, next_link=None):
    ids, summaries, previous = set(), set(), None
    for task in tasks:
        identity, level = task["id"], task.get("level", 0)
        if identity in ids:
            raise ValueError("Task IDs must be unique")
        if level > (previous.get("level", 0) + 1 if previous else 0):
            raise ValueError("Invalid task hierarchy level")
        if previous and level > previous.get("level", 0):
            summaries.add(previous["id"])
        previous = task
        ids.add(identity)
    for task in tasks:
        if task["id"] in summaries and any(key in task for key in ("actualStart", "actualEnd", "calendar")):
            raise ValueError("Summary tasks cannot have actual dates or task calendars")
    link_ids, outgoing, indegree = set(), {}, dict.fromkeys(ids, 0)
    for link in links:
        identity, source, target = link["id"], link["from"], link["to"]
        if identity in link_ids:
            raise ValueError("Relationship IDs must be unique")
        if source not in ids or target not in ids or source == target or source in summaries or target in summaries:
            raise ValueError("Relationships must connect existing distinct leaf tasks")
        link_ids.add(identity)
        outgoing.setdefault(source, []).append(target)
        indegree[target] += 1
    ready = [identity for identity in ids if indegree[identity] == 0]
    for source in ready:
        for target in outgoing.get(source, []):
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    if len(ready) != len(ids):
        raise ValueError("Relationships contain a dependency cycle")
    if next_id is not None and not integer(next_id, max(ids, default=0) + 1):
        raise ValueError("Invalid next task ID")
    if next_link is not None and not integer(next_link, max((int(key[1:]) for key in link_ids), default=0) + 1):
        raise ValueError("Invalid next relationship ID")


def validate_project(data):
    for key in ("nextId", "nextLink"):
        if key in data and not integer(data[key], 1):
            raise ValueError("Invalid " + key)
    for task in data["tasks"]:
        validate_task(task)
    for link in data["links"]:
        validate_link(link)
    validate_relations(data["tasks"], data["links"], data.get("nextId"), data.get("nextLink"))


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
        validate_project(data)
    if not isinstance(workbook.get("active"), str) or workbook["active"] not in ids:
        raise ValueError("The active project does not exist")
    for key, kind in [("templates", list), ("preferences", dict), ("history", dict), ("browser", dict)]:
        if key in state and not isinstance(state[key], kind):
            raise ValueError(f"Invalid {key}")


def encode(value, *, compression_level=6):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    compressed = zlib.compress(raw, level=compression_level) if len(raw) > 256 else raw
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


def validate_changes(changes):
    if type(changes) is not list or len(changes) > MAX_CHANGES:
        raise ValueError("Expected at most 10000 changes")
    for change in changes:
        if type(change) is not dict or type(change.get("op")) is not str:
            raise ValueError("Expected a change operation")
        op = change["op"]
        fields = {"set": {"op", "path", "value"}, "remove": {"op", "path"},
                  "splice": {"op", "path", "start", "deleteCount", "items"}}
        if op not in fields or set(change) != fields[op]:
            raise ValueError("Invalid change fields")
        path = change["path"]
        if type(path) is not list or not path or len(path) > MAX_DEPTH:
            raise ValueError("Expected a non-root path of at most 128 segments")
        if any(type(part) not in (str, int) or (type(part) is int and not 0 <= part < 2**63) for part in path):
            raise ValueError("Path segments must be strings or nonnegative integer indices")
        if op == "set":
            validate_json(change["value"])
        elif op == "splice":
            if any(type(change[key]) is not int or not 0 <= change[key] < 2**63 for key in ("start", "deleteCount")):
                raise ValueError("Splice counts must be nonnegative integers")
            if type(change["items"]) is not list:
                raise ValueError("Splice items must be an array")
            validate_json(change["items"])
    # Paths themselves must be valid Unicode too.
    validate_json(changes)


class _PatchTransaction:
    """A node editor within the caller's writer transaction; never inflates untouched data."""
    def __init__(self, db):
        self.db = db
        self.original = {}
        self.headers = {}
        self.removed_hashes = set()
        self.metrics = {"nodesVisited": 0, "nodesHashed": 0, "nodesWritten": 0, "nodesRemapped": 0}
        self.total = db.execute("SELECT bytes FROM workspace WHERE id=1").fetchone()[0]

    def node(self, path):
        row = self.db.execute("SELECT c.hash,o.value FROM current c JOIN objects o ON o.hash=c.hash WHERE c.path=?", (path,)).fetchone()
        if row is None:
            raise ValueError("Change path does not exist")
        self.metrics["nodesVisited"] += 1
        node = decode(row[1])
        if node[0] == "object":
            self.headers[row[0]] = node
        return node

    def remember(self, path):
        if path not in self.original:
            row = self.db.execute("SELECT hash FROM current WHERE path=?", (path,)).fetchone()
            self.original[path] = row[0] if row else None
            self.metrics["nodesVisited"] += int(row is not None)

    def rows(self, path):
        # '/' is the separator; its binary successor '0' closes precisely this subtree.
        # No SQL wildcard characters or case folding participate in path matching.
        # current.path is a TEXT PRIMARY KEY with BINARY collation. Separate
        # disjoint searches keep both branches indexed: explicit COLLATE on an
        # OR expression can make SQLite scan every unrelated workspace row.
        rows = self.db.execute(
            "SELECT path,hash FROM current WHERE path=? UNION ALL "
            "SELECT path,hash FROM current WHERE path>=? AND path<?",
            (path, path + "/", path + "0")).fetchall()
        self.metrics["nodesVisited"] += len(rows)
        return rows

    def put_hash(self, path, digest):
        self.remember(path)
        old = self.db.execute("SELECT o.bytes FROM current c JOIN objects o ON o.hash=c.hash WHERE c.path=?", (path,)).fetchone()
        size = self.db.execute("SELECT bytes FROM objects WHERE hash=?", (digest,)).fetchone()[0]
        self.metrics["nodesVisited"] += int(old is not None)
        self.total += size - (old[0] if old else 0)
        self.db.execute("INSERT OR REPLACE INTO current(path,hash) VALUES (?,?)", (path, digest))

    def put(self, path, node):
        raw = encode(node)
        digest = hashlib.sha256(raw).hexdigest()
        self.metrics["nodesHashed"] += 1
        if node[0] == "object":
            self.headers[digest] = node
        self.db.execute("INSERT OR IGNORE INTO objects(hash,value,bytes) VALUES (?,?,?)", (digest, raw, node_bytes(node)))
        self.put_hash(path, digest)

    def delete_rows(self, rows, *, remap=False):
        for path, digest in rows:
            self.remember(path)
            if not remap:
                self.removed_hashes.add(digest)
            self.total -= self.db.execute("SELECT bytes FROM objects WHERE hash=?", (digest,)).fetchone()[0]
        self.db.executemany("DELETE FROM current WHERE path=?", ((path,) for path, _ in rows))

    def cache_replaced_headers(self, path, nodes):
        # Only explicitly replaced object headers may be decoded here. Cache them
        # so a later remap can recognize an order-only no-op without decoding
        # any retained snapshot at its new location.
        for suffix, node in nodes.items():
            if node[0] == "object":
                row = self.db.execute("SELECT c.hash,o.value FROM current c JOIN objects o ON o.hash=c.hash WHERE c.path=?",
                                      (path + suffix,)).fetchone()
                if row and row[0] not in self.headers:
                    self.metrics["nodesVisited"] += 1
                    old = decode(row[1])
                    if old[0] == "object":
                        self.headers[row[0]] = old

    def replace(self, path, nodes):
        self.cache_replaced_headers(path, nodes)
        self.delete_rows(self.rows(path))
        for suffix, node in nodes.items():
            self.put(path + suffix, node)

    def resolve(self, segments):
        path = ""
        node = self.node(path)
        for part in segments:
            self.check_member(node, part, existing=True)
            path = child_path(path, part)
            node = self.node(path)
        return path, node

    @staticmethod
    def check_member(node, part, *, existing):
        kind, value = node
        if kind == "object":
            if type(part) is not str or (existing and part not in value):
                raise ValueError("Expected an existing object member" if existing else "Expected a string object key")
        elif kind == "array":
            if type(part) is not int or not 0 <= part < value:
                raise ValueError("Expected an existing array index; use splice to resize")
        else:
            raise ValueError("Cannot traverse a scalar value")

    def apply(self, change):
        op = change["op"]
        if op == "splice":
            path, node = self.resolve(change["path"])
            self.splice(path, node, change)
            return
        parent, node = self.resolve(change["path"][:-1])
        part = change["path"][-1]
        self.check_member(node, part, existing=op == "remove")
        path = child_path(parent, part)
        kind, value = node
        if op == "remove":
            if kind != "object":
                raise ValueError("Remove deletes object members only; use splice for arrays")
            self.delete_rows(self.rows(path))
            self.put(parent, [kind, [key for key in value if key != part]])
        else:
            # Include the enclosing path in the maximum persisted JSON depth.
            subtree = flatten(change["value"])
            if any(len(change["path"]) + suffix.count("/") > MAX_DEPTH for suffix in subtree):
                raise ValueError("JSON nesting exceeds the 128-level limit")
            self.replace(path, subtree)
            if kind == "object" and part not in value:
                self.put(parent, [kind, value + [part]])

    def splice(self, path, node, change):
        kind, length = node
        start, count, items = change["start"], change["deleteCount"], change["items"]
        if kind != "array" or start > length or count > length - start:
            raise ValueError("Splice requires an array and an in-range start/deleteCount")
        if count == 0 and not items:
            return
        delta = len(items) - count
        removed, moved = [], []
        # Read hashes only; shifted snapshots retain both hashes and logical byte contributions.
        for index in range(start, length if delta else start + count):
            source = child_path(path, index)
            rows = self.rows(source)
            if index < start + count:
                removed.extend(rows)
            elif delta:
                target = child_path(path, index + delta)
                moved.extend((old, target + old[len(source):], digest) for old, digest in rows)
        # Capture occupied destinations before deleting ANY source, including overlapping moves.
        for source, target, _ in moved:
            self.remember(source)
            self.remember(target)
        replacements = []
        for index, value in enumerate(items, start):
            subtree = flatten(value)
            if any(len(change["path"]) + 1 + suffix.count("/") > MAX_DEPTH for suffix in subtree):
                raise ValueError("JSON nesting exceeds the 128-level limit")
            if index < start + count:
                self.cache_replaced_headers(child_path(path, index), subtree)
            replacements.append((index, subtree))
        self.metrics["nodesRemapped"] += len(moved)
        self.delete_rows(removed)
        self.delete_rows([(source, digest) for source, _, digest in moved], remap=True)
        for _, target, digest in moved:
            self.put_hash(target, digest)
        for index, subtree in replacements:
            self.replace(child_path(path, index), subtree)
        self.put(path, ["array", length + delta])

    def validate_headers(self):
        """Trust the validated base; inspect affected project headers and identity dependencies."""
        def require(path, kind):
            node = self.node(path)
            if node[0] != kind:
                raise ValueError("Invalid workspace container: " + path)
            return node[1]
        root = require("", "object")
        require("/workbook", "object")
        count = require("/workbook/sheets", "array")
        if count == 0:
            raise ValueError("A workbook must contain at least one project")
        affected = set()
        identity_changed = "/workbook/sheets" in self.original or "/workbook/active" in self.original
        for touched in self.original:
            parts = touched.split("/")
            if len(parts) >= 4 and parts[1:3] == ["workbook", "sheets"]:
                index = int(parts[3])
                if index < count:
                    affected.add(index)
                if len(parts) == 5 and parts[4] == "id":
                    identity_changed = True
        ids = set()
        for index in range(count) if identity_changed else sorted(affected):
            path = child_path("/workbook/sheets", index)
            require(path, "object")
            kind, identity = self.node(path + "/id")
            if kind != "value" or type(identity) is not str or identity in ids:
                raise ValueError("Each project must have a unique ID")
            ids.add(identity)
            require(path + "/data", "object")
            require(path + "/data/tasks", "array")
            require(path + "/data/links", "array")
            if index in affected:
                self.validate_records(path + "/data")
        kind, active = self.node("/workbook/active")
        if kind != "value" or type(active) is not str or (identity_changed and active not in ids):
            raise ValueError("The active project does not exist")
        for key, kind in [("templates", "array"), ("preferences", "object"), ("history", "object"), ("browser", "object")]:
            # Unchanged optional containers inherit their validated base type;
            # their object headers can themselves grow with unrelated projects.
            if key in root and child_path("", key) in self.original:
                require(child_path("", key), kind)

    def value(self, path):
        """Decode an affected record only, without calling the workspace inflater."""
        kind, value = self.node(path)
        if kind == "object":
            return {key: self.value(child_path(path, key)) for key in value}
        if kind == "array":
            return [self.value(child_path(path, index)) for index in range(value)]
        return value

    def validate_records(self, data_path):
        if not any(key.startswith((data_path + "/tasks", data_path + "/links"))
                   or key in (data_path + "/nextId", data_path + "/nextLink") for key in self.original):
            return
        graph_changed = False
        for collection, validator in (("tasks", validate_task), ("links", validate_link)):
            path = data_path + "/" + collection
            prefix = path + "/"
            touched = [key[len(prefix):].split("/") for key in self.original if key.startswith(prefix)]
            if not touched and path not in self.original:
                continue
            count = self.node(path)[1]
            structure = path in self.original
            graph_changed |= structure or any(len(parts) == 2 and parts[1] in ("id", "level", "from", "to", "agr", "actualStart", "actualEnd", "calendar") for parts in touched)
            indices = range(count) if structure else sorted({int(parts[0]) for parts in touched if int(parts[0]) < count})
            for index in indices:
                validator(self.value(child_path(path, index)))
        data_keys = self.node(data_path)[1]
        for key in ("nextId", "nextLink"):
            path = data_path + "/" + key
            if path in self.original:
                graph_changed = True
                if key in data_keys and not integer(self.value(path), 1):
                    raise ValueError("Invalid " + key)
        if not graph_changed:
            return
        tasks, links = [], []
        for collection, fields, result in (("tasks", ("id", "level", "agr", "actualStart", "actualEnd", "calendar"), tasks), ("links", ("id", "from", "to"), links)):
            path = data_path + "/" + collection
            for index in range(self.node(path)[1]):
                record_path = child_path(path, index)
                kind, keys = self.node(record_path)
                if kind != "object":
                    raise ValueError("Tasks and relationships must be objects")
                result.append({key: self.value(child_path(record_path, key)) for key in fields if key in keys})
        validate_relations(tasks, links,
                           self.value(data_path + "/nextId") if "nextId" in data_keys else None,
                           self.value(data_path + "/nextLink") if "nextLink" in data_keys else None)

    def net_changes(self):
        changes = {}
        for path, before in self.original.items():
            row = self.db.execute("SELECT hash FROM current WHERE path=?", (path,)).fetchone()
            after = row[0] if row else None
            self.metrics["nodesVisited"] += int(row is not None)
            if before == after:
                continue
            # Object key order is not a JSON data change. Reuse the old header hash
            # for remove/re-add and reordered equivalent replacements.
            if after in self.headers and before in self.removed_hashes and before not in self.headers:
                # A previously removed subtree may be recreated later in this
                # patch. Read its old header only when the final node is an
                # object; remapped retained nodes never enter removed_hashes.
                self.metrics["nodesVisited"] += 1
                old = decode(self.db.execute("SELECT value FROM objects WHERE hash=?", (before,)).fetchone()[0])
                if old[0] == "object":
                    self.headers[before] = old
            if before in self.headers and after in self.headers:
                old, new = self.headers[before], self.headers[after]
                if set(old[1]) == set(new[1]):
                    self.put_hash(path, before)
                    continue
            changes[path] = [before, after]
        return changes


class ProjectStorage:
    def __init__(self, directory):
        self.path = (Path(directory) / "plan.db").resolve()

    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        try:
            # FULL applies to initialization and the accounting migration as well as edits.
            db.execute("PRAGMA synchronous=FULL")
            identity = db.execute("PRAGMA application_id").fetchone()[0]
            if identity == 0:
                db.execute("BEGIN IMMEDIATE")
                identity = db.execute("PRAGMA application_id").fetchone()[0]
                if identity == 0:
                    if db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                        raise ValueError("This SQLite file belongs to another application")
                    db.execute("CREATE TABLE objects (hash TEXT PRIMARY KEY, value BLOB NOT NULL, bytes INTEGER NOT NULL)")
                    db.execute("CREATE TABLE current (path TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES objects(hash))")
                    db.execute("CREATE TABLE versions (revision INTEGER PRIMARY KEY, created TEXT NOT NULL, summary TEXT NOT NULL, changes BLOB NOT NULL, snapshot BLOB)")
                    db.execute("CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL CHECK(bytes>=0))")
                    db.execute("INSERT INTO workspace VALUES (1,0)")
                    db.execute("PRAGMA application_id=1347174734")
                    db.execute("PRAGMA user_version=2")
                db.commit()
                identity = db.execute("PRAGMA application_id").fetchone()[0]
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if identity != APP_ID or version not in (1, 2):
                raise ValueError("Unknown Plan database format; keep the original file")
            db.execute("PRAGMA journal_mode=DELETE")
            db.execute("PRAGMA foreign_keys=ON")
            if version == 1:
                self._upgrade_accounting(db)
            row = db.execute("SELECT bytes FROM workspace WHERE id=1").fetchone()
            if row is None or type(row[0]) is not int or not 0 <= row[0] <= MAX_BYTES:
                raise ValueError("The workspace size accounting is damaged")
            return db
        except Exception:
            db.close()
            raise

    def _upgrade_accounting(self, db):
        """One transactional scan, never repeated by ordinary edits or concurrent openers."""
        with db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("PRAGMA user_version").fetchone()[0] != 1:
                return
            db.execute("ALTER TABLE objects ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0")
            for digest, raw in db.execute("SELECT hash,value FROM objects"):
                db.execute("UPDATE objects SET bytes=? WHERE hash=?", (node_bytes(decode(raw)), digest))
            nodes = {path: decode(raw) for path, raw in db.execute(
                "SELECT c.path,o.value FROM current c JOIN objects o ON o.hash=c.hash")}
            if nodes:
                state = inflate(nodes)
                validate_state(state)
                expected = validate_json(state)
            else:
                if self.revision(db) is not None:
                    raise ValueError("The saved app state is incomplete")
                expected = 0
            actual = db.execute("SELECT COALESCE(SUM(o.bytes),0) FROM current c JOIN objects o ON o.hash=c.hash").fetchone()[0]
            if actual != expected or actual > MAX_BYTES:
                raise ValueError("The workspace size accounting is damaged or exceeds 64 MB")
            db.execute("CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL CHECK(bytes>=0))")
            db.execute("INSERT INTO workspace VALUES (1,?)", (actual,))
            db.execute("PRAGMA user_version=2")

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
        """Explicit full bootstrap/import for internal callers; HTTP permits bootstrap only."""
        validate_revision(revision)
        validate_state(state)
        if validate_json(state) > MAX_BYTES:
            raise ValueError("App state exceeds the 64 MB workspace limit")
        nodes = flatten(state)
        with contextlib.closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self._check_revision(db, revision)
            patch = _PatchTransaction(db)
            patch.replace("", nodes)
            return self._finish(db, revision, patch)

    def apply_changes(self, revision, changes):
        validate_revision(revision)
        validate_changes(changes)
        if len(json_bytes({"revision": revision, "changes": changes})) > MAX_BYTES:
            raise ValueError("Changes exceed the 64 MB save request limit")
        with contextlib.closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self._check_revision(db, revision)
            if revision is None:
                raise ValueError("Bootstrap the workspace before applying changes")
            patch = _PatchTransaction(db)
            for change in changes:
                patch.apply(change)
            patch.validate_headers()
            return self._finish(db, revision, patch)

    @staticmethod
    def _check_revision(db, revision):
        if ProjectStorage.revision(db) != revision:
            raise ConflictError("App state changed in another window. Reload before editing.")

    def _finish(self, db, current_revision, patch):
        changes = patch.net_changes()
        if not changes:
            # Intermediate objects and cancelled remaps are not durable writes either.
            db.rollback()
            return {"revision": current_revision, "dataFile": str(self.path), "metrics": patch.metrics}
        if not 0 <= patch.total <= MAX_BYTES:
            raise ValueError("App state exceeds the 64 MB workspace limit")
        new_revision = int(current_revision or 0) + 1
        if new_revision >= 2**63:
            raise ValueError("The workspace revision limit was reached")
        summary = self._summary(current_revision, changes)
        snapshot = None
        if new_revision == 1 or new_revision % 50 == 0:
            hashes = dict(db.execute("SELECT path,hash FROM current"))
            patch.metrics["nodesVisited"] += len(hashes)
            # Checkpoints are read infrequently but created on the action's commit
            # path. Prefer faster compression here; the zlib format is unchanged.
            # Object/changes encoding keeps its existing level and hash identity.
            snapshot = encode(hashes, compression_level=1)
        db.execute("UPDATE workspace SET bytes=? WHERE id=1", (patch.total,))
        db.execute("INSERT INTO versions VALUES (?,?,?,?,?)", (
            new_revision, datetime.now().astimezone().isoformat(), summary, encode(changes), snapshot))
        patch.metrics["nodesWritten"] = len(changes)
        return {"revision": str(new_revision), "dataFile": str(self.path), "metrics": patch.metrics}

    @staticmethod
    def _summary(current_revision, changes):
        if current_revision is None:
            summary = "Initial app state"
        elif any("/tasks/" in path for path in changes):
            summary = "Edited tasks"
        elif any("/links/" in path for path in changes):
            summary = "Edited relationships"
        elif any(path.startswith("/workbook/sheets/") and "/versions" in path for path in changes):
            summary = "Updated project versions"
        elif any(path.startswith("/workbook/sheets/") and ("/data/log" in path or path.endswith("/data/baselined") or "/data/agreedOrig" in path) for path in changes):
            summary = "Updated delay accounting"
        elif any(path.startswith("/workbook/sheets/") and "/data/calendar" in path for path in changes):
            summary = "Updated calendar"
        elif any(path.startswith("/workbook/sheets/") and "/data/stars" in path for path in changes):
            summary = "Updated key milestones"
        elif any((path.startswith("/workbook/sheets/") and "/criticalPath" in path) or path.startswith("/preferences/critical") for path in changes):
            summary = "Updated critical path settings"
        elif any(path.startswith("/workbook") for path in changes):
            summary = "Updated projects"
        elif any(path.startswith("/templates") for path in changes):
            summary = "Updated templates"
        elif "/browser/pm-delay-causes" in changes:
            summary = "Updated delay causes"
        else:
            summary = "Updated app settings or activity"
        return summary

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
                state = cast(dict, inflate(nodes))
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
                state = cast(dict, inflate(nodes))
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
