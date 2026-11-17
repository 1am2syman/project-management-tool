import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import Future
from contextlib import closing
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

from src.project_management_tool import create_server
from src.project_management_tool.persistence import ProjectStorage
from src.project_management_tool.project_files import FileService


class Chooser:
    def __init__(self):
        self.requests = []
    def choose(self, *_):
        future = Future()
        self.requests.append(future)
        return future
    def close(self):
        for future in self.requests:
            if not future.done():
                future.set_result(None)


class FileApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = create_server(0, self.root / 'workspace', native_files=False)
        self.chooser = Chooser()
        self.server.use_file_service(FileService(self.root / 'local', self.root / 'workspace' / 'plan.db', self.chooser))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.shutdown)
        self.host = f'127.0.0.1:{self.server.server_port}'
        self.origin = 'http://' + self.host

    def shutdown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        if self.server.file_service:
            self.server.file_service.close()

    def request(self, method, path, headers=None, body=None):
        with closing(HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)) as conn:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), raw

    def headers(self):
        return {'Host': self.host, 'Origin': self.origin, 'X-Plan-Session': self.server.file_session,
                'X-Plan-Client': 'client', 'Content-Type': 'application/json'}

    def test_locked_and_permission_errors_are_actionable_without_path_disclosure(self):
        assert self.server.file_service is not None
        class WindowsPermissionError(PermissionError):
            winerror: int

        for code, winerror, message in [('file_in_use', 32, 'Close it and try again'),
                                        ('file_in_use', 33, 'Close it and try again'),
                                        ('permission_denied', 5, 'permissions')]:
            error = WindowsPermissionError('private destination path must not be returned')
            error.winerror = winerror
            with self.subTest(winerror=winerror), mock.patch.object(self.server.file_service, 'write_staged', side_effect=error):
                status, _, raw = self.request('POST', '/api/file-operations/op/commit', self.headers(), '{}')
            self.assertEqual(status, 503)
            result = json.loads(raw)
            self.assertEqual(result['code'], code)
            self.assertIn(message, result['error'])
            self.assertNotIn('private destination', result['error'])

    def test_startup_failure_is_explicit_and_bootstrap_can_retry(self):
        assert self.server.file_service is not None
        self.server.file_service.close()
        self.server.file_service = None
        with mock.patch('src.project_management_tool.native_windows_available', return_value=True), \
             mock.patch('src.project_management_tool.WindowsDialogs', side_effect=OSError('unavailable')):
            self.server.ensure_file_service()
            self.assertTrue(self.server.file_failed)
            status, _, raw = self.request('GET', '/api/file-access', {'Host': self.host, 'X-Plan-Bootstrap': '1'})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)['status'], 'failed')
            self.assertEqual(self.request('GET', '/api/diagnostics')[0], 200)
        with mock.patch('src.project_management_tool.native_windows_available', return_value=True), \
             mock.patch.dict('os.environ', {'LOCALAPPDATA': str(self.root)}), \
             mock.patch('src.project_management_tool.WindowsDialogs', return_value=Chooser()):
            status, _, raw = self.request('GET', '/api/file-access', {'Host': self.host, 'X-Plan-Bootstrap': '1'})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)['status'], 'available')
            self.assertFalse(self.server.file_failed)

    def test_injected_service_clears_failed_status_and_isolated_servers_skip_native(self):
        with mock.patch('src.project_management_tool.native_windows_available', return_value=True), \
             mock.patch('src.project_management_tool.WindowsDialogs', side_effect=AssertionError('native chooser must not start')):
            isolated = create_server(0, self.root / 'isolated', native_files=False)
            self.addCleanup(isolated.server_close)
            self.assertFalse(isolated.file_failed)
            self.assertIsNone(isolated.file_service)
            failed = create_server(0, self.root / 'failed')
            self.addCleanup(failed.server_close)
            self.assertTrue(failed.file_failed)
            injected = FileService(self.root / 'local-injected', self.root / 'failed' / 'plan.db', Chooser())
            self.addCleanup(injected.close)
            failed.use_file_service(injected)
            self.assertFalse(failed.file_failed)
            self.assertIsNotNone(failed.file_service)

    def test_bootstrap_and_foreign_host_origin_and_session_rejected(self):
        code, _, _ = self.request('GET', '/api/file-access')
        self.assertEqual(code, 403)
        code, _, raw = self.request('GET', '/api/file-access', {'Host': self.host, 'X-Plan-Bootstrap': '1'})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)['session'], self.server.file_session)
        for changes in ({'Host': 'evil.example'}, {'Origin': 'https://evil.example'}, {'X-Plan-Session': 'wrong'}):
            headers = self.headers() | changes
            code, response_headers, _ = self.request('POST', '/api/file-operations', headers,
                                                      json.dumps({'id': 'op', 'kind': 'open'}))
            self.assertEqual(code, 403)
            self.assertNotIn('Access-Control-Allow-Origin', response_headers)
        self.assertEqual(self.chooser.requests, [])

    def test_open_attach_and_save_enforce_workspace_revision_and_token(self):
        storage = ProjectStorage(self.root / 'workspace')
        state = {'workbook': {'active': 's1', 'sheets': [
            {'id': 's1', 'name': 'Test', 'data': {'tasks': [], 'links': []}}]}}
        revision = storage.write(None, state)['revision']
        path = self.root / 'file.plan'
        path.write_bytes(b'{}')
        headers = self.headers()
        self.assertEqual(self.request('POST', '/api/file-operations', headers,
                                      json.dumps({'id': 'open', 'kind': 'open'}))[0], 200)
        self.chooser.requests[-1].set_result(path)
        deadline = time.monotonic() + 5
        while True:
            status, _, raw = self.request('GET', '/api/file-operations/open', headers)
            result = json.loads(raw)
            if result['stage'] != 'choosing':
                break
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.005)
        self.assertEqual((status, result['stage']), (200, 'ready'))
        token = result['token']
        _, _, diagnostics = self.request('GET', '/api/diagnostics')
        self.assertNotIn(str(path).encode(), diagnostics)
        self.assertNotIn(token.encode(), diagnostics)
        self.assertNotIn(self.server.file_session.encode(), diagnostics)
        self.assertNotIn(b'{\\"new\\":true}', diagnostics)
        status, _, raw = self.request('POST', '/api/file-operations/open/attach', headers,
                                      json.dumps({'sheet': 's1', 'revision': revision}))
        # Sheet not yet bound to the token: a real authorization conflict, not a revision race.
        self.assertEqual((status, json.loads(raw)['reason']), (409, 'conflict'))
        state['workbook']['sheets'][0]['fileToken'] = token
        revision = storage.write(revision, state)['revision']
        self.assertEqual(self.request('POST', '/api/file-operations/open/attach', headers,
                                      json.dumps({'sheet': 's1', 'revision': revision}))[0], 200)
        body = json.dumps({'id': 'save', 'kind': 'save', 'sheet': 's1', 'token': token, 'revision': revision})
        self.assertEqual(self.request('POST', '/api/file-operations', headers, body)[0], 200)
        state['workbook']['sheets'][0]['name'] = 'changed elsewhere'
        storage.write(revision, state)
        status, _, raw = self.request('PUT', '/api/file-operations/save/content', headers, b'{"new":true}')
        self.assertEqual((status, json.loads(raw)['reason']), (409, 'revision'))
        self.assertEqual(path.read_bytes(), b'{}')

    def test_copy_to_connected_source_is_denied_even_through_link(self):
        storage = ProjectStorage(self.root / 'workspace')
        path = self.root / 'file.plan'
        path.write_bytes(b'{}')
        alias = self.root / 'alias.plan'
        try:
            alias.symlink_to(path)
        except OSError:
            self.skipTest('symbolic links unavailable')
        state = {'workbook': {'active': 's1', 'sheets': [
            {'id': 's1', 'name': 'Test', 'data': {'tasks': [], 'links': []}}]}}
        revision = storage.write(None, state)['revision']
        service = self.server.file_service
        assert service is not None
        service.start('client', 'open', 'open')
        self.chooser.requests[-1].set_result(path)
        deadline = time.monotonic() + 5
        while (result := service.status('client', 'open'))['stage'] == 'choosing':
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.005)
        token = result['token']
        state['workbook']['sheets'][0]['fileToken'] = token
        revision = storage.write(revision, state)['revision']
        service.attach('client', 'open', 's1')
        service.start('client', 'copy', 'save_as', sheet='s1', token=token, revision=revision, copy_only=True)
        self.chooser.requests[-1].set_result(alias)
        while service.status('client', 'copy')['stage'] == 'choosing':
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.005)
        status, _, raw = self.request('PUT', '/api/file-operations/copy/content', self.headers() | {'X-Plan-Revision': revision}, b'new')
        self.assertEqual((status, json.loads(raw)['reason']), (409, 'conflict'))
        self.assertEqual(path.read_bytes(), b'{}')

    def test_authorized_start_deduplicates_and_content_is_session_protected(self):
        headers = self.headers()
        body = json.dumps({'id': 'op', 'kind': 'open'})
        for _ in range(2):
            code, _, _ = self.request('POST', '/api/file-operations', headers, body)
            self.assertEqual(code, 200)
        self.assertEqual(len(self.chooser.requests), 1)
        self.chooser.requests[0].set_result(None)
        code, _, _ = self.request('GET', '/api/file-operations/op/content', {'Host': self.host})
        self.assertEqual(code, 403)
        code, _, _ = self.request('GET', '/api/file-operations/op', headers | {'X-Plan-Client': 'other'})
        self.assertEqual(code, 404)


if __name__ == '__main__':
    unittest.main()
