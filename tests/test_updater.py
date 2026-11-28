"""Exercise the real updater in cmd.exe against disposable local Git repositories."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "win32" and shutil.which("git"),
                     "The updater requires Windows cmd.exe and Git")
class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="Plan updater test ")
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.remote = self.root / "published.git"
        self.seed = self.root / "publisher"
        self.checkout = self.root / "installed app"
        self.env = os.environ.copy()
        # Do not inherit a developer identity, hooks, or global Git settings.
        for key in list(self.env):
            if key.startswith("GIT_"):
                del self.env[key]
        config = self.root / "empty.gitconfig"
        config.write_text("", encoding="utf-8")
        self.env.update(GIT_CONFIG_GLOBAL=str(config), GIT_CONFIG_NOSYSTEM="1",
                        GIT_TERMINAL_PROMPT="0")
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.git(self.root, "clone", str(self.remote), str(self.seed))
        self.script = (ROOT / "update.bat").read_bytes()
        (self.seed / "update.bat").write_bytes(self.script)
        (self.seed / ".gitattributes").write_text("*.bat text eol=crlf\n", encoding="ascii")
        (self.seed / ".gitignore").write_text("__pycache__/\n*.tmp\n", encoding="ascii")
        (self.seed / "src").mkdir()
        (self.seed / "src" / "app.txt").write_text("old version\n", encoding="ascii")
        self.commit("Original version")
        self.git(self.seed, "push", "origin", "main")
        self.git(self.root, "clone", str(self.remote), str(self.checkout))
        self.old_head = self.git(self.checkout, "rev-parse", "HEAD").strip()
        (self.seed / ".gitattributes").write_text(
            "*.bat text eol=crlf\n*.ico binary\n", encoding="ascii")
        (self.seed / "src" / "app.txt").write_text("published version\n", encoding="ascii")
        # Replace the running batch file with a longer version during the update.
        (self.seed / "update.bat").write_bytes(
            self.script + b"\r\nrem Published updater extension\r\n" * 50)
        self.commit("Published update")
        self.git(self.seed, "push", "origin", "main")
        self.new_head = self.git(self.seed, "rev-parse", "HEAD").strip()

    def git(self, cwd, *args):
        result = subprocess.run(["git", *args], check=False, cwd=cwd, env=self.env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def commit(self, message):
        self.git(self.seed, "add", ".")
        self.git(self.seed, "-c", "user.name=Test publisher", "-c",
                 "user.email=test@localhost", "commit", "-m", message)

    def change_local_files(self):
        # Reproduce the reported .gitattributes conflict, including staged changes.
        (self.checkout / ".gitattributes").write_text("# local settings\n", encoding="ascii")
        self.git(self.checkout, "add", ".gitattributes")
        (self.checkout / "src" / "notes.txt").write_text("keep these notes\n", encoding="ascii")
        (self.checkout / "update.bat").write_bytes(self.script + b"\r\nrem Local edit\r\n")

    def run_updater(self, answer):
        # CALL reliably propagates EXIT /B when the batch replaces itself.
        result = subprocess.run([os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c",
                                 "call", "update.bat"],
                                check=False, cwd=self.checkout, env=self.env, input=answer,
                                capture_output=True, text=True, timeout=60)
        self.assertNotIn("was unexpected at this time", result.stdout + result.stderr)
        return result, result.stdout + result.stderr

    def assert_updated(self):
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD").strip(), self.new_head)
        self.assertEqual(self.git(self.checkout, "status", "--porcelain"), "")
        self.assertEqual((self.checkout / "src" / "app.txt").read_text(), "published version\n")
        self.assertEqual((self.checkout / "update.bat").read_bytes(),
                         (self.seed / "update.bat").read_bytes())

    def test_backup_then_update_preserves_local_files(self):
        self.change_local_files()
        result, output = self.run_updater("1\n\n")
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("Choose 1 or 2", output)
        self.assertIn("Backup saved", output)
        self.assertIn("Plan is up to date", output)
        self.assert_updated()
        self.assertEqual(self.git(self.checkout, "stash", "list").count("Set aside by update.bat"), 1)
        self.assertEqual(self.git(self.checkout, "show", "stash@{0}:.gitattributes"), "# local settings\n")
        self.assertIn("Local edit", self.git(self.checkout, "show", "stash@{0}:update.bat"))
        self.assertEqual(self.git(self.checkout, "show", "stash@{0}^3:src/notes.txt"), "keep these notes\n")

    def test_cancel_preserves_head_files_index_and_stash(self):
        self.change_local_files()
        before = self.git(self.checkout, "status", "--porcelain")
        result, output = self.run_updater("2\n\n")
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("Update cancelled", output)
        self.assertNotIn("Plan is up to date", output)
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD").strip(), self.old_head)
        self.assertEqual(self.git(self.checkout, "status", "--porcelain"), before)
        self.assertEqual(self.git(self.checkout, "stash", "list"), "")
        self.assertEqual((self.checkout / ".gitattributes").read_text(), "# local settings\n")
        self.assertEqual((self.checkout / "src" / "notes.txt").read_text(), "keep these notes\n")
        self.assertTrue((self.checkout / "update.bat").read_bytes().endswith(b"rem Local edit\r\n"))

    def test_no_input_does_not_replace_files(self):
        self.change_local_files()
        before = self.git(self.checkout, "status", "--porcelain")
        _, output = self.run_updater("")
        self.assertNotIn("Plan is up to date", output)
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD").strip(), self.old_head)
        self.assertEqual(self.git(self.checkout, "status", "--porcelain"), before)
        self.assertEqual(self.git(self.checkout, "stash", "list"), "")

    @contextmanager
    def lock_directory(self, path):
        # Hold a real directory handle without FILE_SHARE_DELETE, matching a
        # Windows process that prevents Git from removing an empty cache folder.
        if sys.platform != "win32":
            raise RuntimeError("Directory locking requires Windows")
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
                                      wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.CreateFileW(str(path), 1, 3, None, 3, 0x02000000, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            yield
        finally:
            kernel.CloseHandle(handle)

    def test_locked_python_caches_do_not_block_clean_or_backup_update(self):
        cache = self.checkout / "src" / "project_management_tool" / "__pycache__"
        cache.mkdir(parents=True)
        bytecode = cache / "old.cpython-311.pyc"
        bytecode.write_bytes(b"cached bytecode")
        empty_cache = self.checkout / "src" / "removed_module" / "__pycache__"
        empty_cache.mkdir(parents=True)
        for local_changes in (False, True):
            with self.subTest(local_changes=local_changes):
                if local_changes:
                    self.change_local_files()
                # Ignored stray source still needs cleanup, including a sibling
                # in a removed package whose locked cache must be preserved.
                stale = empty_cache.parent / "old.tmp"
                stale.write_text("obsolete source", encoding="ascii")
                with self.lock_directory(empty_cache), bytecode.open("rb"):
                    result, output = self.run_updater("1\n\n" if local_changes else "\n")
                self.assertEqual(result.returncode, 0, output)
                self.assertNotIn("Should I try again", output)
                self.assertIn("Plan is up to date", output)
                self.assertEqual("Backup saved" in output, local_changes)
                self.assertEqual(bytecode.read_bytes(), b"cached bytecode")
                self.assertTrue(empty_cache.is_dir())
                self.assertFalse(stale.exists())
                self.assert_updated()

    def test_locked_tracked_file_stops_then_recovers_after_release(self):
        with (self.checkout / "src" / "app.txt").open("rb"):
            result, output = self.run_updater("\n")
        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn("Update did not finish", output)
        self.assertNotIn("Should I try again", output)
        self.assertNotIn("Plan is up to date", output)
        result, output = self.run_updater("1\n\n")
        self.assertEqual(result.returncode, 0, output)
        self.assert_updated()

    def test_locked_ignored_source_stops_then_recovers_after_release(self):
        stale = self.checkout / "src" / "obsolete.tmp"
        stale.write_text("obsolete source", encoding="ascii")
        with stale.open("rb"):
            result, output = self.run_updater("\n")
        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn("Update did not finish", output)
        self.assertNotIn("Should I try again", output)
        self.assertNotIn("Plan is up to date", output)
        self.assertTrue(stale.exists())
        result, output = self.run_updater("\n")
        self.assertEqual(result.returncode, 0, output)
        self.assertFalse(stale.exists())
        self.assert_updated()

    def test_clean_update_and_repeat_do_not_prompt(self):
        for _ in range(2):
            result, output = self.run_updater("\n")
            self.assertEqual(result.returncode, 0, output)
            self.assertNotIn("Choose 1 or 2", output)
            self.assertIn("Plan is up to date", output)
            self.assert_updated()
            self.assertEqual(self.git(self.checkout, "stash", "list"), "")


if __name__ == "__main__":
    unittest.main()
