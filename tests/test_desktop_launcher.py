"""Unit tests for the desktop app launcher, shortcut builder, session tracker, and icon assets."""
import io
import json
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

from src import project_management_tool as app
from src.project_management_tool import build_arg_parser, create_server, desktop_win, try_focus_running_instance

ROOT = Path(__file__).resolve().parents[1]


class DesktopLauncherUnitTests(unittest.TestCase):
    def test_plan_ico_is_valid_multi_size_icon(self):
        ico = ROOT / "src" / "project_management_tool" / "web" / "plan.ico"
        self.assertTrue(ico.is_file())
        raw = ico.read_bytes()
        reserved, icon_type, count = struct.unpack_from("<HHH", raw, 0)
        self.assertEqual((reserved, icon_type), (0, 1))
        self.assertGreaterEqual(count, 5)
        sizes = set()
        for i in range(count):
            w, h, *_ = struct.unpack_from("<BBBBHHII", raw, 6 + i * 16)
            sizes.add(w or 256)
            self.assertEqual(w, h)
        self.assertTrue({16, 32, 48, 256}.issubset(sizes))

    def test_arg_parser_flags_preserve_test_defaults_and_support_desktop_options(self):
        ap = build_arg_parser()
        default = ap.parse_args([])
        self.assertEqual(default.port, 5173)
        self.assertFalse(default.app)
        self.assertFalse(default.install_shortcut)
        self.assertFalse(default.uninstall_shortcut)
        self.assertFalse(default.desktop)
        self.assertIsNone(default.profile_dir)
        self.assertEqual(default.file_access, "native")

        test_mode = ap.parse_args(["--port", "0", "--data-dir", "/tmp/data", "--no-open", "--file-access", "off"])
        self.assertEqual(test_mode.port, 0)
        self.assertTrue(test_mode.no_open)
        self.assertEqual(test_mode.file_access, "off")
        self.assertFalse(test_mode.app)

        app_mode = ap.parse_args(["--app", "--profile-dir", "/tmp/shell", "--port", "5174"])
        self.assertTrue(app_mode.app)
        self.assertEqual(app_mode.port, 5174)
        self.assertEqual(app_mode.profile_dir, Path("/tmp/shell"))

        shortcut = ap.parse_args(["--install-shortcut", "--desktop"])
        self.assertTrue(shortcut.install_shortcut)
        self.assertTrue(shortcut.desktop)

    def test_shortcut_spec_construction_handles_spaces_and_optional_flags(self):
        with tempfile.TemporaryDirectory(prefix="Plan folder with spaces ") as tmp:
            repo = Path(tmp)
            runtime_dir = repo / "runtime" / "windows-x64"
            runtime_dir.mkdir(parents=True)
            pythonw = runtime_dir / "pythonw.exe"
            pythonw.write_bytes(b"MZ")
            web_dir = repo / "src" / "project_management_tool" / "web"
            web_dir.mkdir(parents=True)
            ico = web_dir / "plan.ico"
            ico.write_bytes(b"\x00\x00\x01\x00")

            spec = desktop_win.build_shortcut_spec(repo)
            self.assertEqual(spec.target, str(pythonw.resolve()))
            self.assertEqual(spec.arguments, "-B start.py --app")
            self.assertEqual(spec.working_dir, str(repo.resolve()))
            self.assertEqual(spec.icon_path, str(ico.resolve()))
            self.assertEqual(spec.aumid, desktop_win.AUMID)
            self.assertIn(str((repo / "start.py").resolve()), spec.relaunch_command)
            self.assertIn("--app", spec.relaunch_command)
            self.assertEqual(spec.relaunch_display_name, "Plan")
            self.assertEqual(spec.relaunch_icon_resource, f"{ico.resolve()},0")

            custom = desktop_win.build_shortcut_spec(repo, port=5174, data_dir=repo / "db dir", profile_dir=repo / "prof")
            self.assertIn("--port 5174", custom.arguments)
            self.assertIn("--data-dir", custom.arguments)
            self.assertIn("--profile-dir", custom.arguments)
            self.assertIn("--port 5174", custom.relaunch_command)

    def test_batch_launch_installs_both_shortcuts_and_starts_pythonw_with_custom_options(self):
        with tempfile.TemporaryDirectory(prefix="Plan launch with spaces ") as tmp:
            repo = Path(tmp)
            runtime = repo / "runtime" / "windows-x64"
            runtime.mkdir(parents=True)
            pythonw = runtime / "pythonw.exe"
            pythonw.write_bytes(b"MZ")
            options = {"port": 5174, "data_dir": repo / "saved data", "profile_dir": repo / "app profile", "file_access": "off"}
            with (
                mock.patch.object(desktop_win, "install_shortcuts") as install,
                mock.patch.object(desktop_win.subprocess, "Popen") as spawn,
            ):
                desktop_win.launch_desktop_app(repo, port=5174, data_dir=repo / "saved data",
                                               profile_dir=repo / "app profile", file_access="off")
            install.assert_called_once_with(repo.resolve(), desktop=True, **options)
            spawn.assert_called_once_with([
                str(pythonw.resolve()), "-B", str(repo.resolve() / "start.py"), "--app",
                "--port", "5174", "--data-dir", str((repo / "saved data").resolve()),
                "--profile-dir", str((repo / "app profile").resolve()), "--file-access", "off",
            ], cwd=str(repo.resolve()))
            self.assertNotIn("--desktop-launch", spawn.call_args.args[0])

    def test_batch_launch_reports_missing_pythonw_before_installing_shortcuts(self):
        with (
            mock.patch.object(desktop_win, "resolve_pythonw_path", return_value=Path("python.exe")),
            mock.patch.object(desktop_win, "install_shortcuts") as install,
            mock.patch.object(desktop_win.subprocess, "Popen") as spawn,
            self.assertRaisesRegex(OSError, "pythonw.exe runtime is missing"),
        ):
            desktop_win.launch_desktop_app(ROOT)
        install.assert_not_called()
        spawn.assert_not_called()

    def test_batch_launch_does_not_start_app_after_shortcut_install_failure(self):
        with (
            mock.patch.object(desktop_win, "install_shortcuts", side_effect=OSError("Start Menu is read-only")),
            mock.patch.object(desktop_win.subprocess, "Popen") as spawn,
            self.assertRaisesRegex(OSError, "Start Menu is read-only"),
        ):
            desktop_win.launch_desktop_app(ROOT)
        spawn.assert_not_called()

    def test_desktop_launch_cli_hands_off_without_starting_console_server(self):
        with (
            mock.patch.object(app, "os") as platform_os,
            mock.patch.object(desktop_win, "launch_desktop_app") as launch,
            mock.patch.object(app, "create_server") as server,
            mock.patch.object(app.webbrowser, "open") as browser,
        ):
            platform_os.name = "nt"
            app.main(["--desktop-launch", "--port", "5174", "--data-dir", "saved data",
                      "--profile-dir", "app profile", "--file-access", "off"])
        launch.assert_called_once_with(ROOT, port=5174, data_dir=Path("saved data"),
                                       profile_dir=Path("app profile"), file_access="off")
        server.assert_not_called()
        browser.assert_not_called()

    def test_desktop_launch_cli_reports_failures_and_invalid_arguments(self):
        with (
            mock.patch.object(app, "os") as platform_os,
            mock.patch.object(desktop_win, "launch_desktop_app", side_effect=OSError("Access denied")) as launch,
            mock.patch.object(sys, "stderr", new_callable=io.StringIO) as stderr,
        ):
            platform_os.name = "nt"
            with self.assertRaises(SystemExit) as error:
                app.main(["--desktop-launch"])
            self.assertEqual(error.exception.code, 1)
            self.assertIn("Could not launch Plan: Access denied", stderr.getvalue())
            launch.reset_mock()
            for flags in (["--port", "65536"], ["--install-shortcut", "--uninstall-shortcut"]):
                with self.subTest(flags=flags), self.assertRaises(SystemExit) as invalid:
                    app.main(["--desktop-launch", *flags])
                self.assertEqual(invalid.exception.code, 2)
            launch.assert_not_called()

    def test_desktop_launch_cli_preserves_explicit_shortcut_management(self):
        with (
            mock.patch.object(app, "os") as platform_os,
            mock.patch.object(desktop_win, "launch_desktop_app") as launch,
            mock.patch.object(desktop_win, "install_shortcuts", return_value=[]) as install,
            mock.patch.object(desktop_win, "uninstall_shortcuts", return_value=[]) as uninstall,
            mock.patch.object(sys, "stdout", new_callable=io.StringIO),
        ):
            platform_os.name = "nt"
            app.main(["--desktop-launch", "--install-shortcut", "--desktop"])
            install.assert_called_once_with(ROOT, desktop=True, port=5173, data_dir=None,
                                            profile_dir=None, file_access="native")
            app.main(["--desktop-launch", "--uninstall-shortcut", "--desktop"])
            uninstall.assert_called_once_with(desktop=True)
            launch.assert_not_called()

    def test_app_launch_does_not_reopen_a_browser_tab_for_an_old_console_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            health = io.BytesIO(json.dumps({"app": "plan-local", "dataFile": str((data / "plan.db").resolve())}).encode())
            with (
                mock.patch.object(app, "os") as platform_os,
                mock.patch.object(app, "create_server", side_effect=OSError("Port in use")),
                mock.patch.object(app, "urlopen", return_value=health),
                mock.patch.object(app, "try_focus_running_instance", return_value=False),
                mock.patch.object(desktop_win, "init_process_identity"),
                mock.patch.object(desktop_win, "show_error_dialog") as dialog,
                mock.patch.object(app.webbrowser, "open") as browser,
                mock.patch.object(sys, "stderr", new_callable=io.StringIO),
                self.assertRaises(SystemExit) as error,
            ):
                platform_os.name = "nt"
                app.main(["--app", "--data-dir", str(data)])
            self.assertEqual(error.exception.code, 1)
            self.assertIn("Close the existing Plan window and its launcher", dialog.call_args.args[1])
            browser.assert_not_called()

    def test_desktop_launch_no_open_keeps_server_in_console_without_installing(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            server = mock.MagicMock(server_port=5174, file_service=None)
            with (
                mock.patch.object(app, "os") as platform_os,
                mock.patch.object(desktop_win, "launch_desktop_app") as launch,
                mock.patch.object(app, "create_server", return_value=server) as create,
                mock.patch.object(app.webbrowser, "open") as browser,
                mock.patch.object(sys, "stdout", new_callable=io.StringIO),
            ):
                platform_os.name = "nt"
                app.main(["--desktop-launch", "--no-open", "--port", "5174", "--data-dir", str(data),
                          "--file-access", "off"])
            create.assert_called_once_with(5174, data, native_files=False, app_mode=False)
            server.serve_forever.assert_called_once()
            launch.assert_not_called()
            browser.assert_not_called()

    def test_prepare_profile_seeds_first_run_and_preserves_existing_preferences(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "shell"
            default_dir = profile / "Default"
            default_dir.mkdir(parents=True)
            prefs_path = default_dir / "Preferences"
            prefs_path.write_text(json.dumps({
                "browser": {"window_placement": {"left": 40, "top": 50, "right": 1240, "bottom": 850}},
                "custom_key": "keep-me",
            }), encoding="utf-8")

            desktop_win.prepare_profile(profile)
            self.assertTrue((profile / "First Run").is_file())
            prefs = json.loads(prefs_path.read_text(encoding="utf-8"))
            self.assertEqual(prefs["custom_key"], "keep-me")
            self.assertEqual(prefs["browser"]["window_placement"]["left"], 40)
            self.assertTrue(prefs["browser"]["has_seen_welcome_page"])
            self.assertFalse(prefs["background_mode"]["enabled"])
            self.assertFalse(prefs["signin"]["allowed"])

            # Corrupt Preferences should not raise or overwrite user data.
            prefs_path.write_text("{broken json", encoding="utf-8")
            desktop_win.prepare_profile(profile)
            self.assertEqual(prefs_path.read_text(encoding="utf-8"), "{broken json")

    def test_find_browser_prefers_edge_then_chrome_then_none(self):
        edge = Path("C:/Edge/msedge.exe")
        chrome = Path("C:/Chrome/chrome.exe")

        found = desktop_win.find_browser(
            env={},
            registry_lookup=lambda exe: str(edge) if exe == "msedge.exe" else str(chrome),
            exists=lambda p: p in (edge, chrome),
        )
        self.assertEqual(found, edge)

        found_chrome = desktop_win.find_browser(
            env={},
            registry_lookup=lambda exe: str(chrome) if exe == "chrome.exe" else None,
            exists=lambda p: p == chrome,
        )
        self.assertEqual(found_chrome, chrome)

        none_found = desktop_win.find_browser(env={}, registry_lookup=lambda _: None, exists=lambda _: False)
        self.assertIsNone(none_found)

    def test_pick_new_app_window_rejects_unrelated_windows_and_matches_pid_or_exact_plan_title(self):
        before = {100, 200}
        current = [
            {"hwnd": 100, "pid": 10, "title": "Existing Edge"},
            {"hwnd": 250, "pid": 10, "title": "Business plan.docx - Google Chrome"},
            {"hwnd": 260, "pid": 10, "title": "New Tab - Microsoft Edge"},
            {"hwnd": 270, "pid": 10, "title": "http://127.0.0.1:9999/"},
        ]
        # Unrelated Chrome/Edge windows (even containing "plan" or another loopback port) must be rejected.
        self.assertIsNone(desktop_win.pick_new_app_window(before, current, spawned_pid=99, port=5173))

        # Spawned PID (or a child PID in spawned_tree_pids) is accepted even before title renders.
        with_spawned = [*current, {"hwnd": 400, "pid": 99, "title": "Untitled"}]
        self.assertEqual(desktop_win.pick_new_app_window(before, with_spawned, spawned_pid=99, port=5173), 400)
        with_child = [*current, {"hwnd": 401, "pid": 105, "title": "Untitled"}]
        self.assertEqual(
            desktop_win.pick_new_app_window(before, with_child, spawned_pid=99, port=5173, spawned_tree_pids={99, 105}),
            401,
        )

        # GPO/delegated merge: different PID is accepted only for exact Plan titles or matching loopback port.
        for title in ("Launch plan — Plan", "Plan — project sheet & gantt", "127.0.0.1:5173"):
            with_delegated = [*current, {"hwnd": 300, "pid": 10, "title": title}]
            self.assertEqual(desktop_win.pick_new_app_window(before, with_delegated, spawned_pid=99, port=5173), 300)

    def test_launch_and_track_stops_late_window_adoption_after_discovery_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            profile = Path(tmp) / "shell"
            repo.mkdir()
            tracker = desktop_win.AppSessionTracker()
            sid = tracker.register_session()
            server = mock.Mock()

            fake_now = [0.0]
            late_window = {"hwnd": 999, "pid": 777, "title": "Launch plan — Plan"}

            def fake_monotonic():
                return fake_now[0]

            def fake_sleep(dt):
                fake_now[0] += dt
                # Disconnect SSE well after the 30s discovery deadline so the loop terminates cleanly.
                if fake_now[0] >= 35.0:
                    tracker.unregister_session(sid)

            def fake_enum():
                # No windows during startup or within 30s; a new window only appears after 31s.
                if fake_now[0] >= 31.0:
                    return [late_window]
                return []

            fake_proc = mock.Mock(pid=123)
            fake_proc.poll.return_value = 0

            with (
                mock.patch.object(desktop_win, "find_browser", return_value=Path("msedge.exe")),
                mock.patch.object(desktop_win.subprocess, "Popen", return_value=fake_proc),
                mock.patch.object(desktop_win, "enumerate_chromium_windows", side_effect=fake_enum),
                mock.patch.object(desktop_win, "process_tree_pids", return_value={123}),
                mock.patch.object(desktop_win, "stamp_window_identity", return_value=True) as stamp,
                mock.patch.object(desktop_win, "is_window_alive", return_value=True),
                mock.patch.object(desktop_win.time, "monotonic", side_effect=fake_monotonic),
                mock.patch.object(desktop_win.time, "sleep", side_effect=fake_sleep),
            ):
                desktop_win.launch_and_track(
                    "http://127.0.0.1:5173/",
                    repo,
                    server,
                    tracker,
                    port=5173,
                    profile_dir=profile,
                    startup_timeout=60.0,
                    late_discovery_window=30.0,
                )

            stamp.assert_not_called()
            server.shutdown.assert_called_once()

    def test_app_lifecycle_shutdown_state_machine(self):
        # Default startup_timeout gives slow corporate first-runs 60s before timing out.
        default_lc = desktop_win.AppLifecycle(0.0)
        self.assertEqual(default_lc.startup_timeout, 60.0)
        self.assertFalse(default_lc.should_shutdown(55.0, live_window_count=0, active_session_count=0))
        self.assertTrue(default_lc.should_shutdown(60.0, live_window_count=0, active_session_count=0))

        # Normal tracked HWND + SSE: F5 keeps HWND alive; closing both exits after window_close_grace.
        lc = desktop_win.AppLifecycle(0.0, startup_timeout=60.0, window_close_grace=1.0, session_only_grace=3.0)
        self.assertFalse(lc.should_shutdown(0.5, live_window_count=1, active_session_count=0))
        self.assertFalse(lc.should_shutdown(1.0, live_window_count=1, active_session_count=1))
        # F5 reload drops SSE briefly while HWND remains alive.
        self.assertFalse(lc.should_shutdown(1.5, live_window_count=1, active_session_count=0))
        self.assertFalse(lc.should_shutdown(2.0, live_window_count=1, active_session_count=1))
        # Window closes & SSE disconnects.
        self.assertFalse(lc.should_shutdown(2.5, live_window_count=0, active_session_count=0))
        self.assertTrue(lc.should_shutdown(3.1, live_window_count=0, active_session_count=0))

        # GPO fallback (no tracked HWND, SSE only): survives F5 reload within session_only_grace.
        gpo = desktop_win.AppLifecycle(0.0, startup_timeout=60.0, window_close_grace=1.0, session_only_grace=3.0)
        self.assertFalse(gpo.should_shutdown(1.0, live_window_count=0, active_session_count=1))
        self.assertFalse(gpo.should_shutdown(2.5, live_window_count=0, active_session_count=0))  # 1.5s < 3.0s
        self.assertFalse(gpo.should_shutdown(2.8, live_window_count=0, active_session_count=1))  # reconnected
        self.assertFalse(gpo.should_shutdown(4.0, live_window_count=0, active_session_count=0))  # 1.2s < 3.0s
        self.assertTrue(gpo.should_shutdown(5.9, live_window_count=0, active_session_count=0))   # 3.1s >= 3.0s

        # Startup timeout when browser never opens window or session.
        stuck = desktop_win.AppLifecycle(0.0, startup_timeout=10.0)
        self.assertFalse(stuck.should_shutdown(9.5, live_window_count=0, active_session_count=0))
        self.assertTrue(stuck.should_shutdown(10.0, live_window_count=0, active_session_count=0))

    def test_ensure_stdio_redirects_none_streams_to_bounded_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_file = Path(tmp) / "Plan" / "launcher.log"
            log_file.parent.mkdir(parents=True)
            log_file.write_bytes(b"x" * 2048)
            orig_out, orig_err = sys.stdout, sys.stderr
            stream = None
            try:
                sys.stdout = None
                sys.stderr = None
                chosen = desktop_win.ensure_stdio(log_file, max_bytes=1024)
                self.assertEqual(chosen, log_file)
                self.assertIsNotNone(sys.stdout)
                self.assertIsNotNone(sys.stderr)
                print("hello launcher", flush=True)
                stream = sys.stdout
            finally:
                sys.stdout, sys.stderr = orig_out, orig_err
                if stream is not None and stream not in (orig_out, orig_err):
                    stream.close()
            content = log_file.read_text(encoding="utf-8")
            self.assertIn("hello launcher", content)
            self.assertLess(len(content), 1500)


class DesktopServerEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name) / "data"

    def _start(self, *, app_mode):
        server = create_server(0, self.data_dir, native_files=False, app_mode=app_mode)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.app_sessions.close_all()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.addCleanup(stop)
        return server

    def test_ico_mime_and_fingerprint_include_plan_ico(self):
        server = self._start(app_mode=False)
        with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as conn:
            conn.request("GET", "/plan.ico")
            resp = conn.getresponse()
            body = resp.read()
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "image/x-icon")
        self.assertEqual(body[:4], b"\x00\x00\x01\x00")

        # Non-app mode returns 204 No Content on /api/app-session immediately.
        with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as conn:
            conn.request("GET", "/api/app-session")
            resp = conn.getresponse()
            resp.read()
        self.assertEqual(resp.status, 204)

    def test_app_session_sse_tracks_connection_disconnect_and_clean_shutdown(self):
        server = self._start(app_mode=True)
        sock = socket.create_connection(("127.0.0.1", server.server_port), timeout=5)
        try:
            sock.sendall(f"GET /api/app-session HTTP/1.1\r\nHost: 127.0.0.1:{server.server_port}\r\n\r\n".encode())
            sock.settimeout(5)
            chunk = sock.recv(4096)
            self.assertIn(b"200 OK", chunk)
            self.assertIn(b"text/event-stream", chunk)
            deadline = time.monotonic() + 2.0
            while server.app_sessions.active_session_count() != 1 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(server.app_sessions.active_session_count(), 1)
        finally:
            sock.close()

        # Server detects closed socket quickly without waiting for a heartbeat.
        deadline = time.monotonic() + 2.0
        while server.app_sessions.active_session_count() != 0 and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(server.app_sessions.active_session_count(), 0)

    def test_window_focus_endpoint_auth_and_single_instance_helper(self):
        server = self._start(app_mode=True)
        focused_calls = []
        server.app_sessions.set_focus_callback(lambda hwnd: focused_calls.append(hwnd) or True)
        server.app_sessions.add_hwnd(123456)

        # Reject missing header or cross-origin.
        with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as conn:
            conn.request("POST", "/api/window/focus", body=b"", headers={"Content-Length": "0"})
            self.assertEqual(conn.getresponse().status, 403)
        with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as conn:
            conn.request("POST", "/api/window/focus", body=b"",
                         headers={"Content-Length": "0", "X-Plan-Instance": "1", "Origin": "https://evil.example"})
            self.assertEqual(conn.getresponse().status, 403)

        # Valid local instance request focuses active window.
        with mock.patch("src.project_management_tool.desktop_win.focus_window", return_value=True):
            self.assertTrue(try_focus_running_instance(server.server_port))
        self.assertEqual(focused_calls, [123456])


if __name__ == "__main__":
    unittest.main()
