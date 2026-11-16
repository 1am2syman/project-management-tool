"""Offline checks for the vendored Windows runtime; no third-party test tools."""
import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime" / "windows-x64"
MANIFEST = ROOT / "runtime" / "windows-x64.manifest.json"


class BundledRuntimeTests(unittest.TestCase):
    def test_all_upstream_files_match_checksums(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        files = manifest["files"]
        self.assertTrue(files)
        actual = {p.name for p in RUNTIME.iterdir() if p.is_file()}
        self.assertEqual(actual, set(files))
        for name, expected in files.items():
            with self.subTest(file=name):
                self.assertEqual(Path(name).name, name)
                self.assertRegex(expected, r"^[0-9a-f]{64}$")
                self.assertEqual(hashlib.sha256((RUNTIME / name).read_bytes()).hexdigest(), expected)

    def test_provenance_matches_upstream_sbom(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        sbom = json.loads((ROOT / "runtime" / f"python-{manifest['version']}-embed-amd64.spdx.json").read_text(encoding="utf-8"))
        package = next(p for p in sbom["packages"] if p["name"] == "CPython")
        self.assertEqual(manifest["platform"], "windows-x64")
        self.assertEqual(manifest["version"], package["versionInfo"])
        self.assertEqual(manifest["source"], package["downloadLocation"])
        self.assertEqual(manifest["source"], f"https://www.python.org/ftp/python/{manifest['version']}/python-{manifest['version']}-embed-amd64.zip")
        self.assertIn({"algorithm": "SHA256", "checksumValue": manifest["archive_sha256"]}, package["checksums"])
        self.assertIn("PYTHON SOFTWARE FOUNDATION LICENSE", (RUNTIME / "LICENSE.txt").read_text(encoding="utf-8"))

    def test_native_files_are_windows_x64(self):
        self.assertTrue((RUNTIME / "python.exe").is_file())
        self.assertTrue((RUNTIME / "_sqlite3.pyd").is_file())
        self.assertTrue((RUNTIME / "sqlite3.dll").is_file())
        self.assertTrue((RUNTIME / "_ctypes.pyd").is_file())
        for path in RUNTIME.iterdir():
            if path.suffix not in {".exe", ".dll", ".pyd"}:
                continue
            with self.subTest(file=path.name):
                raw = path.read_bytes()
                self.assertEqual(raw[:2], b"MZ")
                offset = struct.unpack_from("<I", raw, 0x3C)[0]
                self.assertEqual(raw[offset:offset + 4], b"PE\0\0")
                self.assertEqual(struct.unpack_from("<H", raw, offset + 4)[0], 0x8664)

    def test_isolated_standard_library_includes_server_modules(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        major, minor, _ = manifest["version"].split(".")
        stem = f"python{major}{minor}"
        paths = (RUNTIME / f"{stem}._pth").read_text(encoding="utf-8").splitlines()
        self.assertEqual([p for p in paths if p and not p.startswith("#")], [f"{stem}.zip", "."])
        with zipfile.ZipFile(RUNTIME / f"{stem}.zip") as library:
            self.assertIsNone(library.testzip())
            for module in ["argparse.pyc", "pathlib/__init__.pyc", "http/server.pyc", "sqlite3/__init__.pyc", "ctypes/__init__.pyc", "webbrowser.pyc", "encodings/__init__.pyc"]:
                self.assertIn(module, library.namelist())

    @unittest.skipUnless(sys.platform == "win32", "Executing the Windows interpreter requires Windows")
    def test_bundled_interpreter_can_launch_app_from_another_directory(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(prefix="Plan runtime test ") as work:
            version = subprocess.run([str(RUNTIME / "python.exe"), "--version"], cwd=work, capture_output=True, text=True, timeout=10)
            self.assertEqual(version.returncode, 0, version.stderr)
            self.assertEqual(version.stdout.strip(), f"Python {manifest['version']}")
            result = subprocess.run([str(RUNTIME / "python.exe"), "-B", str(ROOT / "start.py"), "--help"], cwd=work, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("--data-dir", result.stdout)
            self.assertIn("--no-open", result.stdout)


if __name__ == "__main__":
    unittest.main()
