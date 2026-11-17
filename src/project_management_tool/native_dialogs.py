"""Windows Common Item Dialog adapter.

The dialog is owned by a hidden window on a dedicated COM single-threaded
apartment.  Importing this module does not load Windows DLLs on other systems.
"""
import concurrent.futures
import logging
import os
import queue
import threading


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

        self._WM_CHOOSE, self._WM_STOP = 0x8001, 0x8002
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

        self._send_stop = send_stop
        self._fallback_stop = fallback_stop
        current_dialog = None
        stopping = False

        def choose(kind, suggested, folder):
            nonlocal current_dialog
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
        try:
            wc = WNDCLASS(0, window_proc, 0, 0, instance, None, None, None, None, name)
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
            ole.CoUninitialize()
