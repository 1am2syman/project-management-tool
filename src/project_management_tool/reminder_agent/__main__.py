"""Maintainer feasibility commands; normal end users continue to use start.bat."""
import argparse
import json
import sys
import threading
from pathlib import Path

from . import AgentError
from .protected import atomic_write, private_root
from .service import FeasibilityService
from .worker import install_signals, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["run", "status", "connect", "disconnect", "install", "remove", "send-test"])
    parser.add_argument("--data-dir", required=True, type=Path, help="Isolated feasibility data directory; never use production projects")
    parser.add_argument("--source-version", help="Expected installed source fingerprint (required by task runner)")
    args = parser.parse_args()
    if args.action == "run" and not args.source_version:
        parser.error("run requires --source-version")
    try:
        if args.action == "run":
            stop = threading.Event()
            install_signals(stop)
            run(args.data_dir, args.source_version, stop=stop)
            return 0
        service = FeasibilityService(args.data_dir)
        value = service.status() if args.action == "status" else service.action(args.action)
        if sys.stdout is not None:
            print(json.dumps(value, ensure_ascii=False))
        return 0
    except AgentError as error:
        value = error.status()
    except Exception:  # noqa: BLE001 -- final pythonw boundary must record redacted unexpected failures.
        # pythonw has no stderr. Keep bounded failure evidence without exception
        # text, stack locals, tokens, HTTP responses or private paths.
        value = {"state": "worker_failed", "message": "The native feasibility worker stopped unexpectedly. Check the isolated test setup."}
    try:
        root = private_root(args.data_dir)
        atomic_write(root / "feasibility-error.json", json.dumps(value).encode())
    except (AgentError, OSError):
        pass
    if sys.stdout is not None:
        print(json.dumps(value))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
