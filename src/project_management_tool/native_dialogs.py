"""Windows Common Item Dialog adapter.

The dialog is owned by a hidden window on a dedicated COM single-threaded
apartment.  Importing this module does not load Windows DLLs on other systems.
"""
import collections
import concurrent.futures
import contextlib
import logging
import os
import queue
import threading
import time
from pathlib import Path


def _windows_available():
    return os.name == "nt"


class DialogBusy(Exception):
    """Only one chooser may be active in this process."""


class WindowsDialogs:
    def __init__(self):
        if not _windows_available():
            raise OSError("Windows file dialogs are unavailable on this system")
        self._queue = queue.Queue()
        self._lock = threading.Lock()
        self._busy = False
        self._closed = False
        self._events = collections.deque(maxlen=50)
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, name="plan-file-dialog", daemon=True)
        self._thread.start()
        self._ready.wait()
        if getattr(self, "_startup_error", None):
            raise RuntimeError("Could not initialize the Windows file chooser") from self._startup_error

    def choose(self, kind, suggested_name="", initial_folder=""):
        if kind not in ("open", "save"):
            raise ValueError("Unknown dialog kind")
        with self._lock:
            if self._closed:
                raise RuntimeError("File chooser is closed")
            if self._busy:
                raise DialogBusy("A file chooser is already open")
            self._busy = True
            future = concurrent.futures.Future()
            self._queue.put((future, kind, suggested_name, initial_folder))
            if not self._post(self._hwnd, self._WM_CHOOSE, 0, 0):
                self._queue.get_nowait()
                self._busy = False
                raise OSError("Could not start the Windows file chooser")
            return future

    def _active(self):
        return not self._closed and self._busy

    def cancel(self):
        """Cancel the open chooser. Returns whether a cancel request was delivered."""
        with self._lock:
            if not self._active():
                return False
        return self._cancel()

    def raise_dialog(self):
        """Bring the open chooser above other windows; Windows may still refuse keyboard focus."""
        with self._lock:
            if not self._active():
                return {'shown': False, 'foreground': False}
        state = self._raise()
        self._record('chooser.raise', state)
        return state

    def state(self):
        with self._lock:
            if not self._active():
                return None
        return self._state()

    def diagnostics(self):
        return list(self._events)

    def _record(self, event, detail):
        self._events.append({'event': event, **detail})

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
        # The shell's modal loop can defer posted messages to its disabled owner.
        # Send outside the lock: same-thread delivery immediately reenters window_proc.
        if not self._send_stop(self._hwnd, self._WM_STOP, 0, 0):
            self._fallback_stop()
        if threading.current_thread() is self._thread:
            return
        self._thread.join(timeout=3)
        if self._thread.is_alive():
            self._fallback_stop()
            self._thread.join(timeout=2)
        if self._thread.is_alive():
            with self._lock:
                self._busy = False
            logging.getLogger(__name__).warning('Windows file chooser did not stop within the shutdown deadline')

    def _run(self):
        failure = None
        try:
            self._run_windows()
        except BaseException as exc:
            failure = exc
            self._startup_error = exc
        finally:
            self._ready.set()
            with self._lock:
                self._closed = True
                self._busy = False
                abandoned = []
                while True:
                    try:
                        future, *_ = self._queue.get_nowait()
                        abandoned.append(future)
                    except queue.Empty:
                        break
            for future in abandoned:
                if not future.done():
                    future.set_exception(failure or RuntimeError('File chooser stopped'))

    def _complete(self, future, result=None, error=None):
        # Future callbacks run synchronously; allow them to begin another selection.
        with self._lock:
            self._busy = False
        if error is None:
            future.set_result(result)
        else:
            future.set_exception(error)

    def _run_windows(self):
        import ctypes
        import ctypes.wintypes as wt
        import uuid

        HRESULT = ctypes.c_int32
        ULONG = ctypes.c_uint32
        WPARAM = ctypes.c_size_t
        LPARAM = ctypes.c_ssize_t
        LRESULT = ctypes.c_ssize_t
        from ctypes import WINFUNCTYPE, WinDLL, WinError, get_last_error  # type: ignore[attr-defined]
        WNDPROC = WINFUNCTYPE(LRESULT, wt.HWND, wt.UINT, WPARAM, LPARAM)

        class GUID(ctypes.Structure):
            _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                        ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]
            @classmethod
            def parse(cls, value):
                return cls.from_buffer_copy(uuid.UUID(value).bytes_le)

        class FILTER(ctypes.Structure):
            _fields_ = [("name", wt.LPCWSTR), ("spec", wt.LPCWSTR)]

        class WNDCLASS(ctypes.Structure):
            _fields_ = [("style", wt.UINT), ("lpfnWndProc", WNDPROC),
                        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                        ("hInstance", wt.HINSTANCE), ("hIcon", wt.HICON),
                        ("hCursor", wt.HANDLE), ("hbrBackground", wt.HBRUSH),
                        ("lpszMenuName", wt.LPCWSTR), ("lpszClassName", wt.LPCWSTR)]

        ole = WinDLL("ole32", use_last_error=True)
        shell = WinDLL("shell32", use_last_error=True)
        user = WinDLL("user32", use_last_error=True)
        kernel = WinDLL("kernel32", use_last_error=True)
        ole.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        ole.CoInitializeEx.restype = HRESULT
        ole.CoUninitialize.argtypes = []
        ole.CoUninitialize.restype = None
        ole.CoCreateInstance.argtypes = [ctypes.POINTER(GUID), ctypes.c_void_p, ctypes.c_uint32,
                                         ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
        ole.CoCreateInstance.restype = HRESULT
        ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole.CoTaskMemFree.restype = None
        shell.SHCreateItemFromParsingName.argtypes = [wt.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
        shell.SHCreateItemFromParsingName.restype = HRESULT
        kernel.GetModuleHandleW.argtypes = [wt.LPCWSTR]
        kernel.GetModuleHandleW.restype = wt.HMODULE
        user.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASS)]
        user.RegisterClassW.restype = wt.ATOM
        user.UnregisterClassW.argtypes = [wt.LPCWSTR, wt.HINSTANCE]
        user.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int,
                                          ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.HWND, wt.HMENU,
                                          wt.HINSTANCE, ctypes.c_void_p]
        user.CreateWindowExW.restype = wt.HWND
        user.DefWindowProcW.argtypes = [wt.HWND, wt.UINT, WPARAM, LPARAM]
        user.DefWindowProcW.restype = LRESULT
        user.PostMessageW.argtypes = [wt.HWND, wt.UINT, WPARAM, LPARAM]
        user.PostMessageW.restype = wt.BOOL
        user.SendMessageTimeoutW.argtypes = [wt.HWND, wt.UINT, WPARAM, LPARAM, wt.UINT, wt.UINT, ctypes.POINTER(ctypes.c_size_t)]
        user.SendMessageTimeoutW.restype = LRESULT
        ENUMPROC = WINFUNCTYPE(wt.BOOL, wt.HWND, LPARAM)
        user.EnumThreadWindows.argtypes = [wt.DWORD, ENUMPROC, LPARAM]
        user.EnumThreadWindows.restype = wt.BOOL
        user.GetWindow.argtypes = [wt.HWND, wt.UINT]
        user.GetWindow.restype = wt.HWND
        kernel.GetCurrentThreadId.restype = wt.DWORD

        class FLASHWINFO(ctypes.Structure):
            _fields_ = [("cbSize", wt.UINT), ("hwnd", wt.HWND), ("dwFlags", wt.DWORD),
                        ("uCount", wt.UINT), ("dwTimeout", wt.DWORD)]

        user.GetForegroundWindow.argtypes = []
        user.GetForegroundWindow.restype = wt.HWND
        user.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
        user.GetWindowRect.restype = wt.BOOL
        user.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.UINT]
        user.SetWindowPos.restype = wt.BOOL
        user.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
        user.GetWindowThreadProcessId.restype = wt.DWORD
        user.AttachThreadInput.argtypes = [wt.DWORD, wt.DWORD, wt.BOOL]
        user.AttachThreadInput.restype = wt.BOOL
        user.SetForegroundWindow.argtypes = [wt.HWND]
        user.SetForegroundWindow.restype = wt.BOOL
        user.IsWindowVisible.argtypes = [wt.HWND]
        user.IsWindowVisible.restype = wt.BOOL
        user.FlashWindowEx.argtypes = [ctypes.POINTER(FLASHWINFO)]
        user.FlashWindowEx.restype = wt.BOOL
        user.LoadImageW.argtypes = [wt.HINSTANCE, wt.LPCWSTR, wt.UINT, ctypes.c_int, ctypes.c_int, wt.UINT]
        user.LoadImageW.restype = wt.HANDLE
        user.DestroyIcon.argtypes = [wt.HICON]
        user.DestroyIcon.restype = wt.BOOL
        user.DestroyWindow.argtypes = [wt.HWND]
        user.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT]
        user.GetMessageW.restype = ctypes.c_int
        user.TranslateMessage.argtypes = [ctypes.POINTER(wt.MSG)]
        user.DispatchMessageW.argtypes = [ctypes.POINTER(wt.MSG)]
        user.DispatchMessageW.restype = LRESULT
        user.PostQuitMessage.argtypes = [ctypes.c_int]
        user.PostQuitMessage.restype = None

        def check(hr):
            if hr < 0:
                raise OSError(f"Windows dialog error 0x{hr & 0xffffffff:08X}")

        def call(obj, index, result, args, *values):
            vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            return WINFUNCTYPE(result, ctypes.c_void_p, *args)(vtable[index])(obj, *values)

        def release(obj):
            if obj:
                call(obj, 2, ULONG, [])

        self._WM_CHOOSE, self._WM_STOP, self._WM_CANCEL = 0x8001, 0x8002, 0x8003
        self._post = user.PostMessageW
        thread_id = kernel.GetCurrentThreadId()

        def send_stop(hwnd, message, wparam, lparam):
            result = ctypes.c_size_t()
            # SMTO_ABORTIFHUNG | SMTO_NORMAL; allow sent-message dispatch while waiting.
            return bool(user.SendMessageTimeoutW(hwnd, message, wparam, lparam, 0x2, 2000, ctypes.byref(result)))

        def fallback_stop():
            @ENUMPROC
            def close_owned(hwnd, _parameter):
                owner = user.GetWindow(hwnd, 4)  # GW_OWNER
                while owner:
                    if owner == self._hwnd:
                        user.PostMessageW(hwnd, 0x10, 0, 0)  # WM_CLOSE, only our owned windows
                        break
                    owner = user.GetWindow(owner, 4)
                return True
            user.EnumThreadWindows(thread_id, close_owned, 0)
            user.PostMessageW(self._hwnd, self._WM_STOP, 0, 0)

        def owned(hwnd):
            # The chooser itself, not its overwrite prompt: closing or raising it carries the prompt along.
            return user.GetWindow(hwnd, 4) == self._hwnd  # GW_OWNER

        def find_dialog():
            found = []

            @ENUMPROC
            def visit(hwnd, _parameter):
                if user.IsWindowVisible(hwnd) and owned(hwnd):
                    found.append(hwnd)
                    return False
                return True
            user.EnumThreadWindows(thread_id, visit, 0)
            return found[0] if found else None

        def dialog_state():
            dialog = find_dialog()
            return {'shown': bool(dialog), 'foreground': bool(dialog) and user.GetForegroundWindow() == dialog}

        def raise_dialog():
            # The chooser belongs to a background process. Windows' foreground lock lets the
            # browser keep focus after the user's click, which would leave the chooser hidden
            # behind it. Moving it through the topmost band places it above the browser without
            # keeping it there; attaching to the foreground input queue requests keyboard focus.
            dialog = find_dialog()
            if not dialog:
                return {'shown': False, 'foreground': False}
            foreground = user.GetForegroundWindow()
            if foreground != dialog:
                flags = 0x0001 | 0x0002 | 0x0010 | 0x0040 | 0x4000  # NOSIZE|NOMOVE|NOACTIVATE|SHOWWINDOW|ASYNC
                user.SetWindowPos(dialog, wt.HWND(-1), 0, 0, 0, 0, flags)
                user.SetWindowPos(dialog, wt.HWND(-2), 0, 0, 0, 0, flags)
                current = kernel.GetCurrentThreadId()
                target = user.GetWindowThreadProcessId(foreground, None) if foreground else 0
                attached = bool(target and target != current and user.AttachThreadInput(current, target, True))
                try:
                    user.SetForegroundWindow(dialog)
                finally:
                    if attached:
                        user.AttachThreadInput(current, target, False)
                if user.GetForegroundWindow() != dialog:
                    flash = FLASHWINFO(ctypes.sizeof(FLASHWINFO), dialog, 0x3 | 0xC, 0, 0)  # ALL|TIMERNOFG
                    user.FlashWindowEx(ctypes.byref(flash))
            return {'shown': True, 'foreground': user.GetForegroundWindow() == dialog}

        def place_owner():
            # Centre the hidden owner on the window the user clicked so the chooser opens there.
            foreground = user.GetForegroundWindow()
            if not foreground or foreground == self._hwnd:
                return
            rect = wt.RECT()
            if user.GetWindowRect(foreground, ctypes.byref(rect)):
                user.SetWindowPos(self._hwnd, None, (rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2,
                                  0, 0, 0x0001 | 0x0004 | 0x0010)  # NOSIZE|NOZORDER|NOACTIVATE

        def watch(generation, started):
            # Show() blocks this STA thread, so a helper raises the chooser once it appears.
            while generation == shown_generation and not stopping and time.monotonic() - started < 10:
                if find_dialog():
                    state = raise_dialog()
                    self._record('chooser.shown', {**state, 'durationMs': round((time.monotonic() - started) * 1000)})
                    return
                time.sleep(0.05)
            if generation == shown_generation and not stopping:
                self._record('chooser.notShown', {'durationMs': round((time.monotonic() - started) * 1000)})

        self._send_stop = send_stop
        self._fallback_stop = fallback_stop
        def cancel_dialog():
            # WM_CLOSE is the dialog's own Cancel path, so Show() returns ERROR_CANCELLED. In a Windows 10 check
            # IFileDialog::Close left an unfocused chooser open, so it is only used before one appears.
            dialog = find_dialog()
            if dialog:
                return bool(user.PostMessageW(dialog, 0x10, 0, 0))
            # Not shown yet: IFileDialog::Close on the STA thread. A sent message reaches the
            # disabled owner from inside the shell's modal loop.
            return send_stop(self._hwnd, self._WM_CANCEL, 0, 0)

        self._raise = raise_dialog
        self._cancel = cancel_dialog
        self._state = dialog_state
        current_dialog = None
        stopping = False
        shown_generation = 0

        def choose(kind, suggested, folder):
            nonlocal current_dialog, shown_generation
            clsid = GUID.parse("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7" if kind == "open" else "C0B4E2F3-BA21-4773-8DBA-335EC946EB8B")
            iid = GUID.parse("D57C7288-D4AD-4768-BE02-9D969532D960" if kind == "open" else "84BCCD23-5FDE-4CDB-AEA4-AF64B83D78AB")
            item_iid = GUID.parse("43826D1E-E718-42EE-BC55-A1E261C37BFE")
            dialog = ctypes.c_void_p()
            check(ole.CoCreateInstance(ctypes.byref(clsid), None, 1, ctypes.byref(iid), ctypes.byref(dialog)))
            current_dialog = dialog
            try:
                options = ctypes.c_uint32()
                check(call(dialog, 10, HRESULT, [ctypes.POINTER(ctypes.c_uint32)], ctypes.byref(options)))
                # Filesystem paths only, existing folder, and the standard overwrite prompt.
                flags = options.value | 0x40 | 0x800 | (0x1000 if kind == "open" else 0x2)
                check(call(dialog, 9, HRESULT, [ctypes.c_uint32], flags))
                filters = (FILTER * 1)(FILTER("Plan project files (*.plan)", "*.plan"))
                check(call(dialog, 4, HRESULT, [ctypes.c_uint32, ctypes.POINTER(FILTER)], 1, filters))
                if kind == "save":
                    check(call(dialog, 22, HRESULT, [wt.LPCWSTR], "plan"))
                    if suggested:
                        check(call(dialog, 15, HRESULT, [wt.LPCWSTR], suggested))
                if folder:
                    item = ctypes.c_void_p()
                    if shell.SHCreateItemFromParsingName(folder, None, ctypes.byref(item_iid), ctypes.byref(item)) >= 0:
                        try:
                            check(call(dialog, 11, HRESULT, [ctypes.c_void_p], item))
                        finally:
                            release(item)
                with contextlib.suppress(Exception):
                    place_owner()
                shown_generation += 1
                threading.Thread(target=watch, args=(shown_generation, time.monotonic()),
                                 name="plan-file-dialog-raise", daemon=True).start()
                result = call(dialog, 3, HRESULT, [wt.HWND], self._hwnd)
                if (result & 0xffffffff) == 0x800704C7:
                    return None
                check(result)
                item = ctypes.c_void_p()
                check(call(dialog, 20, HRESULT, [ctypes.POINTER(ctypes.c_void_p)], ctypes.byref(item)))
                try:
                    name = ctypes.c_void_p()
                    check(call(item, 5, HRESULT, [ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)], 0x80058000, ctypes.byref(name)))
                    try:
                        return ctypes.wstring_at(name)
                    finally:
                        ole.CoTaskMemFree(name)
                finally:
                    release(item)
            finally:
                shown_generation += 1
                current_dialog = None
                release(dialog)

        @WNDPROC
        def window_proc(hwnd, msg, wparam, lparam):
            nonlocal stopping
            if msg == self._WM_STOP:
                stopping = True
                if current_dialog:
                    call(current_dialog, 23, HRESULT, [HRESULT], ctypes.c_int32(0x800704C7).value)
                else:
                    user.PostQuitMessage(0)
                return 0
            if msg == self._WM_CANCEL:
                if current_dialog:
                    call(current_dialog, 23, HRESULT, [HRESULT], ctypes.c_int32(0x800704C7).value)
                return 0
            if msg == self._WM_CHOOSE:
                try:
                    future, kind, name, folder = self._queue.get_nowait()
                except queue.Empty:
                    return 0
                try:
                    result = None if stopping else choose(kind, name, folder)
                    error = None
                except BaseException as exc:
                    result, error = None, exc
                self._complete(future, result, error)
                if stopping:
                    user.PostQuitMessage(0)
                return 0
            return user.DefWindowProcW(hwnd, msg, wparam, lparam)

        check(ole.CoInitializeEx(None, 2))
        instance = kernel.GetModuleHandleW(None)
        name = "PlanFileDialog-" + uuid.uuid4().hex
        registered = False
        icon_path = Path(__file__).resolve().parent / "web" / "plan.ico"
        hicon = None
        if icon_path.is_file():
            # IMAGE_ICON (1), LR_LOADFROMFILE (0x10) | LR_DEFAULTSIZE (0x40)
            hicon = user.LoadImageW(None, str(icon_path), 1, 0, 0, 0x0010 | 0x0040) or None
        try:
            wc = WNDCLASS(0, window_proc, 0, 0, instance, hicon, None, None, None, name)
            if not user.RegisterClassW(ctypes.byref(wc)):
                raise WinError(get_last_error())
            registered = True
            self._hwnd = user.CreateWindowExW(0, name, "Plan", 0, 0, 0, 0, 0, None, None, instance, None)
            if not self._hwnd:
                raise WinError(get_last_error())
            self._ready.set()
            message = wt.MSG()
            while True:
                result = user.GetMessageW(ctypes.byref(message), None, 0, 0)
                if result == 0:
                    break
                if result < 0:
                    raise WinError(get_last_error())
                user.TranslateMessage(ctypes.byref(message))
                user.DispatchMessageW(ctypes.byref(message))
        finally:
            if getattr(self, "_hwnd", None):
                user.DestroyWindow(self._hwnd)
            if registered:
                user.UnregisterClassW(name, instance)
            if hicon:
                user.DestroyIcon(hicon)
            ole.CoUninitialize()
