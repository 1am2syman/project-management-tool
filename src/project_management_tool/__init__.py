"""Local Plan server with integrated SQLite storage (standard library only)."""
import argparse
import contextlib
import functools
import hashlib
import http.server
import json
import os
import platform
import secrets
import sqlite3
import struct
import sys
import threading
import webbrowser
from pathlib import Path
from typing import cast
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

from .native_dialogs import WindowsDialogs
from .persistence import (
    MAX_BYTES,
    ConflictError,
    ProjectStorage,
    RevisionConflict,
    default_data_dir,
    reject_constant,
)
from .project_files import FileConflict, FileService, FileTooLarge, OperationError

WEB = Path(__file__).parent / "web"


def runtime_diagnostics():
    """Describe the running build without exposing paths, environment variables or saved data."""
    digest = hashlib.sha256()
    source = WEB.parent
    for path in sorted([*source.glob("*.py"), *WEB.glob("*.html"), *WEB.glob("*.css"), *WEB.glob("js/*.js")]):
        digest.update(path.relative_to(source).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return {
        "app": "plan-local", "diagnosticsVersion": 1,
        "sourceFingerprint": digest.hexdigest(),
        "python": {"version": platform.python_version(), "implementation": platform.python_implementation(),
                   "bitness": struct.calcsize("P") * 8, "bundled": any(Path(sys.executable).parent.glob("python*._pth"))},
        "operatingSystem": {"system": platform.system(), "release": platform.release(),
                            "version": platform.version(), "machine": platform.machine()},
        "sqliteVersion": sqlite3.sqlite_version,
        "storageBackend": "sqlite",
    }


def native_windows_available():
    return os.name == 'nt'


class PlanServer(http.server.ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second process bind a port that is already listening, so a second launch
    # would start a duplicate server instead of reusing the running one. Failing the bind lets create_server's
    # OSError path health-check the existing instance. POSIX keeps reuse for quick restarts.
    allow_reuse_address = os.name != 'nt'
    file_session: str
    file_service: FileService | None
    file_failed: bool
    file_attempted: bool
    file_lock: threading.Lock
    file_storage: ProjectStorage

    def use_file_service(self, service):
        # An injected service is authoritative, so the capability status must agree with it.
        with self.file_lock:
            self.file_service = service
            self.file_failed = False
            self.file_attempted = True

    def ensure_file_service(self):
        if not native_windows_available() or self.file_service is not None:
            return
        with self.file_lock:
            if self.file_service is not None:
                return
            chooser = None
            self.file_attempted = True
            try:
                local = os.environ.get('LOCALAPPDATA')
                if not local:
                    raise OSError('Local application data is unavailable')
                chooser = WindowsDialogs()
                self.file_service = FileService(Path(local) / 'Plan' / 'file-access', self.file_storage.path, chooser)
                self.file_failed = False
            except Exception:
                self.file_failed = True
                if chooser is not None:
                    with contextlib.suppress(Exception):
                        chooser.close()


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

    def file_auth(self, *, bootstrap=False):
        expected_host = f'127.0.0.1:{cast(PlanServer, self.server).server_port}'
        if self.headers.get('Host') != expected_host:
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin != f'http://{expected_host}':
            return False
        if self.command != 'GET' and origin != f'http://{expected_host}':
            return False
        if bootstrap:
            return self.headers.get('X-Plan-Bootstrap') == '1'
        return secrets.compare_digest(self.headers.get('X-Plan-Session', ''), cast(PlanServer, self.server).file_session)

    def file_api(self):
        path = urlsplit(self.path).path
        if not (path in ('/api/file-access', '/api/file-operations', '/api/file-connections/check') or path.startswith('/api/file-operations/')):
            return False
        bootstrap = path == '/api/file-access' and self.command == 'GET'
        if not self.file_auth(bootstrap=bootstrap):
            self.close_connection = True
            self.send_json(403, {'error': 'File access authorization failed'})
            return True
        try:
            if bootstrap:
                server = cast(PlanServer, self.server)
                if server.file_failed:
                    server.ensure_file_service()
                self.send_json(200, {'version': 1, 'available': server.file_service is not None,
                                     'status': 'failed' if server.file_failed else ('available' if server.file_service else 'unsupported'),
                                     'session': server.file_session if server.file_service else None})
                return True
            service = cast(PlanServer, self.server).file_service
            if service is None:
                self.send_json(404, {'error': 'Native file access is unavailable'})
                return True
            client = self.headers.get('X-Plan-Client', '')
            if not client or len(client) > 100:
                raise ValueError('Invalid client identity')
            parts = path.strip('/').split('/')
            if self.command == 'POST' and path == '/api/file-connections/check':
                body = self.file_json()
                sheet, token = body.get('sheet'), body.get('token')
                if not isinstance(sheet, str) or not isinstance(token, str) or len(sheet) > 100 or len(token) > 100:
                    raise ValueError('Invalid connection identity')
                self.send_json(200, {'connected': service.connection(sheet, token) is not None})
            elif self.command == 'POST' and path == '/api/file-operations':
                body = self.file_json()
                result = service.start(client, body.get('id'), body.get('kind'), sheet=body.get('sheet'),
                                       token=body.get('token'), revision=body.get('revision'),
                                       suggested_name=body.get('suggestedName', ''), copy_only=body.get('copyOnly', False))
                self.send_json(200, result)
            elif len(parts) in (3, 4) and parts[:2] == ['api', 'file-operations']:
                operation = parts[2]
                action = parts[3] if len(parts) == 4 else ''
                self.file_operation(service, client, operation, action)
            else:
                self.send_json(404, {'error': 'Unknown file operation endpoint'})
        except LookupError:
            self.send_json(404, {'error': 'Unknown file operation or connection'})
        except RevisionConflict:
            # Refused before any bytes were written; the client may retry the same selection on a newer revision.
            self.send_json(409, {'error': 'App state changed in another window. Reload before saving.', 'reason': 'revision'})
        except (FileConflict, ConflictError, OperationError):
            self.send_json(409, {'error': 'File operation conflicts with the current project or file', 'reason': 'conflict'})
        except (ValueError, UnicodeError, FileTooLarge):
            self.send_json(400, {'error': 'Invalid file operation request'})
        except OSError as error:
            if getattr(error, 'winerror', None) in (32, 33):
                self.send_json(503, {'error': 'The file is open in another program. Close it and try again.', 'code': 'file_in_use'})
            elif isinstance(error, PermissionError):
                self.send_json(503, {'error': 'Cannot access this file. It may be read-only or open in another program. Close it there, check permissions, or use Save As.', 'code': 'permission_denied'})
            else:
                self.send_json(503, {'error': 'File operation could not be completed'})
        except sqlite3.Error:
            self.send_json(503, {'error': 'File operation could not be completed'})
        return True

    def file_operation(self, service, client, operation, action):
        # Per-operation endpoints; errors are mapped by file_api.
        if self.command == 'GET' and not action:
            self.send_json(200, service.status(client, operation))
        elif self.command == 'GET' and action == 'content':
            raw = service.content(client, operation)
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        elif self.command == 'PUT' and action == 'snapshot':
            service.stage_snapshot(client, operation, self.file_body(MAX_BYTES))
            self.send_json(200, service.status(client, operation))
        elif self.command == 'POST' and action == 'commit':
            self.file_json()
            self.send_json(200, service.write_staged(client, operation, authorize=self.storage.file_authorization,
                                                     revision=self.headers.get('X-Plan-Revision')))
        elif self.command == 'PUT' and action == 'content':
            raw = self.file_body(MAX_BYTES)
            self.send_json(200, service.write(client, operation, raw, authorize=self.storage.file_authorization,
                                              revision=self.headers.get('X-Plan-Revision')))
        elif self.command == 'POST' and action == 'attach':
            body = self.file_json()
            status = service.status(client, operation)
            with self.storage.file_attach_authorization(body.get('sheet'), status.get('token'), body.get('revision')):
                token = service.attach(client, operation, body.get('sheet'))
            self.send_json(200, {'token': token})
        elif self.command == 'POST' and action == 'cancel':
            self.file_json()
            self.send_json(200, service.cancel_chooser(client, operation))
        elif self.command == 'POST' and action == 'raise':
            self.file_json()
            self.send_json(200, service.raise_chooser(client, operation))
        elif self.command == 'POST' and action == 'release':
            service.release(client, operation)
            self.send_json(200, {'released': True})
        else:
            self.send_json(404, {'error': 'Unknown file operation endpoint'})

    def file_body(self, limit):
        length = int(self.headers.get('Content-Length', '-1'))
        if length < 0 or length > limit:
            raise ValueError('Invalid request size')
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError('Incomplete request')
        return data

    def file_json(self):
        if self.headers.get_content_type() != 'application/json':
            raise ValueError('Expected JSON')
        value = json.loads(self.file_body(16384), parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ValueError('Expected object')
        return value

    def do_GET(self):
        if self.file_api():
            return
        parsed = urlsplit(self.path)
        if parsed.path == "/api/diagnostics":
            try:
                info = runtime_diagnostics()
                service = cast(PlanServer, self.server).file_service
                server = cast(PlanServer, self.server)
                # Native access starts on first use, so a fresh page reports it as not started yet.
                status = 'available' if service else ('unsupported' if not server.file_failed else
                                                      'failed' if server.file_attempted else 'not started')
                info['fileAccess'] = {'backend': 'python' if service else ('pending' if status == 'not started' else 'browser'),
                                      'status': status,
                                      'events': service.diagnostics() if service else []}
                self.send_json(200, info)
            except OSError:
                self.send_json(503, {"error": "Cannot inspect the installed app source"})
        elif parsed.path == "/api/health":
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

    def do_PUT(self):
        if not self.file_api():
            self.send_json(404, {'error': 'Unknown endpoint'})

    def do_POST(self):
        if self.file_api():
            return
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


def create_server(port, data_dir, *, native_files=True):
    storage = ProjectStorage(data_dir)
    server = PlanServer(("127.0.0.1", port), functools.partial(ProjectHandler, storage=storage))
    server.file_session = secrets.token_urlsafe(32)
    server.file_service = None
    server.file_failed = False
    server.file_attempted = False
    server.file_lock = threading.Lock()
    server.file_storage = storage
    # Automated tests pass native_files=False: no chooser, no %LOCALAPPDATA%, and the browser
    # fallback is reported as unsupported. Production remains native-first.
    server.file_failed = native_files and native_windows_available()
    # The file service starts on capability discovery; a broken COM setup must
    # not prevent the HTTP server or early diagnostic capture from starting.
    return server


def main():
    ap = argparse.ArgumentParser(description="Plan: project sheet and Gantt with automatic SQLite saves")
    ap.add_argument("-p", "--port", type=int, default=5173)
    ap.add_argument("--data-dir", type=Path, help="Folder for plan.db (default: Documents/Plan)")
    ap.add_argument("--no-open", action="store_true", help="Do not open a browser window")
    ap.add_argument("--file-access", choices=("native", "off"), default="native",
                    help="Windows file dialogs. 'off' keeps the browser fallback and never touches %%LOCALAPPDATA%%; automated tests use it")
    a = ap.parse_args()
    if not 0 <= a.port <= 65535:
        ap.error("port must be between 0 and 65535")
    try:
        directory = a.data_dir if a.data_dir is not None else default_data_dir()
    except OSError as e:
        ap.exit(1, f"Cannot locate Documents: {e}\n")
    try:
        srv = create_server(a.port, directory, native_files=a.file_access == "native")
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
        try:
            with contextlib.suppress(KeyboardInterrupt):
                srv.serve_forever()
        finally:
            with srv.file_lock:
                if srv.file_service:
                    srv.file_service.close()
