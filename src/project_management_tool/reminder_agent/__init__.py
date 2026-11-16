"""Native Windows reminder feasibility components.

Scheduler ownership stays with the existing browser implementation until the
Windows/mail feasibility and legacy-migration release gates have passed.
"""
import sys
from pathlib import Path


class AgentError(Exception):
    """An intentionally bounded, non-secret status suitable for the local UI."""

    def __init__(self, code, message, retry_after=None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after

    def status(self):
        return {"state": self.code, "message": str(self)}


def load_dependencies():
    # Explicitly trusted release directory; never enable site or use pip at startup.
    root = Path(__file__).resolve().parents[3] / "runtime/native-auth/windows-x64"
    if sys.platform != "win32":
        raise AgentError("unsupported_platform", "Native reminders require Windows 10/11 x64.")
    if sys.version_info[:2] != (3, 14) or sys.maxsize <= 2**32:
        raise AgentError("runtime_incompatible", "Use Plan's bundled Windows x64 Python 3.14 runtime for native reminders.")
    if not (root / "msal/__init__.py").is_file():
        raise AgentError("dependencies_missing", "Restore the complete Plan native authentication bundle.")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    import msal
    return msal
