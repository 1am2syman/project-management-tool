"""Isolated browser-test server with an injected chooser; never use real user files."""
import sys
import threading
from concurrent.futures import Future
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.project_management_tool import create_server  # noqa: E402
from src.project_management_tool.project_files import FileService  # noqa: E402

root = Path(sys.argv[1]).resolve()


class TestChooser:
    """Selects a fixed file after 250 ms. A 'hold-chooser' marker keeps it open, like a
    Windows chooser hidden behind the browser, until the page cancels it."""
    def __init__(self):
        self.pending = None
        self.raised = 0

    def choose(self, kind, *_):
        result = Future()
        path = root / ('opened.plan' if kind == 'open' else 'saved.plan')
        if (root / 'hold-chooser').exists():
            self.pending = result
        else:
            threading.Timer(0.25, result.set_result, args=(path,)).start()
        return result

    def cancel(self):
        pending, self.pending = self.pending, None
        if pending and not pending.done():
            pending.set_result(None)
        return pending is not None

    def raise_dialog(self):
        self.raised += 1
        return {'shown': self.pending is not None, 'foreground': False}

    def state(self):
        return {'shown': True, 'foreground': False} if self.pending else None

    def diagnostics(self):
        return [{'event': 'chooser.raise', 'count': self.raised}] if self.raised else []

    def close(self):
        self.cancel()


server = create_server(int(sys.argv[2]) if len(sys.argv) > 2 else 0, root / 'workspace', native_files=False)
service = FileService(root / 'registry', root / 'workspace' / 'plan.db', TestChooser())
server.use_file_service(service)
print(f'http://127.0.0.1:{server.server_port}/', flush=True)
try:
    server.serve_forever()
finally:
    service.close()
    server.server_close()
