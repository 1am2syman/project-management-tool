"""Maintainer-only Windows CPython 3.14 dependency vendoring; never called at startup."""
import argparse
import hashlib
import io
import json
import shutil
import tempfile
import zipfile
from http.client import HTTPSConnection
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "tools/native-auth-wheels.json"
TARGET = ROOT / "runtime/native-auth/windows-x64"


def download(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in {"pypi.org", "files.pythonhosted.org"} or parsed.username or parsed.password or parsed.port not in {None, 443}:
        raise ValueError("Untrusted artifact host")
    connection = HTTPSConnection(parsed.hostname, timeout=60)
    try:
        connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else ""))
        response = connection.getresponse()
        if response.status != 200:
            raise OSError(f"Artifact request failed with HTTP {response.status}")
        return response.read()
    finally:
        connection.close()


def compatible(filename):
    # This bundle is specifically for the ordinary (non-free-threaded) x64 3.14 runtime.
    _, python, abi, platform = filename[:-4].rsplit("-", 3)
    if platform == "any" and abi == "none" and "py3" in python.split("."):
        return 1
    if platform == "win_amd64":
        if python == "cp314" and abi == "cp314":
            return 3
        if abi == "abi3" and python.startswith("cp3") and python[3:].isdigit() and 9 <= int(python[3:]) <= 14:
            return 2
    return 0


def refresh_lock():
    artifacts = []
    for line in (ROOT / "tools/native-auth-requirements.txt").read_text().splitlines():
        name, version = line.split("==")
        try:
            metadata = json.loads(download(f"https://pypi.org/pypi/{name}/{version}/json"))
        except (OSError, ValueError) as error:
            raise RuntimeError(f"Cannot resolve pinned package {name}") from error
        choices = [p for p in metadata["urls"] if p["filename"].endswith(".whl") and compatible(p["filename"]) and not p["yanked"]]
        if not choices:
            raise ValueError(f"No compatible wheel for {name} {version}")
        wheel = max(choices, key=lambda p: (compatible(p["filename"]), p["filename"]))
        artifacts.append({"name": name, "version": version, "filename": wheel["filename"], "url": wheel["url"], "sha256": wheel["digests"]["sha256"]})
    LOCK.write_text(json.dumps({"python": "3.14", "platform": "win_amd64", "artifacts": artifacts}, indent=2) + "\n")


def vendor():
    try:
        lock = json.loads(LOCK.read_text())
    except (OSError, ValueError) as error:
        raise RuntimeError("Cannot read the native authentication wheel lock") from error
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=TARGET.parent) as temporary:
        output = Path(temporary) / "bundle"
        output.mkdir()
        for item in lock["artifacts"]:
            raw = download(item["url"])
            if hashlib.sha256(raw).hexdigest() != item["sha256"]:
                raise ValueError("Artifact checksum mismatch")
            with zipfile.ZipFile(io.BytesIO(raw)) as wheel:
                for name in wheel.namelist():
                    path = Path(name)
                    if path.is_absolute() or ".." in path.parts or "\\" in name:
                        raise ValueError("Unsafe wheel member")
                wheel.extractall(output)
        files = {p.relative_to(output).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(output.rglob("*")) if p.is_file()}
        (output / "manifest.json").write_text(json.dumps({"schema": 1, "artifacts": lock["artifacts"], "files": files}, indent=2) + "\n")
        try:
            if TARGET.exists():
                shutil.rmtree(TARGET)
            shutil.move(str(output), TARGET)
        except OSError as error:
            raise RuntimeError("Cannot replace the native authentication bundle; restore it before release") from error
    print("Native authentication dependencies vendored and checksummed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-lock", action="store_true", help="Resolve the pinned versions to exact PyPI wheel URLs/hashes")
    args = parser.parse_args()
    if args.refresh_lock:
        refresh_lock()
    vendor()
