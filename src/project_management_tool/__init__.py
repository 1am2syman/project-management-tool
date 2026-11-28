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
import select
import socket
import sqlite3
import struct
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import cast
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from . import desktop_win
from .native_dialogs import WindowsDialogs
from .persistence import (
    MAX_BYTES,
    ConflictError,
    ProjectStorage,
    RevisionConflict,
    default_data_dir,
    reject_constant,
    strict_object,
    validate_revision,
)
from .project_files import FileConflict, FileService, FileTooLarge, OperationError

WEB = Path(__file__).parent / "web"


def runtime_diagnostics():
    """Describe the running build without exposing paths, environment variables or saved data."""
    digest = hashlib.sha256()
    source = WEB.parent
    for path in sorted([*source.glob("*.py"), *WEB.glob("*.html"), *WEB.glob("*.css"), *WEB.glob("*.svg"), *WEB.glob("*.ico"), *WEB.glob("js/*.js"), *WEB.glob("fonts/*.woff2")]):
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
    # A cold ES-module graph opens connections in bursts. The stdlib default of
    # five pending connections can drop a burst while the accept loop is busy,
    # leading to TCP retransmission delays or failed module loads.
    request_queue_size = 128

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
    app_mode: bool
    app_sessions: desktop_win.AppSessionTracker

    def server_close(self):
        if getattr(self, 'app_sessions', None) is not None:
            self.app_sessions.close_all()
        super().server_close()

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
                      ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
                      ".woff2": "font/woff2", ".ico": "image/x-icon"}

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
        elif parsed.path == "/api/app-session":
            self.serve_app_session()
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
                self.send_json(503, {"error": f"Cannot read saved app state. Keep plan.db intact and check the server window. ({e})", "dataFile": str(self.storage.path)})
        else:
            super().do_GET()

    def _same_loopback_host(self):
        expected_host = f"127.0.0.1:{cast(PlanServer, self.server).server_port}"
        if self.headers.get("Host") != expected_host:
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin != f"http://{expected_host}":
            return False
        return True

    def serve_app_session(self):
        if not self._same_loopback_host():
            self.close_connection = True
            self.send_json(403, {"error": "App session authorization failed"})
            return
        server = cast(PlanServer, self.server)
        self.close_connection = True
        if not server.app_mode:
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "close")
        self.end_headers()
        sid = server.app_sessions.register_session()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            last_ping = time.monotonic()
            while not server.app_sessions.stop_event.is_set():
                try:
                    readable, _, _ = select.select([self.connection], [], [], 0.25)
                except (OSError, ValueError):
                    break
                if readable:
                    try:
                        if not self.connection.recv(1, socket.MSG_PEEK):
                            break
                    except OSError:
                        break
                now = time.monotonic()
                if now - last_ping >= 15.0:
                    last_ping = now
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            server.app_sessions.unregister_session(sid)

    def do_PUT(self):
        if not self.file_api():
            self.send_json(404, {'error': 'Unknown endpoint'})

    def do_POST(self):
        if self.file_api():
            return
        endpoint = urlsplit(self.path).path
        if endpoint == "/api/window/focus":
            if not self._same_loopback_host() or self.headers.get("X-Plan-Instance") != "1":
                self.close_connection = True
                self.send_json(403, {"error": "Window focus authorization failed"})
                return
            focused, hwnd = cast(PlanServer, self.server).app_sessions.focus_active_window()
            self.send_json(200, {"focused": focused, "hwnd": hwnd})
            return
        if endpoint not in ("/api/projects", "/api/projects/changes"):
            self.send_json(404, {"error": "Unknown endpoint"})
            return
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self.send_json(403, {"error": "Save requests must come from this app", "dataFile": str(self.storage.path)})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Expected application/json", "dataFile": str(self.storage.path)})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BYTES:
            self.send_json(413, {"error": "Save request must be between 1 byte and 64 MB", "dataFile": str(self.storage.path)})
            return
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete save request")
            body = json.loads(raw, parse_constant=reject_constant, object_pairs_hook=strict_object)
            fields = {"revision", "changes"} if endpoint.endswith("/changes") else {"revision", "state"}
            if not isinstance(body, dict) or set(body) != fields:
                raise ValueError("Expected exactly " + ", ".join(sorted(fields)))
            validate_revision(body["revision"])
            if endpoint.endswith("/changes"):
                result = self.storage.apply_changes(body["revision"], body["changes"])
            else:
                if body["revision"] is not None:
                    raise ValueError("Full saves are bootstrap-only; use /api/projects/changes")
                result = self.storage.write(None, body["state"])
            self.send_json(200, result)
        except ConflictError as e:
            self.send_json(409, {"error": str(e), "dataFile": str(self.storage.path)})
        except (ValueError, UnicodeError, RecursionError) as e:
            self.send_json(400, {"error": str(e), "dataFile": str(self.storage.path)})
        except (OSError, sqlite3.Error) as e:
            self.send_json(503, {"error": f"Could not save app state. Check free space and folder permissions. ({e})", "dataFile": str(self.storage.path)})


def create_server(port, data_dir, *, native_files=True, app_mode=False):
    storage = ProjectStorage(data_dir)
    server = PlanServer(("127.0.0.1", port), functools.partial(ProjectHandler, storage=storage))
    server.file_session = secrets.token_urlsafe(32)
    server.file_service = None
    server.file_failed = False
    server.file_attempted = False
    server.file_lock = threading.Lock()
    server.file_storage = storage
    server.app_mode = bool(app_mode)
    server.app_sessions = desktop_win.AppSessionTracker()
    # Automated tests pass native_files=False: no chooser, no %LOCALAPPDATA%, and the browser
    # fallback is reported as unsupported. Production remains native-first.
    server.file_failed = native_files and native_windows_available()
    # The file service starts on capability discovery; a broken COM setup must
    # not prevent the HTTP server or early diagnostic capture from starting.
    return server


def build_arg_parser():
    ap = argparse.ArgumentParser(description="Plan: project sheet and Gantt with automatic SQLite saves")
    ap.add_argument("-p", "--port", type=int, default=5173)
    ap.add_argument("--data-dir", type=Path, help="Folder for plan.db (default: Documents/Plan)")
    ap.add_argument("--no-open", action="store_true", help="Do not open a browser window")
    ap.add_argument("--file-access", choices=("native", "off"), default="native",
                    help="Windows file dialogs. 'off' keeps the browser fallback and never touches %%LOCALAPPDATA%%; automated tests use it")
    ap.add_argument("--app", action="store_true",
                    help="Run as a Windows desktop app window (no console) and stop when the window closes")
    ap.add_argument("--install-shortcut", action="store_true",
                    help="Create or update the Windows Start Menu shortcut for Plan")
    ap.add_argument("--uninstall-shortcut", action="store_true",
                    help="Remove the installed Windows shortcut(s) for Plan")
    ap.add_argument("--desktop", action="store_true",
                    help="With --install-shortcut or --uninstall-shortcut, also manage a Desktop shortcut")
    ap.add_argument("--profile-dir", type=Path,
                    help="Dedicated browser profile folder for --app mode (default: %%LOCALAPPDATA%%\\Plan\\shell)")
    return ap


def try_focus_running_instance(port):
    """Ask a running Plan --app server to focus its window; also focus locally with foreground rights."""
    req = Request(
        f"http://127.0.0.1:{port}/api/window/focus",
        data=b"",
        method="POST",
        headers={"X-Plan-Instance": "1", "Content-Length": "0"},
    )
    try:
        with urlopen(req, timeout=2) as response:
            payload = json.load(response)
    except (OSError, ValueError):
        return False
    hwnd = payload.get("hwnd")
    if isinstance(hwnd, int) and hwnd > 0 and os.name == "nt":
        desktop_win.focus_window(hwnd)
    return bool(payload.get("focused"))


def _fatal_error(ap, message, *, app_mode=False):
    if app_mode or (os.name == "nt" and (sys.stdout is None or sys.stderr is None)):
        desktop_win.show_error_dialog("Plan could not start", message.strip())
    ap.exit(1, message if message.endswith("\n") else message + "\n")


def main(argv=None):
    # Under pythonw.exe stdout/stderr are None; redirect before argparse or print can touch them.
    if os.name == "nt" and (sys.stdout is None or sys.stderr is None):
        desktop_win.ensure_stdio()
    ap = build_arg_parser()
    a = ap.parse_args(argv)
    if a.install_shortcut and a.uninstall_shortcut:
        ap.error("--install-shortcut and --uninstall-shortcut cannot be combined")
    if not 0 <= a.port <= 65535:
        ap.error("port must be between 0 and 65535")

    if a.install_shortcut or a.uninstall_shortcut:
        if os.name != "nt":
            _fatal_error(ap, "Windows desktop shortcuts can only be managed on Windows.\n", app_mode=a.app)
        try:
            if a.install_shortcut:
                paths = desktop_win.install_shortcuts(
                    desktop_win.repo_root_from_package(),
                    desktop=a.desktop,
                    port=a.port,
                    data_dir=a.data_dir,
                    profile_dir=a.profile_dir,
                    file_access=a.file_access,
                )
                for path in paths:
                    print(f"Installed shortcut: {path}", flush=True)
            else:
                removed = desktop_win.uninstall_shortcuts(desktop=a.desktop)
                if removed:
                    for path in removed:
                        print(f"Removed shortcut: {path}", flush=True)
                else:
                    print("No installed Plan shortcuts were found.", flush=True)
        except OSError as e:
            _fatal_error(ap, f"Could not update Plan shortcuts: {e}\n", app_mode=a.app)
        return

    if a.app and os.name == "nt":
        desktop_win.init_process_identity()

    try:
        directory = a.data_dir if a.data_dir is not None else default_data_dir()
    except OSError as e:
        _fatal_error(ap, f"Cannot locate Documents: {e}\n", app_mode=a.app)
    try:
        srv = create_server(a.port, directory, native_files=a.file_access == "native", app_mode=a.app)
    except OSError as e:
        # Double-clicking again reuses the running server for this database.
        try:
            with urlopen(f"http://127.0.0.1:{a.port}/api/health", timeout=2) as response:
                health = json.load(response)
            if health.get("app") != "plan-local" or health.get("dataFile") != str((directory / "plan.db").resolve()):
                raise ValueError("Different app or database")
        except (OSError, ValueError):
            _fatal_error(
                ap,
                f"Cannot start Plan on port {a.port}: {e}\nClose the other server or choose --port 5174.\n",
                app_mode=a.app,
            )
        url = f"http://127.0.0.1:{a.port}/"
        if try_focus_running_instance(a.port):
            print(f"Plan is already running (focused existing window): {url}", flush=True)
            return
        print(f"Plan is already running: {url}", flush=True)
        if not a.no_open:
            webbrowser.open(url)
        return
    with srv:
        url = f"http://127.0.0.1:{srv.server_port}/"
        tracker_thread = None
        if a.app and os.name == "nt" and not a.no_open:
            print(f"Plan desktop app is running: {url}\nApp state: {(directory / 'plan.db').resolve()}", flush=True)
            tracker_thread = threading.Thread(
                target=desktop_win.launch_and_track,
                args=(url, desktop_win.repo_root_from_package(), srv, srv.app_sessions),
                kwargs={
                    "port": srv.server_port,
                    "data_dir": a.data_dir,
                    "profile_dir": a.profile_dir,
                    "file_access": a.file_access,
                },
                name="plan-desktop-tracker",
                daemon=True,
            )
            tracker_thread.start()
        else:
            print(f"Plan is running: {url}\nApp state: {(directory / 'plan.db').resolve()}\nKeep this window open. Press Ctrl+C to stop.", flush=True)
            if not a.no_open:
                webbrowser.open(url)
        try:
            with contextlib.suppress(KeyboardInterrupt):
                srv.serve_forever()
        finally:
            srv.app_sessions.close_all()
            if tracker_thread is not None:
                tracker_thread.join(timeout=3)
            with srv.file_lock:
                if srv.file_service:
                    srv.file_service.close()
