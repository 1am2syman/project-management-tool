"""Per-user/source identity, protected atomic storage and cross-process locks."""
import contextlib
import ctypes
import hashlib
import json
import ntpath
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from . import AgentError


def source_id(data_dir, windows=None):
    windows = sys.platform == "win32" if windows is None else windows
    normalized = ntpath.normcase(ntpath.abspath(str(data_dir))) if windows else str(Path(data_dir).resolve())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]


def current_sid():
    if sys.platform != "win32":
        raise AgentError("unsupported_platform", "Windows user identity is unavailable.")
    from ctypes import wintypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid_pointer = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        text = wintypes.LPWSTR()
        if not advapi.ConvertSidToStringSidW(sid_pointer, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return text.value
        finally:
            kernel.LocalFree(text)
    finally:
        kernel.CloseHandle(token)


def restrict_directory(path):
    """Replace the DACL, including explicit ACEs, with current-user-only inheritance."""
    if sys.platform != "win32":
        raise AgentError("unsupported_platform", "Credential protection requires Windows.")
    from ctypes import wintypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    advapi.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
    advapi.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    descriptor = ctypes.c_void_p()
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(f"D:P(A;OICI;FA;;;{current_sid()})", 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        present, defaulted, dacl = wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
        if not advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
            raise ctypes.WinError(ctypes.get_last_error())
        result = advapi.SetNamedSecurityInfoW(str(path), 1, 0x80000004, None, None, dacl, None)
        if result:
            raise ctypes.WinError(result)
    finally:
        kernel.LocalFree(descriptor)


def private_root(data_dir):
    if sys.platform != "win32" or not os.environ.get("LOCALAPPDATA"):
        raise AgentError("unsupported_platform", "Native reminder state requires Windows LocalAppData.")
    root = Path(os.environ["LOCALAPPDATA"]) / "Plan" / "Reminders" / source_id(Path(data_dir).resolve())
    root.mkdir(parents=True, exist_ok=True)
    restrict_directory(root)
    return root


class DPAPI:
    @staticmethod
    def _transform(raw, decrypt):
        if sys.platform != "win32":
            raise AgentError("unsupported_platform", "Native credentials require Windows DPAPI.")
        from ctypes import wintypes

        class Blob(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

        crypt = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        pointer = ctypes.POINTER(Blob)
        crypt.CryptProtectData.argtypes = [pointer, wintypes.LPCWSTR, pointer, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, pointer]
        crypt.CryptUnprotectData.argtypes = [pointer, ctypes.c_void_p, pointer, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, pointer]
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        source, target = Blob(len(raw), buffer), Blob()
        operation = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
        # UI_FORBIDDEN and current-user protection; never LOCAL_MACHINE.
        if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
            raise AgentError("cache_unavailable", "Windows could not unlock the native connection. Preserve private state for recovery.")
        try:
            return ctypes.string_at(target.data, target.size)
        finally:
            kernel.LocalFree(target.data)

    def encrypt(self, raw):
        return self._transform(raw, False)

    def decrypt(self, raw):
        return self._transform(raw, True)


@contextlib.contextmanager
def file_lock(path, timeout=15):
    """OS-released byte lock; processes must load cache only after acquiring it."""
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        raise AgentError("cache_unavailable", "Cannot lock the native connection state.") from None
    with os.fdopen(descriptor, "r+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + timeout
        while True:
            handle.seek(0)
            try:
                if sys.platform == "win32":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise AgentError("connection_busy", "The native connection is busy. Try again shortly.") from None
                time.sleep(0.05)
        try:
            yield
        finally:
            handle.seek(0)
            if sys.platform == "win32":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_UN)


def atomic_write(path, raw):
    descriptor, temporary = tempfile.mkstemp(prefix=".replace-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


class ProtectedState:
    def __init__(self, root, protector=None):
        self.root = Path(root)
        self.protector = protector or DPAPI()

    @contextlib.contextmanager
    def transaction(self):
        with file_lock(self.root / "connection.lock", timeout=5):
            path = self.root / "connection.dpapi"
            try:
                state: dict[str, Any] = json.loads(self.protector.decrypt(path.read_bytes()).decode("utf-8")) if path.exists() else {"version": 1}
                if not isinstance(state, dict) or state.get("version") != 1:
                    raise ValueError("Unsupported protected state")
            except (OSError, ValueError, UnicodeError):
                raise AgentError("cache_unavailable", "Native authorization is unreadable. Preserve private state and its account binding for recovery.") from None
            try:
                yield state
            finally:
                raw = json.dumps(state, ensure_ascii=False).encode("utf-8")
                atomic_write(path, self.protector.encrypt(raw))
