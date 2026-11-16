"""Local Plan server with integrated SQLite storage (standard library only)."""
import argparse
import contextlib
import functools
import http.server
import json
import sqlite3
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

from .persistence import (
    MAX_BYTES,
    ConflictError,
    ProjectStorage,
    default_data_dir,
    reject_constant,
)

WEB = Path(__file__).parent / "web"


class ProjectHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".css": "text/css", ".json": "application/json"}

    def __init__(self, *args, storage, **kwargs):
        self.storage = storage
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, status, value):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/api/health":
            self.send_json(200, {"app": "plan-local", "dataFile": str(self.storage.path)})
        elif parsed.path == "/api/projects" or parsed.path.startswith("/api/history"):
            try:
                if parsed.path == "/api/projects":
                    result = self.storage.read()
                    result["dataFile"] = str(self.storage.path)
                elif parsed.path == "/api/history":
                    before = parse_qs(parsed.query).get("before", [None])[0]
                    if before is not None and (not before.isdigit() or not 0 < int(before) < 2**63):
                        raise ValueError("Invalid history cursor")
                    result = self.storage.history(int(before) if before else None)
                elif parsed.path.startswith("/api/history/"):
                    revision = parsed.path.removeprefix("/api/history/")
                    if not revision.isdigit() or not 0 < int(revision) < 2**63:
                        raise ValueError("Invalid history version")
                    result = self.storage.version(int(revision))
                else:
                    self.send_json(404, {"error": "Unknown endpoint"})
                    return
                self.send_json(200, result)
            except LookupError as e:
                self.send_json(404, {"error": str(e)})
            except (OSError, ValueError, sqlite3.Error) as e:
                self.send_json(503, {"error": f"Cannot read saved app state. Keep plan.db intact and check the server window. ({e})"})
        else:
            super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/api/projects":
            self.send_json(404, {"error": "Unknown endpoint"})
            return
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self.send_json(403, {"error": "Save requests must come from this app"})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Expected application/json"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BYTES:
            self.send_json(413, {"error": "Save request must be between 1 byte and 64 MB"})
            return
        try:
            body = json.loads(self.rfile.read(length), parse_constant=reject_constant)
            if not isinstance(body, dict) or "revision" not in body:
                raise ValueError("Expected a save revision")
            result = self.storage.write(body["revision"], body.get("state"))
            self.send_json(200, result)
        except ConflictError as e:
            self.send_json(409, {"error": str(e)})
        except (ValueError, UnicodeError, RecursionError) as e:
            self.send_json(400, {"error": str(e)})
        except (OSError, sqlite3.Error) as e:
            self.send_json(503, {"error": f"Could not save app state. Check free space and folder permissions. ({e})"})


def create_server(port, data_dir):
    storage = ProjectStorage(data_dir)
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(ProjectHandler, storage=storage))


def main():
    ap = argparse.ArgumentParser(description="Plan: project sheet and Gantt with automatic SQLite saves")
    ap.add_argument("-p", "--port", type=int, default=5173)
    ap.add_argument("--data-dir", type=Path, help="Folder for plan.db (default: Documents/Plan)")
    ap.add_argument("--no-open", action="store_true", help="Do not open a browser window")
    a = ap.parse_args()
    if not 0 <= a.port <= 65535:
        ap.error("port must be between 0 and 65535")
    try:
        directory = a.data_dir if a.data_dir is not None else default_data_dir()
    except OSError as e:
        ap.exit(1, f"Cannot locate Documents: {e}\n")
    try:
        srv = create_server(a.port, directory)
    except OSError as e:
        # Double-clicking again reuses the running server for this database.
        try:
            with urlopen(f"http://127.0.0.1:{a.port}/api/health", timeout=2) as response:
                health = json.load(response)
            if health.get("app") != "plan-local" or health.get("dataFile") != str((directory / "plan.db").resolve()):
                raise ValueError("Different app or database")
        except (OSError, ValueError):
            ap.exit(1, f"Cannot start Plan on port {a.port}: {e}\nClose the other server or choose --port 5174.\n")
        url = f"http://127.0.0.1:{a.port}/"
        print(f"Plan is already running: {url}", flush=True)
        if not a.no_open:
            webbrowser.open(url)
        return
    with srv:
        url = f"http://127.0.0.1:{srv.server_port}/"
        print(f"Plan is running: {url}\nApp state: {(directory / 'plan.db').resolve()}\nKeep this window open. Press Ctrl+C to stop.", flush=True)
        if not a.no_open:
            webbrowser.open(url)
        with contextlib.suppress(KeyboardInterrupt):
            srv.serve_forever()
