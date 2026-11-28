"""Windows desktop app launcher, taskbar identity, and Start Menu shortcuts.

Uses Python's standard library and lazy ctypes imports only. Importing this
module on macOS/Linux does not load Windows DLLs.
"""
from __future__ import annotations

import contextlib
import dataclasses
import functools
import json
import os
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from typing import Callable, Iterable

AUMID = "1am2syman.Plan"
DISPLAY_NAME = "Plan"
SHORTCUT_NAME = "Plan.lnk"
SHORTCUT_DESCRIPTION = "Plan — project sheet and Gantt"
MAX_LOG_BYTES = 256 * 1024

FOLDERID_PROGRAMS = "A77F5D77-2E2B-44C3-A6A2-ABA601054A51"
FOLDERID_DESKTOP = "B4BFCC3A-DB2C-424C-B029-7FE99A87C641"

PKEY_AUMID_FMTID = "9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"
PID_RELAUNCH_COMMAND = 2
PID_RELAUNCH_ICON = 3
PID_RELAUNCH_DISPLAY_NAME = 4
PID_APP_USER_MODEL_ID = 5

DEFAULT_PORT = 5173


@dataclasses.dataclass(frozen=True)
class ShortcutSpec:
    target: str
    arguments: str
    working_dir: str
    icon_path: str
    aumid: str = AUMID
    description: str = SHORTCUT_DESCRIPTION
    relaunch_command: str = ""
    relaunch_display_name: str = DISPLAY_NAME
    relaunch_icon_resource: str = ""


def repo_root_from_package() -> Path:
    """Resolve repository root from src/project_management_tool/desktop_win.py."""
    return Path(__file__).resolve().parents[2]


def icon_path_for_repo(repo_dir: Path | None = None) -> Path:
    base = Path(repo_dir).resolve() if repo_dir is not None else repo_root_from_package()
    candidate = base / "src" / "project_management_tool" / "web" / "plan.ico"
    if candidate.is_file():
        return candidate
    return Path(__file__).resolve().parent / "web" / "plan.ico"


def default_local_plan_dir(env: dict[str, str] | None = None) -> Path:
    mapping = os.environ if env is None else env
    local = mapping.get("LOCALAPPDATA")
    if local:
        return Path(local) / "Plan"
    return Path.home() / ".plan"


def default_shell_profile_dir(env: dict[str, str] | None = None) -> Path:
    return default_local_plan_dir(env) / "shell"


def default_launcher_log_path(env: dict[str, str] | None = None) -> Path:
    return default_local_plan_dir(env) / "launcher.log"


def resolve_pythonw_path(repo_dir: Path, *, fallback_executable: str | None = None) -> Path:
    repo = Path(repo_dir).resolve()
    bundled = repo / "runtime" / "windows-x64" / "pythonw.exe"
    if bundled.is_file():
        return bundled
    exe = Path(fallback_executable or sys.executable).resolve()
    if exe.name.lower() == "python.exe":
        sibling = exe.with_name("pythonw.exe")
        if sibling.is_file():
            return sibling
    return exe


def build_app_cli_args(
    script_arg: str,
    *,
    port: int = DEFAULT_PORT,
    data_dir: Path | None = None,
    profile_dir: Path | None = None,
    file_access: str = "native",
) -> list[str]:
    args = ["-B", script_arg, "--app"]
    if port != DEFAULT_PORT:
        args.extend(["--port", str(port)])
    if data_dir is not None:
        args.extend(["--data-dir", str(Path(data_dir).resolve())])
    if profile_dir is not None:
        args.extend(["--profile-dir", str(Path(profile_dir).resolve())])
    if file_access != "native":
        args.extend(["--file-access", file_access])
    return args


def build_shortcut_spec(
    repo_dir: Path,
    *,
    port: int = DEFAULT_PORT,
    data_dir: Path | None = None,
    profile_dir: Path | None = None,
    file_access: str = "native",
    pythonw_path: Path | None = None,
) -> ShortcutSpec:
    repo = Path(repo_dir).resolve()
    target = Path(pythonw_path).resolve() if pythonw_path is not None else resolve_pythonw_path(repo)
    start_py = repo / "start.py"
    icon = icon_path_for_repo(repo)
    shortcut_args = build_app_cli_args(
        "start.py",
        port=port,
        data_dir=data_dir,
        profile_dir=profile_dir,
        file_access=file_access,
    )
    relaunch_args = build_app_cli_args(
        str(start_py),
        port=port,
        data_dir=data_dir,
        profile_dir=profile_dir,
        file_access=file_access,
    )
    return ShortcutSpec(
        target=str(target),
        arguments=subprocess.list2cmdline(shortcut_args),
        working_dir=str(repo),
        icon_path=str(icon),
        aumid=AUMID,
        description=SHORTCUT_DESCRIPTION,
        relaunch_command=subprocess.list2cmdline([str(target), *relaunch_args]),
        relaunch_display_name=DISPLAY_NAME,
        relaunch_icon_resource=f"{icon},0",
    )


def build_browser_args(browser_path: Path | str, url: str, profile_dir: Path | str) -> list[str]:
    return [
        str(browser_path),
        f"--app={url}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--disable-sync",
    ]


def prepare_profile(profile_dir: Path) -> Path:
    """Create a dedicated browser profile with first-run/background-mode suppressed.

    Preserves existing user preferences such as saved window bounds.
    """
    profile = Path(profile_dir)
    default_dir = profile / "Default"
    default_dir.mkdir(parents=True, exist_ok=True)
    sentinel = profile / "First Run"
    if not sentinel.exists():
        sentinel.write_text("", encoding="utf-8")

    prefs_path = default_dir / "Preferences"
    prefs: dict = {}
    if prefs_path.is_file():
        try:
            loaded = json.loads(prefs_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                prefs = loaded
            else:
                return profile
        except (OSError, ValueError):
            # Never clobber an unreadable or externally locked Preferences file.
            return profile

    def merge_nested(target: dict, updates: dict) -> None:
        for key, value in updates.items():
            if isinstance(value, dict):
                child = target.get(key)
                if not isinstance(child, dict):
                    child = {}
                    target[key] = child
                merge_nested(child, value)
            else:
                target[key] = value

    merge_nested(
        prefs,
        {
            "background_mode": {"enabled": False},
            "browser": {"has_seen_welcome_page": True},
            "signin": {"allowed": False, "allowed_on_next_startup": False},
            "sync": {"requested": False},
            "edge": {"startup_boost_enabled": False},
            "distribution": {"suppress_first_run_default_browser_prompt": True},
        },
    )
    tmp_path = default_dir / f"Preferences.tmp.{os.getpid()}"
    try:
        tmp_path.write_text(json.dumps(prefs, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp_path, prefs_path)
    except OSError:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
    return profile


def ensure_stdio(log_path: Path | None = None, *, max_bytes: int = MAX_LOG_BYTES) -> Path | None:
    """Redirect None stdout/stderr (pythonw.exe) to a bounded launcher log."""
    if sys.stdout is not None and sys.stderr is not None:
        return None
    target = Path(log_path) if log_path is not None else default_launcher_log_path()
    stream = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size > max_bytes:
            # Keep the tail so recent diagnostics remain visible without unbounded growth.
            tail = target.read_bytes()[-(max_bytes // 2):]
            target.write_bytes(tail)
        stream = open(target, "a", encoding="utf-8", buffering=1)
    except OSError:
        target = None
        stream = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream
    return target


def log_launcher(message: str) -> None:
    with contextlib.suppress(Exception):
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        stream = sys.stderr or sys.stdout
        if stream is not None:
            stream.write(f"[{stamp}] {message}\n")
            stream.flush()


class AppSessionTracker:
    """Tracks live loopback SSE connections and active Plan desktop HWNDs."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: set[int] = set()
        self._next_id = 1
        self._hwnds: list[int] = []
        self.stop_event = threading.Event()
        self._focus_callback: Callable[[int], bool] | None = None

    def register_session(self) -> int:
        with self._lock:
            sid = self._next_id
            self._next_id += 1
            self._sessions.add(sid)
            return sid

    def unregister_session(self, sid: int) -> None:
        with self._lock:
            self._sessions.discard(sid)

    def active_session_count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def set_hwnds(self, hwnds: Iterable[int]) -> None:
        with self._lock:
            self._hwnds = [int(h) for h in hwnds if h]

    def add_hwnd(self, hwnd: int) -> None:
        if not hwnd:
            return
        with self._lock:
            value = int(hwnd)
            if value not in self._hwnds:
                self._hwnds.append(value)

    def set_focus_callback(self, callback: Callable[[int], bool] | None) -> None:
        with self._lock:
            self._focus_callback = callback

    def focus_active_window(self) -> tuple[bool, int | None]:
        with self._lock:
            hwnds = list(self._hwnds)
            callback = self._focus_callback
        for hwnd in hwnds:
            if callback is not None:
                with contextlib.suppress(Exception):
                    if callback(hwnd):
                        return True, hwnd
            else:
                return True, hwnd
        return False, None

    def close_all(self) -> None:
        self.stop_event.set()


class AppLifecycle:
    """Platform-independent shutdown state machine for --app mode."""

    def __init__(
        self,
        started_at: float,
        *,
        startup_timeout: float = 60.0,
        window_close_grace: float = 1.0,
        session_only_grace: float = 3.0,
    ) -> None:
        self.started_at = started_at
        self.startup_timeout = startup_timeout
        self.window_close_grace = window_close_grace
        self.session_only_grace = session_only_grace
        self.ever_had_window = False
        self.ever_had_session = False
        self.last_active_at = started_at

    def should_shutdown(self, now: float, *, live_window_count: int, active_session_count: int) -> bool:
        if live_window_count > 0:
            self.ever_had_window = True
            self.last_active_at = now
        if active_session_count > 0:
            self.ever_had_session = True
            self.last_active_at = now
        if live_window_count > 0 or active_session_count > 0:
            return False
        if not self.ever_had_window and not self.ever_had_session:
            return (now - self.started_at) >= self.startup_timeout
        if self.ever_had_window:
            # A tracked app HWND survives F5 reloads; once both HWND and SSE are gone,
            # the window was closed. Keep a brief settle window for final commits.
            return (now - self.last_active_at) >= self.window_close_grace
        # GPO/process-merge fallback where no HWND was tracked: keep a longer grace
        # window so F5 / Reload reconnects without terminating the server.
        return (now - self.last_active_at) >= self.session_only_grace


def find_browser(
    *,
    env: dict[str, str] | None = None,
    registry_lookup: Callable[[str], str | None] | None = None,
    exists: Callable[[Path], bool] | None = None,
) -> Path | None:
    """Locate Microsoft Edge first, then Google Chrome, else None."""
    mapping = os.environ if env is None else env
    check_exists = exists or (lambda p: p.is_file())
    reg_get = registry_lookup or _read_app_path_registry

    candidates: list[Path] = []
    for exe_name in ("msedge.exe", "chrome.exe"):
        reg_path = reg_get(exe_name)
        if reg_path:
            candidates.append(Path(reg_path))
        if exe_name == "msedge.exe":
            roots = [
                mapping.get("PROGRAMFILES(X86)"),
                mapping.get("PROGRAMFILES"),
                mapping.get("LOCALAPPDATA"),
            ]
            rel = Path("Microsoft") / "Edge" / "Application" / "msedge.exe"
        else:
            roots = [
                mapping.get("PROGRAMFILES"),
                mapping.get("PROGRAMFILES(X86)"),
                mapping.get("LOCALAPPDATA"),
            ]
            rel = Path("Google") / "Chrome" / "Application" / "chrome.exe"
        for root in roots:
            if root:
                candidates.append(Path(root) / rel)

    seen: set[str] = set()
    for path in candidates:
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        if check_exists(path):
            return path
    return None


def _read_app_path_registry(exe_name: str) -> str | None:
    if os.name != "nt":
        return None
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:
        return None
    subkey = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}"
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(hive, subkey) as key:
                value, _ = winreg.QueryValueEx(key, None)
                if isinstance(value, str) and value.strip():
                    return value.strip().strip('"')
        except OSError:
            continue
    return None


def show_error_dialog(title: str, message: str) -> None:
    log_launcher(f"{title}: {message}")
    if os.name != "nt":
        return
    try:
        import ctypes
        import ctypes.wintypes as wt

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.MessageBoxW.argtypes = [wt.HWND, wt.LPCWSTR, wt.LPCWSTR, wt.UINT]
        user32.MessageBoxW.restype = ctypes.c_int
        user32.MessageBoxW(None, str(message), str(title), 0x00000010)  # MB_ICONERROR | MB_OK
    except Exception:
        pass


def init_process_identity(aumid: str = AUMID) -> None:
    """Set process AUMID and Per-Monitor-V2 DPI awareness before any UI is created."""
    if os.name != "nt":
        return
    import ctypes
    import ctypes.wintypes as wt

    with contextlib.suppress(Exception):
        shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        shell32.SetCurrentProcessExplicitAppUserModelID.argtypes = [wt.LPCWSTR]
        shell32.SetCurrentProcessExplicitAppUserModelID.restype = ctypes.c_int32
        shell32.SetCurrentProcessExplicitAppUserModelID(aumid)

    with contextlib.suppress(Exception):
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.SetProcessDpiAwarenessContext.restype = wt.BOOL
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (HANDLE)-4
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))


@functools.cache
def _win32_com_helpers():
    import ctypes
    import ctypes.wintypes as wt
    from ctypes import WINFUNCTYPE, WinDLL  # type: ignore[attr-defined]

    HRESULT = ctypes.c_int32
    ULONG = ctypes.c_uint32

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_uint32),
            ("Data2", ctypes.c_uint16),
            ("Data3", ctypes.c_uint16),
            ("Data4", ctypes.c_ubyte * 8),
        ]

        @classmethod
        def parse(cls, value: str) -> "GUID":
            return cls.from_buffer_copy(uuid.UUID(value).bytes_le)

    class PROPERTYKEY(ctypes.Structure):
        _fields_ = [("fmtid", GUID), ("pid", ctypes.c_uint32)]

    class PROPVARIANT(ctypes.Structure):
        _fields_ = [
            ("vt", ctypes.c_uint16),
            ("wReserved1", ctypes.c_uint16),
            ("wReserved2", ctypes.c_uint16),
            ("wReserved3", ctypes.c_uint16),
            ("ptr", ctypes.c_void_p),
            ("pad", ctypes.c_void_p),
        ]

    ole32 = WinDLL("ole32", use_last_error=True)
    shell32 = WinDLL("shell32", use_last_error=True)
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    ole32.CoInitializeEx.restype = HRESULT
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None
    ole32.CoCreateInstance.argtypes = [
        ctypes.POINTER(GUID),
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    ole32.CoCreateInstance.restype = HRESULT
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole32.CoTaskMemFree.restype = None
    ole32.PropVariantClear.argtypes = [ctypes.POINTER(PROPVARIANT)]
    ole32.PropVariantClear.restype = HRESULT

    shell32.SHGetKnownFolderPath.argtypes = [
        ctypes.POINTER(GUID),
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_wchar_p),
    ]
    shell32.SHGetKnownFolderPath.restype = HRESULT
    shell32.SHGetPropertyStoreForWindow.argtypes = [
        wt.HWND,
        ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    shell32.SHGetPropertyStoreForWindow.restype = HRESULT
    shell32.SHChangeNotify.argtypes = [ctypes.c_long, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
    shell32.SHChangeNotify.restype = None

    def check(hr: int, context: str = "COM error") -> None:
        if hr < 0:
            raise OSError(f"{context}: 0x{hr & 0xFFFFFFFF:08X}")

    def com_call(obj, index: int, restype, argtypes, *values):
        vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        return WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtable[index])(obj, *values)

    def release(obj) -> None:
        if obj:
            com_call(obj, 2, ULONG, [])

    @contextlib.contextmanager
    def com_apartment():
        hr = ole32.CoInitializeEx(None, 2)  # COINIT_APARTMENTTHREADED
        # S_OK (0) and S_FALSE (1) require matching CoUninitialize; RPC_E_CHANGED_MODE does not.
        should_uninit = hr in (0, 1)
        if not should_uninit and (hr & 0xFFFFFFFF) != 0x80010106:
            check(hr, "CoInitializeEx")
        try:
            yield
        finally:
            if should_uninit:
                ole32.CoUninitialize()

    def set_prop_string(store, fmtid_str: str, pid: int, value: str) -> None:
        pkey = PROPERTYKEY(GUID.parse(fmtid_str), pid)
        buf = ctypes.create_unicode_buffer(value)
        pv = PROPVARIANT(31, 0, 0, 0, ctypes.cast(buf, ctypes.c_void_p).value, 0)  # VT_LPWSTR = 31
        check(
            com_call(
                store,
                6,  # IPropertyStore::SetValue
                HRESULT,
                [ctypes.POINTER(PROPERTYKEY), ctypes.POINTER(PROPVARIANT)],
                ctypes.byref(pkey),
                ctypes.byref(pv),
            ),
            f"IPropertyStore::SetValue(pid={pid})",
        )

    def get_prop_string(store, fmtid_str: str, pid: int) -> str | None:
        pkey = PROPERTYKEY(GUID.parse(fmtid_str), pid)
        pv = PROPVARIANT()
        hr = com_call(
            store,
            5,  # IPropertyStore::GetValue
            HRESULT,
            [ctypes.POINTER(PROPERTYKEY), ctypes.POINTER(PROPVARIANT)],
            ctypes.byref(pkey),
            ctypes.byref(pv),
        )
        if hr < 0:
            return None
        try:
            if pv.vt == 31 and pv.ptr:  # VT_LPWSTR
                return ctypes.wstring_at(pv.ptr)
            return None
        finally:
            ole32.PropVariantClear(ctypes.byref(pv))

    return {
        "ctypes": ctypes,
        "wt": wt,
        "HRESULT": HRESULT,
        "GUID": GUID,
        "PROPERTYKEY": PROPERTYKEY,
        "PROPVARIANT": PROPVARIANT,
        "ole32": ole32,
        "shell32": shell32,
        "check": check,
        "com_call": com_call,
        "release": release,
        "com_apartment": com_apartment,
        "set_prop_string": set_prop_string,
        "get_prop_string": get_prop_string,
    }


def resolve_known_folder(folder_id_guid: str) -> Path:
    if os.name != "nt":
        raise OSError("Windows known folders are only available on Windows")
    h = _win32_com_helpers()
    ctypes = h["ctypes"]
    guid = h["GUID"].parse(folder_id_guid)
    result = ctypes.c_wchar_p()
    try:
        hr = h["shell32"].SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(result))
        h["check"](hr, f"SHGetKnownFolderPath({folder_id_guid})")
        if not result.value:
            raise OSError(f"Windows returned an empty path for known folder {folder_id_guid}")
        return Path(result.value)
    finally:
        if result:
            h["ole32"].CoTaskMemFree(ctypes.cast(result, ctypes.c_void_p))


def write_shortcut(lnk_path: Path, spec: ShortcutSpec) -> Path:
    """Create or overwrite a Windows .lnk shortcut with explicit AUMID."""
    if os.name != "nt":
        raise OSError("Windows shortcuts can only be created on Windows")
    h = _win32_com_helpers()
    ctypes = h["ctypes"]
    wt = h["wt"]
    HRESULT = h["HRESULT"]
    GUID = h["GUID"]
    check = h["check"]
    com_call = h["com_call"]
    release = h["release"]

    lnk = Path(lnk_path)
    lnk.parent.mkdir(parents=True, exist_ok=True)

    clsid_shell_link = GUID.parse("00021401-0000-0000-C000-000000000046")
    iid_ishell_link_w = GUID.parse("000214F9-0000-0000-C000-000000000046")
    iid_ipersist_file = GUID.parse("0000010B-0000-0000-C000-000000000046")
    iid_iproperty_store = GUID.parse("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")

    with h["com_apartment"]():
        shell_link = ctypes.c_void_p()
        prop_store = ctypes.c_void_p()
        persist_file = ctypes.c_void_p()
        try:
            check(
                h["ole32"].CoCreateInstance(
                    ctypes.byref(clsid_shell_link),
                    None,
                    1,  # CLSCTX_INPROC_SERVER
                    ctypes.byref(iid_ishell_link_w),
                    ctypes.byref(shell_link),
                ),
                "CoCreateInstance(ShellLink)",
            )
            check(com_call(shell_link, 20, HRESULT, [wt.LPCWSTR], spec.target), "IShellLinkW::SetPath")
            check(com_call(shell_link, 11, HRESULT, [wt.LPCWSTR], spec.arguments), "IShellLinkW::SetArguments")
            check(com_call(shell_link, 9, HRESULT, [wt.LPCWSTR], spec.working_dir), "IShellLinkW::SetWorkingDirectory")
            check(com_call(shell_link, 7, HRESULT, [wt.LPCWSTR], spec.description), "IShellLinkW::SetDescription")
            if spec.icon_path:
                check(
                    com_call(shell_link, 17, HRESULT, [wt.LPCWSTR, ctypes.c_int], spec.icon_path, 0),
                    "IShellLinkW::SetIconLocation",
                )

            check(
                com_call(
                    shell_link,
                    0,  # QueryInterface
                    HRESULT,
                    [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)],
                    ctypes.byref(iid_iproperty_store),
                    ctypes.byref(prop_store),
                ),
                "QueryInterface(IPropertyStore)",
            )
            h["set_prop_string"](prop_store, PKEY_AUMID_FMTID, PID_APP_USER_MODEL_ID, spec.aumid)
            check(com_call(prop_store, 7, HRESULT, []), "IPropertyStore::Commit")

            check(
                com_call(
                    shell_link,
                    0,  # QueryInterface
                    HRESULT,
                    [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)],
                    ctypes.byref(iid_ipersist_file),
                    ctypes.byref(persist_file),
                ),
                "QueryInterface(IPersistFile)",
            )
            check(
                com_call(persist_file, 6, HRESULT, [wt.LPCWSTR, wt.BOOL], str(lnk), True),
                "IPersistFile::Save",
            )
            # Notify Explorer / Start Menu so the new/updated shortcut appears promptly.
            # SHCNE_UPDATEDIR (0x1000) | SHCNF_PATHW (0x0005)
            h["shell32"].SHChangeNotify(0x00001000, 0x0005, ctypes.c_wchar_p(str(lnk.parent)), None)
            # SHCNE_UPDATEITEM (0x2000) | SHCNF_PATHW (0x0005)
            h["shell32"].SHChangeNotify(0x00002000, 0x0005, ctypes.c_wchar_p(str(lnk)), None)
        finally:
            release(persist_file)
            release(prop_store)
            release(shell_link)
    return lnk


def install_shortcuts(
    repo_dir: Path,
    *,
    desktop: bool = False,
    port: int = DEFAULT_PORT,
    data_dir: Path | None = None,
    profile_dir: Path | None = None,
    file_access: str = "native",
) -> list[Path]:
    spec = build_shortcut_spec(
        repo_dir,
        port=port,
        data_dir=data_dir,
        profile_dir=profile_dir,
        file_access=file_access,
    )
    created = [write_shortcut(resolve_known_folder(FOLDERID_PROGRAMS) / SHORTCUT_NAME, spec)]
    if desktop:
        created.append(write_shortcut(resolve_known_folder(FOLDERID_DESKTOP) / SHORTCUT_NAME, spec))
    return created


def uninstall_shortcuts(*, desktop: bool = False) -> list[Path]:
    removed: list[Path] = []
    targets = [resolve_known_folder(FOLDERID_PROGRAMS) / SHORTCUT_NAME]
    if desktop:
        targets.append(resolve_known_folder(FOLDERID_DESKTOP) / SHORTCUT_NAME)
    for lnk in targets:
        if lnk.exists():
            lnk.unlink()
            removed.append(lnk)
            with contextlib.suppress(Exception):
                h = _win32_com_helpers()
                h["shell32"].SHChangeNotify(0x00001000, 0x0005, h["ctypes"].c_wchar_p(str(lnk.parent)), None)
    return removed


def stamp_window_identity(hwnd: int, spec: ShortcutSpec) -> bool:
    """Stamp Relaunch* properties followed by System.AppUserModel.ID onto a top-level HWND."""
    if os.name != "nt" or not hwnd:
        return False
    h = _win32_com_helpers()
    ctypes = h["ctypes"]
    iid_iproperty_store = h["GUID"].parse("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")
    store = ctypes.c_void_p()
    try:
        hr = h["shell32"].SHGetPropertyStoreForWindow(
            h["wt"].HWND(hwnd),
            ctypes.byref(iid_iproperty_store),
            ctypes.byref(store),
        )
        if hr < 0 or not store.value:
            return False
        # Relaunch properties MUST be set before System.AppUserModel.ID so Explorer
        # observes them atomically when the AUMID triggers taskbar re-evaluation.
        if spec.relaunch_command:
            h["set_prop_string"](store, PKEY_AUMID_FMTID, PID_RELAUNCH_COMMAND, spec.relaunch_command)
        if spec.relaunch_display_name:
            h["set_prop_string"](store, PKEY_AUMID_FMTID, PID_RELAUNCH_DISPLAY_NAME, spec.relaunch_display_name)
        if spec.relaunch_icon_resource:
            h["set_prop_string"](store, PKEY_AUMID_FMTID, PID_RELAUNCH_ICON, spec.relaunch_icon_resource)
        h["set_prop_string"](store, PKEY_AUMID_FMTID, PID_APP_USER_MODEL_ID, spec.aumid)
        return True
    except OSError:
        return False
    finally:
        h["release"](store)


def read_window_aumid(hwnd: int) -> str | None:
    if os.name != "nt" or not hwnd:
        return None
    h = _win32_com_helpers()
    ctypes = h["ctypes"]
    iid_iproperty_store = h["GUID"].parse("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")
    store = ctypes.c_void_p()
    try:
        hr = h["shell32"].SHGetPropertyStoreForWindow(
            h["wt"].HWND(hwnd),
            ctypes.byref(iid_iproperty_store),
            ctypes.byref(store),
        )
        if hr < 0 or not store.value:
            return None
        return h["get_prop_string"](store, PKEY_AUMID_FMTID, PID_APP_USER_MODEL_ID)
    except OSError:
        return None
    finally:
        h["release"](store)


@functools.cache
def _win32_user32():
    import ctypes
    import ctypes.wintypes as wt
    from ctypes import WINFUNCTYPE, WinDLL  # type: ignore[attr-defined]

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wt.DWORD),
            ("cntUsage", wt.DWORD),
            ("th32ProcessID", wt.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wt.DWORD),
            ("cntThreads", wt.DWORD),
            ("th32ParentProcessID", wt.DWORD),
            ("pcPriClassBase", wt.LONG),
            ("dwFlags", wt.DWORD),
            ("szExeFile", wt.WCHAR * 260),
        ]

    user32 = WinDLL("user32", use_last_error=True)
    kernel32 = WinDLL("kernel32", use_last_error=True)
    ENUMPROC = WINFUNCTYPE(wt.BOOL, wt.HWND, ctypes.c_ssize_t)

    user32.EnumWindows.argtypes = [ENUMPROC, ctypes.c_ssize_t]
    user32.EnumWindows.restype = wt.BOOL
    user32.IsWindow.argtypes = [wt.HWND]
    user32.IsWindow.restype = wt.BOOL
    user32.IsWindowVisible.argtypes = [wt.HWND]
    user32.IsWindowVisible.restype = wt.BOOL
    user32.IsIconic.argtypes = [wt.HWND]
    user32.IsIconic.restype = wt.BOOL
    user32.GetWindow.argtypes = [wt.HWND, wt.UINT]
    user32.GetWindow.restype = wt.HWND
    user32.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
    user32.GetWindowRect.restype = wt.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    user32.GetWindowThreadProcessId.restype = wt.DWORD
    user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wt.BOOL
    user32.AllowSetForegroundWindow.argtypes = [wt.DWORD]
    user32.AllowSetForegroundWindow.restype = wt.BOOL
    user32.SetForegroundWindow.argtypes = [wt.HWND]
    user32.SetForegroundWindow.restype = wt.BOOL
    user32.BringWindowToTop.argtypes = [wt.HWND]
    user32.BringWindowToTop.restype = wt.BOOL
    user32.GetForegroundWindow.argtypes = []
    user32.GetForegroundWindow.restype = wt.HWND
    user32.AttachThreadInput.argtypes = [wt.DWORD, wt.DWORD, wt.BOOL]
    user32.AttachThreadInput.restype = wt.BOOL
    kernel32.GetCurrentThreadId.argtypes = []
    kernel32.GetCurrentThreadId.restype = wt.DWORD
    kernel32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    kernel32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32FirstW.restype = wt.BOOL
    kernel32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.restype = wt.BOOL
    kernel32.CloseHandle.argtypes = [wt.HANDLE]
    kernel32.CloseHandle.restype = wt.BOOL

    return ctypes, wt, ENUMPROC, PROCESSENTRY32W, user32, kernel32


def process_tree_pids(root_pid: int) -> set[int]:
    """Return root_pid plus any live descendant PIDs on Windows."""
    pids = {int(root_pid)}
    if os.name != "nt" or not root_pid:
        return pids
    ctypes, wt, _, PROCESSENTRY32W, _, kernel32 = _win32_user32()
    snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    invalid = wt.HANDLE(-1).value
    if not snap or snap == invalid:
        return pids
    children: dict[int, list[int]] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if kernel32.Process32FirstW(snap, ctypes.byref(entry)):
            while True:
                children.setdefault(int(entry.th32ParentProcessID), []).append(int(entry.th32ProcessID))
                if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                    break
    finally:
        kernel32.CloseHandle(snap)
    stack = [int(root_pid)]
    while stack:
        parent = stack.pop()
        for child in children.get(parent, ()):
            if child not in pids:
                pids.add(child)
                stack.append(child)
    return pids


def enumerate_chromium_windows() -> list[dict]:
    """Return visible top-level Chromium/Edge app windows."""
    if os.name != "nt":
        return []
    ctypes, wt, ENUMPROC, _, user32, _ = _win32_user32()
    results: list[dict] = []
    class_buf = ctypes.create_unicode_buffer(128)
    title_buf = ctypes.create_unicode_buffer(512)

    @ENUMPROC
    def visit(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        if user32.GetWindow(hwnd, 4):  # GW_OWNER != 0
            return True
        ex_style = user32.GetWindowLongW(hwnd, -20)  # GWL_EXSTYLE
        if ex_style & 0x00000080:  # WS_EX_TOOLWINDOW
            return True
        if user32.GetClassNameW(hwnd, class_buf, 128) == 0:
            return True
        if class_buf.value != "Chrome_WidgetWin_1":
            return True
        rect = wt.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        if (rect.right - rect.left) < 160 or (rect.bottom - rect.top) < 100:
            return True
        pid = wt.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        user32.GetWindowTextW(hwnd, title_buf, 512)
        results.append({"hwnd": int(hwnd), "pid": int(pid.value), "title": title_buf.value})
        return True

    user32.EnumWindows(visit, 0)
    return results


def is_window_alive(hwnd: int) -> bool:
    if os.name != "nt" or not hwnd:
        return False
    _, wt, _, _, user32, _ = _win32_user32()
    return bool(user32.IsWindow(wt.HWND(hwnd)))


def focus_window(hwnd: int) -> bool:
    """Restore (if minimized) and bring an existing Plan window to the foreground."""
    if os.name != "nt" or not hwnd:
        return False
    ctypes, wt, _, _, user32, kernel32 = _win32_user32()
    handle = wt.HWND(hwnd)
    if not user32.IsWindow(handle):
        return False
    if user32.IsIconic(handle):
        user32.ShowWindow(handle, 9)  # SW_RESTORE
    else:
        user32.ShowWindow(handle, 5)  # SW_SHOW
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
    if pid.value:
        user32.AllowSetForegroundWindow(pid.value)
    user32.BringWindowToTop(handle)
    if user32.SetForegroundWindow(handle):
        return True
    fg = user32.GetForegroundWindow()
    if fg and fg != handle:
        current_tid = kernel32.GetCurrentThreadId()
        fg_tid = user32.GetWindowThreadProcessId(fg, None)
        attached = bool(fg_tid and fg_tid != current_tid and user32.AttachThreadInput(current_tid, fg_tid, True))
        try:
            user32.BringWindowToTop(handle)
            user32.SetForegroundWindow(handle)
        finally:
            if attached:
                user32.AttachThreadInput(current_tid, fg_tid, False)
    return bool(user32.IsWindow(handle))


def is_plan_window_title(title: str, port: int = DEFAULT_PORT) -> bool:
    """Return True only when a window title explicitly identifies Plan."""
    text = (title or "").strip()
    if not text:
        return False
    if text.endswith(" — Plan") or text == "Plan — project sheet & gantt":
        return True
    return f"127.0.0.1:{port}" in text


def pick_new_app_window(
    before_hwnds: set[int],
    current_windows: list[dict],
    *,
    spawned_pid: int | None,
    port: int = DEFAULT_PORT,
    spawned_tree_pids: set[int] | None = None,
) -> int | None:
    """Select the newly created Plan app HWND from before/after top-level window snapshots.

    A new window is accepted only if it belongs to the spawned browser PID tree
    OR its title explicitly identifies Plan (GPO/delegated Edge process merge).
    """
    allowed_pids = set(spawned_tree_pids or ())
    if spawned_pid is not None:
        allowed_pids.add(int(spawned_pid))

    candidates = []
    for item in current_windows:
        if item["hwnd"] in before_hwnds:
            continue
        pid_match = 1 if item.get("pid") in allowed_pids else 0
        title_match = 1 if is_plan_window_title(item.get("title", ""), port) else 0
        if pid_match or title_match:
            candidates.append((pid_match, title_match, int(item["hwnd"])))

    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][2]


def launch_and_track(
    url: str,
    repo_dir: Path,
    server,
    session_tracker: AppSessionTracker,
    *,
    port: int = DEFAULT_PORT,
    data_dir: Path | None = None,
    profile_dir: Path | None = None,
    file_access: str = "native",
    startup_timeout: float = 60.0,
    late_discovery_window: float = 30.0,
) -> None:
    """Launch Edge/Chrome in --app mode, stamp taskbar identity, and shut down on close."""
    spec = build_shortcut_spec(
        repo_dir,
        port=port,
        data_dir=data_dir,
        profile_dir=profile_dir,
        file_access=file_access,
    )
    session_tracker.set_focus_callback(focus_window)

    browser = find_browser()
    if browser is None:
        log_launcher("Neither Edge nor Chrome was found; falling back to default browser.")
        webbrowser.open(url)
        # In browser-fallback mode, stay alive based on SSE sessions (with generous startup wait).
        lifecycle = AppLifecycle(time.monotonic(), startup_timeout=startup_timeout, session_only_grace=3.5)
        while not session_tracker.stop_event.is_set():
            time.sleep(0.5)
            if lifecycle.should_shutdown(
                time.monotonic(),
                live_window_count=0,
                active_session_count=session_tracker.active_session_count(),
            ):
                break
        session_tracker.close_all()
        server.shutdown()
        return

    resolved_profile = Path(profile_dir) if profile_dir is not None else default_shell_profile_dir()
    prepare_profile(resolved_profile)
    before_hwnds = {w["hwnd"] for w in enumerate_chromium_windows()}
    cmd = build_browser_args(browser, url, resolved_profile)
    log_launcher(f"Launching app shell: {browser.name} -> {url}")
    try:
        proc = subprocess.Popen(cmd)
    except OSError as exc:
        show_error_dialog("Plan could not open browser", f"Failed to launch {browser}:\n{exc}")
        session_tracker.close_all()
        server.shutdown()
        return

    spawned_pid = proc.pid
    tracked_hwnds: list[int] = []
    started = time.monotonic()

    # Tight startup poll (20 ms) so Relaunch* + AUMID are stamped before Explorer settles the taskbar.
    discover_deadline = started + min(15.0, late_discovery_window)
    late_discover_deadline = started + late_discovery_window
    while time.monotonic() < discover_deadline and not session_tracker.stop_event.is_set():
        found = pick_new_app_window(
            before_hwnds,
            enumerate_chromium_windows(),
            spawned_pid=spawned_pid,
            port=port,
            spawned_tree_pids=process_tree_pids(spawned_pid),
        )
        if found is not None:
            tracked_hwnds.append(found)
            session_tracker.add_hwnd(found)
            stamped = stamp_window_identity(found, spec)
            log_launcher(f"Tracked app HWND={found} (stamped={stamped})")
            break
        # If the browser exited quickly (e.g. GPO merged into existing Edge), keep scanning
        # briefly for the newly created window, or fall back to SSE once connected.
        if proc.poll() is not None and session_tracker.active_session_count() > 0 and (time.monotonic() - started) > 2.0:
            log_launcher("Browser process delegated to existing instance; continuing with SSE tracking.")
            break
        time.sleep(0.02)

    lifecycle = AppLifecycle(
        started,
        startup_timeout=startup_timeout,
        window_close_grace=1.0,
        session_only_grace=3.0,
    )
    last_verify = time.monotonic()
    while not session_tracker.stop_event.is_set():
        time.sleep(0.25)
        now = time.monotonic()

        # Re-check within a bounded discovery window only if no Plan window was ever tracked;
        # after late_discover_deadline rely solely on SSE so unrelated browser windows are never adopted.
        if not tracked_hwnds and not lifecycle.ever_had_window and now < late_discover_deadline:
            found = pick_new_app_window(
                before_hwnds,
                enumerate_chromium_windows(),
                spawned_pid=spawned_pid,
                port=port,
                spawned_tree_pids=process_tree_pids(spawned_pid),
            )
            if found is not None:
                tracked_hwnds.append(found)
                session_tracker.add_hwnd(found)
                stamp_window_identity(found, spec)
                log_launcher(f"Late-tracked app HWND={found}")

        alive = [hwnd for hwnd in tracked_hwnds if is_window_alive(hwnd)]
        if len(alive) != len(tracked_hwnds):
            tracked_hwnds = alive
            session_tracker.set_hwnds(alive)

        # Periodically verify Chromium did not overwrite our AUMID on navigation/title/DPI change.
        if alive and (now - last_verify) >= 1.0:
            last_verify = now
            for hwnd in alive:
                current_aumid = read_window_aumid(hwnd)
                if current_aumid != spec.aumid:
                    stamp_window_identity(hwnd, spec)

        if lifecycle.should_shutdown(
            now,
            live_window_count=len(alive),
            active_session_count=session_tracker.active_session_count(),
        ):
            log_launcher("App window and session closed; shutting down server.")
            break

    session_tracker.close_all()
    server.shutdown()
