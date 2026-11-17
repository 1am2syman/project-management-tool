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
    def choose(self, kind, *_):
        result = Future()
        path = root / ('opened.plan' if kind == 'open' else 'saved.plan')
        threading.Timer(0.25, result.set_result, args=(path,)).start()
        return result
    def close(self):
        pass


server = create_server(int(sys.argv[2]) if len(sys.argv) > 2 else 0, root / 'workspace', native_files=False)
service = FileService(root / 'registry', root / 'workspace' / 'plan.db', TestChooser())
server.use_file_service(service)
print(f'http://127.0.0.1:{server.server_port}/', flush=True)
try:
    server.serve_forever()
finally:
    service.close()
    server.server_close()
