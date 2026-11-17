import threading
import unittest
from unittest import mock

from src.project_management_tool import native_dialogs


class NativeDialogAvailabilityTests(unittest.TestCase):
    def test_non_windows_fails_without_starting_a_worker(self):
        with mock.patch.object(native_dialogs, '_windows_available', return_value=False), \
             mock.patch.object(native_dialogs.threading, 'Thread') as thread:
            with self.assertRaisesRegex(OSError, 'unavailable'):
                native_dialogs.WindowsDialogs()
            thread.assert_not_called()
    def test_callback_can_start_followup_selection(self):
        ready_to_finish = threading.Event()
        def worker(dialog):
            dialog._post = lambda *_args: True
            dialog._hwnd = 1
            dialog._WM_CHOOSE, dialog._WM_STOP = 1, 2
            dialog._ready.set()
            first, *_ = dialog._queue.get(timeout=5)
            self.assertTrue(ready_to_finish.wait(5))
            dialog._complete(first, 'first')
            second, *_ = dialog._queue.get(timeout=5)
            dialog._complete(second, 'second')
        with mock.patch.object(native_dialogs, '_windows_available', return_value=True), \
             mock.patch.object(native_dialogs.WindowsDialogs, '_run_windows', worker):
            dialog = native_dialogs.WindowsDialogs()
            first = dialog.choose('open')
            followup = []
            first.add_done_callback(lambda _: followup.append(dialog.choose('save')))
            ready_to_finish.set()
            self.assertEqual(first.result(timeout=5), 'first')
            dialog._thread.join(5)
            self.assertFalse(dialog._thread.is_alive())
            self.assertEqual(followup[0].result(timeout=5), 'second')

    def test_close_sends_stop_outside_lock(self):
        dialog = object.__new__(native_dialogs.WindowsDialogs)
        dialog._lock = threading.Lock()
        dialog._closed = False
        dialog._hwnd = 123
        dialog._WM_STOP = 0x8002
        dialog._thread = mock.Mock()
        dialog._thread.is_alive.return_value = False
        dialog._fallback_stop = mock.Mock()
        seen = []

        def notify(hwnd, message, wparam, lparam):
            # A sent notification may immediately reenter the dialog callback.
            self.assertTrue(dialog._lock.acquire(blocking=False))
            dialog._lock.release()
            seen.append((hwnd, message, wparam, lparam))
            return True

        dialog._send_stop = notify
        dialog.close()
        dialog.close()
        self.assertEqual(seen, [(123, 0x8002, 0, 0)])
        dialog._thread.join.assert_called_once_with(timeout=3)
        dialog._fallback_stop.assert_not_called()

    def test_close_timeout_falls_back_and_bounds_join(self):
        dialog = object.__new__(native_dialogs.WindowsDialogs)
        dialog._lock = threading.Lock()
        dialog._closed = False
        dialog._busy = True
        dialog._hwnd = 123
        dialog._WM_STOP = 0x8002
        dialog._thread = mock.Mock()
        dialog._thread.is_alive.return_value = True
        dialog._send_stop = mock.Mock(return_value=False)
        dialog._fallback_stop = mock.Mock()
        with self.assertLogs(native_dialogs.__name__, level='WARNING'):
            dialog.close()
        self.assertEqual(dialog._thread.join.call_args_list, [mock.call(timeout=3), mock.call(timeout=2)])
        self.assertEqual(dialog._fallback_stop.call_count, 2)
        self.assertTrue(dialog._closed)
        self.assertFalse(dialog._busy)

    def test_close_from_dialog_thread_does_not_join_itself(self):
        dialog = object.__new__(native_dialogs.WindowsDialogs)
        dialog._lock = threading.Lock()
        dialog._closed = False
        dialog._hwnd = 123
        dialog._WM_STOP = 0x8002
        dialog._thread = threading.current_thread()
        dialog._send_stop = mock.Mock(return_value=True)
        dialog._fallback_stop = mock.Mock()
        dialog.close()
        dialog._send_stop.assert_called_once_with(123, 0x8002, 0, 0)
        dialog._fallback_stop.assert_not_called()

    def test_cancel_and_raise_only_reach_an_open_chooser(self):
        dialog = object.__new__(native_dialogs.WindowsDialogs)
        dialog._lock = threading.Lock()
        dialog._closed = False
        dialog._busy = False
        dialog._events = native_dialogs.collections.deque(maxlen=5)
        dialog._cancel = mock.Mock(return_value=True)
        dialog._raise = mock.Mock(return_value={'shown': True, 'foreground': False})
        dialog._state = mock.Mock(return_value={'shown': True, 'foreground': True})
        self.assertFalse(dialog.cancel())
        self.assertEqual(dialog.raise_dialog(), {'shown': False, 'foreground': False})
        self.assertIsNone(dialog.state())
        dialog._cancel.assert_not_called()
        dialog._raise.assert_not_called()
        dialog._busy = True
        self.assertTrue(dialog.cancel())
        self.assertEqual(dialog.raise_dialog(), {'shown': True, 'foreground': False})
        self.assertEqual(dialog.state(), {'shown': True, 'foreground': True})
        self.assertEqual(dialog.diagnostics(), [{'event': 'chooser.raise', 'shown': True, 'foreground': False}])
        dialog._closed = True
        self.assertFalse(dialog.cancel())
        self.assertEqual(dialog._cancel.call_count, 1)

    def test_worker_death_fails_queued_selection_and_rejects_new_work(self):
        stop = threading.Event()
        def worker(dialog):
            dialog._post = lambda *_args: True
            dialog._hwnd = 1
            dialog._WM_CHOOSE, dialog._WM_STOP = 1, 2
            dialog._ready.set()
            self.assertTrue(stop.wait(5))
            raise RuntimeError('worker failed')
        with mock.patch.object(native_dialogs, '_windows_available', return_value=True), \
             mock.patch.object(native_dialogs.WindowsDialogs, '_run_windows', worker):
            dialog = native_dialogs.WindowsDialogs()
            pending = dialog.choose('open')
            stop.set()
            with self.assertRaisesRegex(RuntimeError, 'worker failed'):
                pending.result(timeout=5)
            dialog._thread.join(5)
            with self.assertRaisesRegex(RuntimeError, 'closed'):
                dialog.choose('open')


if __name__ == '__main__':
    unittest.main()
