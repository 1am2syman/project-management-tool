import contextlib
import hashlib
import json
import os
import queue
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from src.project_management_tool import project_files as pf

# Child interpreters run from a temp cwd, and the embedded Windows runtime's ._pth ignores cwd and PYTHONPATH,
# so each child puts the repository root on sys.path itself (the same way start.py does for the app).
REPO = Path(__file__).resolve().parents[1]
CHILD_PATH = f'import sys; sys.path.insert(0, {str(REPO)!r}); '


class Chooser:
    def __init__(self):
        self.requests = []

    def choose(self, kind, name='', initial_folder=''):
        future = Future()
        self.requests.append((kind, name, future))
        return future

    def close(self):
        for _, _, future in self.requests:
            if not future.done():
                future.set_result(None)


class ControlledChooser(Chooser):
    """Chooser exposing the native adapter's optional control and diagnostics methods."""
    def __init__(self):
        super().__init__()
        self.controls = []

    def cancel(self):
        self.controls.append('cancel')
        self.requests[-1][2].set_result(None)
        return True

    def raise_dialog(self):
        self.controls.append('raise')
        return {'shown': True, 'foreground': False}

    def state(self):
        return {'shown': True, 'foreground': False}

    def diagnostics(self):
        return [{'event': 'chooser.shown', 'shown': True, 'foreground': False}]


def authorize(_row):
    return contextlib.nullcontext()


class FileServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.registry = self.root / 'local'
        self.workspace = self.root / 'workspace' / 'plan.db'
        self.chooser = Chooser()
        self.service = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(self.service.close)
        self.source = self.root / 'source.plan'
        self.source.write_bytes(b'\xef\xbb\xbf{"name":"\xce\xa9"}\n')

    def choose(self, operation, kind, path, **options):
        status = self.service.start('client', operation, kind, **options)
        self.assertEqual(status['stage'], 'choosing')
        self.chooser.requests[-1][2].set_result(path)
        return self.wait_status(operation)

    def wait_status(self, operation):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = self.service.status('client', operation)
            if status['stage'] != 'choosing':
                return status
            time.sleep(0.005)
        self.fail('selection did not finish')

    def connect(self):
        result = self.choose('open', 'open', self.source)
        self.assertEqual(result['stage'], 'ready')
        self.assertEqual(self.service.content('client', 'open'), self.source.read_bytes())
        token = self.service.attach('client', 'open', 's1')
        self.assertEqual(token, self.service.attach('client', 'open', 's1'))
        return token

    def test_open_deduplicates_and_connection_survives_restart(self):
        first = self.service.start('client', 'o1', 'open')
        self.assertEqual(first['stage'], 'choosing')
        self.assertEqual(self.service.start('client', 'o1', 'open'), first)
        self.assertEqual(len(self.chooser.requests), 1)
        self.chooser.requests[0][2].set_result(self.source)
        self.assertEqual(self.wait_status('o1')['stage'], 'ready')
        token = self.service.attach('client', 'o1', 's1')
        self.assertEqual(self.service.start('client', 'o1', 'open')['stage'], 'succeeded')
        self.assertEqual(len(self.chooser.requests), 1)
        self.service.start('client', 'later-save', 'save', sheet='s1', token=token, revision='1')
        self.service.write('client', 'later-save', b'updated', authorize=authorize)
        self.assertEqual(self.service.attach('client', 'o1', 's1'), token)
        other = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(other.close)
        binding = other.connection('s1', token)
        self.assertIsNotNone(binding)
        assert binding is not None
        self.assertEqual(binding['fingerprint'], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertIsNone(other.connection('s2', token))
        with self.assertRaises(LookupError):
            other.status('another-client', 'o1')
        with self.assertRaises(pf.OperationError):
            other.start('client', 'o1', 'save_as', sheet='s1')

    def test_windows_ctime_lag_after_rewrite_is_not_a_change(self):
        # Windows path lookups can report a stale ctime after a rewrite. The read must succeed on the Windows rule,
        # where ctime is not compared, and still detect the same lag on POSIX, where ctime is the change time.
        self.source.write_bytes(b'{"a":1}')
        real_stat = os.stat

        def lagged(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            return SimpleNamespace(st_dev=info.st_dev, st_ino=info.st_ino, st_size=info.st_size, st_mode=info.st_mode,
                                   st_mtime_ns=info.st_mtime_ns, st_ctime_ns=info.st_ctime_ns - 1000)
        with mock.patch.object(pf, '_WINDOWS', True), mock.patch.object(pf.os, 'stat', lagged):
            self.assertEqual(pf.read_file(self.source, validate_utf8=False)[0], b'{"a":1}')
        with mock.patch.object(pf, '_WINDOWS', False), mock.patch.object(pf.os, 'stat', lagged), self.assertRaises(pf.FileConflict):
            pf.read_file(self.source, validate_utf8=False)

    def test_cancel_invalid_utf8_oversize_and_release(self):
        self.assertEqual(self.choose('cancel', 'open', None)['stage'], 'cancelled')
        self.source.write_bytes(b'\xff')
        self.assertEqual(self.choose('invalid', 'open', self.source)['error'], 'invalid_utf8')
        self.source.write_bytes(b'123456')
        with mock.patch.object(pf, 'MAX_BYTES', 5):
            self.assertEqual(self.choose('large', 'open', self.source)['error'], 'too_large')
        self.service.release('client', 'invalid')
        self.assertEqual(self.service.status('client', 'invalid')['stage'], 'released')

    def format6_document(self):
        task = {'id': 1, 'name': 'Fit-out', 'level': 0, 'start': 20759, 'dur': 5, 'progress': 0, 'owner': '', 'email': '', 'noRem': False, 'ms': False,
                'scheduling': 'auto', 'agr': {'s': 20759, 'f': 20763, 'o': 20763}}
        entry = {'id': 1, 'type': 'delay', 'taskId': 1, 'taskName': 'Fit-out', 'at': 1, 'days': 2, 'op': 'finish', 'kind': 'Overrun', 'cause': 'c1', 'party': 'Acme'}
        data = {'calendar': {'workdays': [0, 1, 2, 3, 4, 5, 6], 'holidays': []}, 'tasks': [task], 'links': [], 'nextId': 2, 'nextLink': 1,
                'log': [entry], 'nextLog': 2, 'baselined': True, 'collapsed': []}
        rem = {'on': False, 'auto': False, 'mode': 'task', 'offsets': [3, 1, 0], 'overdue': True, 'hour': 9, 'subject': 's', 'body': 'b', 'muted': []}
        return {'format': 'plan-project', 'version': 6, 'preferences': {'auto': True, 'critical': True},
                'project': {'name': 'Delay accounting', 'data': data, 'rem': rem, 'causes': [{'id': 'c1', 'name': 'Supplier / subcontractor'}]}}

    def test_format6_project_bytes_round_trip_unchanged(self):
        # The server only moves bytes; format 6 agreed dates, change log and causes must survive untouched.
        document = (json.dumps(self.format6_document(), indent=2, ensure_ascii=False) + '\n').encode('utf-8')
        self.source.write_bytes(document)
        self.assertEqual(self.choose('open', 'open', self.source)['stage'], 'ready')
        self.assertEqual(self.service.content('client', 'open'), document)
        token = self.service.attach('client', 'open', 's1')
        self.service.start('client', 'save', 'save', sheet='s1', token=token, revision='1')
        self.assertEqual(self.service.write('client', 'save', document, authorize=authorize)['stage'], 'succeeded')
        self.assertEqual(self.source.read_bytes(), document)

    @unittest.skipUnless(shutil.which('node'), 'Node.js validates the .plan format in the browser code')
    def test_format6_validation_runs_in_the_app_and_rejects_bad_agreed_data(self):
        good = self.format6_document()
        cases = {'good': (good, True)}
        for name, mutate in {
            'agreed-date': lambda d: d['project']['data']['tasks'][0]['agr'].update(f=1.5),
            'old-version': lambda d: d.update(version=5),
            'unknown-cause': lambda d: d['project']['data']['log'][0].update(cause='zzz'),
            'log-number': lambda d: d['project']['data'].update(nextLog=1),
            'future-version': lambda d: d.update(version=7),
        }.items():
            document = json.loads(json.dumps(good))
            mutate(document)
            cases[name] = (document, False)
        script = (
            "import { readFileSync } from 'node:fs';"
            f"import {{ parseProjectFile }} from {json.dumps((REPO / 'src/project_management_tool/web/js/projectfiles.js').as_uri())};"
            "const cases = JSON.parse(readFileSync(0, 'utf8')); const out = {};"
            "for (const [name, [doc, ok]] of Object.entries(cases)) { try { const p = parseProjectFile(JSON.stringify(doc)); out[name] = ok && p.data.log.length === 1 && p.data.tasks[0].agr.f === 20763; } catch (e) { out[name] = !ok && /Invalid Plan project|not supported/.test(e.message) || String(e); } }"
            "console.log(JSON.stringify(out));"
        )
        result = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(cases), capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), dict.fromkeys(cases, True))

    def test_only_the_operation_that_opened_the_chooser_can_cancel_or_raise_it(self):
        self.chooser = ControlledChooser()
        controls = self.chooser.controls
        self.service.close()
        self.service = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(self.service.close)
        self.assertEqual(self.service.start('client', 'mine', 'open')['chooser'], {'shown': True, 'foreground': False})
        self.service.start('other', 'stale', 'open')  # refused as busy by a real chooser; this fake accepts it
        self.chooser.requests[-1][2].set_result(None)
        self.assertEqual(self.wait_status_for('other', 'stale')['stage'], 'cancelled')
        # The second start took ownership of the chooser, so the first operation cannot steer it.
        self.assertEqual(self.service.raise_chooser('client', 'mine'), {'shown': False, 'foreground': False})
        self.assertNotIn('chooser', self.service.status('client', 'mine'))
        self.service.start('client', 'next', 'open')
        self.assertEqual(self.service.raise_chooser('client', 'next'), {'shown': True, 'foreground': False})
        self.assertEqual(self.service.cancel_chooser('client', 'mine')['stage'], 'choosing')
        self.assertEqual(controls, ['raise'])
        with self.assertRaises(LookupError):
            self.service.cancel_chooser('intruder', 'next')
        self.service.cancel_chooser('client', 'next')
        self.assertEqual(self.wait_status_for('client', 'next')['stage'], 'cancelled')
        self.assertEqual(controls, ['raise', 'cancel'])
        self.assertEqual(self.service.raise_chooser('client', 'next'), {'shown': False, 'foreground': False})
        self.assertIn({'backend': 'python', 'event': 'chooser.shown', 'shown': True, 'foreground': False}, self.service.diagnostics())

    def wait_status_for(self, client, operation):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = self.service.status(client, operation)
            if status['stage'] != 'choosing':
                return status
            time.sleep(0.005)
        self.fail('selection did not finish')

    def test_save_existing_and_new_destination_and_conflict(self):
        token = self.connect()
        self.assertEqual(self.service.start('client', 'save', 'save', sheet='s1', token=token, revision='1')['stage'], 'ready')
        self.assertEqual(self.service.write('client', 'save', b'{"saved":true}', authorize=authorize)['stage'], 'succeeded')
        self.assertEqual(self.source.read_bytes(), b'{"saved":true}')
        self.assertEqual(self.service.write('client', 'save', b'{"saved":true}', authorize=authorize)['stage'], 'succeeded')
        dest = self.root / 'new.plan'
        self.choose('as', 'save_as', dest, sheet='s1', revision='1')
        self.assertEqual(self.service.write('client', 'as', b'{}', authorize=authorize)['stage'], 'succeeded')
        self.assertEqual(dest.read_bytes(), b'{}')
        self.service.attach('client', 'as', 's1')
        self.choose('conflict', 'save_as', dest, sheet='s1', revision='1')
        dest.write_bytes(b'external')
        self.assertEqual(self.service.write('client', 'conflict', b'new', authorize=authorize)['stage'], 'conflict')
        self.assertEqual(dest.read_bytes(), b'external')

    def test_faults_reconcile_existing_and_new_targets(self):
        for existing in (False, True):
            for stage in ('before_journal', 'after_journal', 'before_replace', 'after_replace', 'before_registry_ack'):
                with self.subTest(existing=existing, stage=stage):
                    dest = self.root / f'{existing}-{stage}.plan'
                    if existing:
                        dest.write_bytes(b'old')
                    op = f'{existing}-{stage}'
                    self.choose(op, 'save_as', dest, sheet='s1', revision='1')
                    def fault(where, expected=stage):
                        if where == expected:
                            raise RuntimeError('injected interruption')
                    self.service.fault = fault
                    with self.assertRaisesRegex(RuntimeError, 'injected'):
                        self.service.write('client', op, b'new', authorize=authorize)
                    self.service.fault = lambda _: None
                    restored = pf.FileService(self.registry, self.workspace, self.chooser)
                    self.addCleanup(restored.close)
                    state = restored.status('client', op)['stage']
                    self.assertEqual(state, 'ready' if stage == 'before_journal' else ('succeeded' if stage in ('after_replace', 'before_registry_ack') else 'failed'))
                    self.assertEqual(dest.read_bytes() if dest.exists() else None,
                                     b'new' if stage in ('after_replace', 'before_registry_ack') else (b'old' if existing else None))

    def test_reconciles_connected_save_and_reports_external_recovery_conflict(self):
        token = self.connect()
        self.service.start('client', 'save-crash', 'save', sheet='s1', token=token, revision='1')
        def interrupted(where):
            if where == 'before_registry_ack':
                raise RuntimeError('interrupted')
        self.service.fault = interrupted
        with self.assertRaises(RuntimeError):
            self.service.write('client', 'save-crash', b'committed', authorize=authorize)
        restored = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(restored.close)
        self.assertEqual(restored.status('client', 'save-crash')['stage'], 'succeeded')
        binding = restored.connection('s1', token)
        assert binding is not None
        self.assertEqual(binding['fingerprint'], hashlib.sha256(b'committed').hexdigest())
        restored.start('client', 'save-conflict', 'save', sheet='s1', token=token, revision='1')
        restored.fault = lambda where: (_ for _ in ()).throw(RuntimeError('interrupted')) if where == 'after_journal' else None
        with self.assertRaises(RuntimeError):
            restored.write('client', 'save-conflict', b'new', authorize=authorize)
        self.source.write_bytes(b'external')
        last = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(last.close)
        self.assertEqual(last.status('client', 'save-conflict')['stage'], 'conflict')
        self.assertEqual(self.source.read_bytes(), b'external')

    def test_replaced_file_with_same_bytes_is_detected(self):
        token = self.connect()
        self.service.start('client', 'same-bytes', 'save', sheet='s1', token=token, revision='1')
        replacement = self.root / 'replacement'
        replacement.write_bytes(self.source.read_bytes())
        os.replace(replacement, self.source)
        self.assertEqual(self.service.write('client', 'same-bytes', b'new', authorize=authorize)['stage'], 'conflict')
        self.assertNotEqual(self.source.read_bytes(), b'new')

    def test_replace_failure_preserves_original_and_journal(self):
        token = self.connect()
        self.service.start('client', 'failed-save', 'save', sheet='s1', token=token, revision='1')
        original = self.source.read_bytes()
        with mock.patch.object(pf, '_replace', side_effect=PermissionError('locked')), self.assertRaises(PermissionError):
            self.service.write('client', 'failed-save', b'new', authorize=authorize)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(self.service.status('client', 'failed-save')['stage'], 'failed')
        restored = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(restored.close)
        self.assertEqual(restored.status('client', 'failed-save')['stage'], 'failed')
        self.assertEqual(list(self.root.glob('.plan-write-*.tmp')), [])

    def test_concurrent_saves_to_same_destination_are_serialized(self):
        self.choose('first', 'save_as', self.source, sheet='s1', revision='1')
        self.choose('second', 'save_as', self.source, sheet='s2', revision='1')
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.service.write, 'client', op, data, authorize=authorize)
                       for op, data in [('first', b'first'), ('second', b'second')]]
            states = sorted(f.result()['stage'] for f in futures)
        self.assertEqual(states, ['conflict', 'succeeded'])
        self.assertIn(self.source.read_bytes(), (b'first', b'second'))

    def test_restart_marks_abandoned_chooser_without_interrupting_live_process(self):
        self.service.start('client', 'active', 'open')
        other = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(other.close)
        self.assertEqual(other.status('client', 'active')['stage'], 'choosing')
        script = CHILD_PATH + '''
import os, sys
from concurrent.futures import Future
from src.project_management_tool.project_files import FileService
class Chooser:
 def choose(self, *args): return Future()
 def close(self): pass
s = FileService(sys.argv[1], sys.argv[2], Chooser())
s.start('dead-client', 'op', 'open')
os._exit(23)
'''
        result = subprocess.run([sys.executable, '-B', '-c', script, str(self.registry), str(self.workspace)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 23, result.stderr)
        restored = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(restored.close)
        self.assertEqual(restored.status('dead-client', 'op')['error'], 'chooser_interrupted')
        self.assertEqual(restored.status('client', 'active')['stage'], 'choosing')

    def test_process_death_cleans_journaled_temporary_and_preserves_original(self):
        destination = self.source
        original = destination.read_bytes()
        script = CHILD_PATH + '''
import contextlib, os, sys
from concurrent.futures import Future
from src.project_management_tool.project_files import FileService
class Chooser:
 def choose(self, *args):
  f = Future(); f.set_result(sys.argv[3]); return f
 def close(self): pass
def fault(stage):
 if stage == 'before_replace': os._exit(19)
s = FileService(sys.argv[1], sys.argv[2], Chooser(), fault=fault)
s.start('crashed-client', 'op', 'save_as', sheet='s1', revision='1')
import time
while s.status('crashed-client', 'op')['stage'] == 'choosing': time.sleep(.005)
s.write('crashed-client', 'op', b'new', authorize=lambda row: contextlib.nullcontext())
'''
        result = subprocess.run([sys.executable, '-B', '-c', script, str(self.registry), str(self.workspace), str(destination)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 19, result.stderr)
        self.assertEqual(len(list(self.root.glob('.plan-write-*.tmp'))), 1)
        restarted = pf.FileService(self.registry, self.workspace, self.chooser)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.status('crashed-client', 'op')['stage'], 'failed')
        self.assertEqual(destination.read_bytes(), original)
        self.assertEqual(list(self.root.glob('.plan-write-*.tmp')), [])

    def test_selected_read_runs_off_chooser_callback_thread_and_close_waits(self):
        entered, proceed = threading.Event(), threading.Event()
        original = pf.read_file
        def delayed(path, **kwargs):
            entered.set()
            self.assertTrue(proceed.wait(5))
            return original(path, **kwargs)
        with mock.patch.object(pf, 'read_file', side_effect=delayed):
            self.service.start('client', 'async-open', 'open')
            self.chooser.requests[-1][2].set_result(self.source)
            self.assertTrue(entered.wait(5))
            with ThreadPoolExecutor(max_workers=1) as pool:
                closed = pool.submit(self.service.close)
                self.assertFalse(closed.done())
                proceed.set()
                closed.result(timeout=5)
        self.assertEqual(self.service.status('client', 'async-open')['stage'], 'ready')
        with self.assertRaises(pf.OperationError):
            self.service.start('client', 'after-close', 'open')

    def test_foreign_registry_database_is_preserved(self):
        location = self.root / 'foreign'
        location.mkdir()
        database = location / 'file-connections.sqlite3'
        with contextlib.closing(sqlite3.connect(database)) as db, db:
            db.execute('CREATE TABLE unrelated (value TEXT)')
            db.execute('INSERT INTO unrelated VALUES (?)', ('keep',))
        original = database.read_bytes()
        with self.assertRaisesRegex(ValueError, 'another application'):
            pf.FileService(location, self.workspace, self.chooser)
        self.assertEqual(database.read_bytes(), original)

    def test_unfinished_operation_limit_preserves_existing_ids(self):
        for number in range(20):
            self.service.start('client', f'pending-{number}', 'open')
        self.assertEqual(self.service.start('client', 'pending-0', 'open')['stage'], 'choosing')
        with self.assertRaisesRegex(pf.OperationError, 'Too many'):
            self.service.start('client', 'overflow', 'open')
        self.assertEqual(len(self.chooser.requests), 20)
        self.service.release('client', 'pending-0')
        self.assertEqual(self.service.start('client', 'new', 'open')['stage'], 'choosing')

    def test_release_cannot_overwrite_writing_stage(self):
        token = self.connect()
        self.service.start('client', 'reverse-race', 'save', sheet='s1', token=token, revision='1')
        release_read, let_release, journaled, let_write = (threading.Event() for _ in range(4))
        def fault(stage):
            if stage == 'release_after_read':
                release_read.set()
                self.assertTrue(let_release.wait(5))
            elif stage == 'after_journal':
                journaled.set()
                self.assertTrue(let_write.wait(5))
        self.service.fault = fault
        with ThreadPoolExecutor(max_workers=2) as pool:
            released = pool.submit(self.service.release, 'client', 'reverse-race')
            self.assertTrue(release_read.wait(5))
            saved = pool.submit(self.service.write, 'client', 'reverse-race', b'new', authorize=authorize)
            self.assertTrue(journaled.wait(5))
            let_release.set()
            released.result(timeout=5)
            with contextlib.closing(self.service._connect()) as db:
                self.assertEqual(self.service._get(db, 'client', 'reverse-race')['stage'], 'writing')
            let_write.set()
            self.assertEqual(saved.result(timeout=5)['stage'], 'succeeded')
        self.assertEqual(self.source.read_bytes(), b'new')

    def test_delayed_chooser_preserves_snapshot_staged_before_selection(self):
        target = self.root / 'delayed.plan'
        self.service.start('client', 'delayed', 'save_as', sheet='s1', revision='1')
        self.service.stage_snapshot('client', 'delayed', b'captured')
        self.chooser.requests[-1][2].set_result(target)
        self.assertTrue(self.wait_status('delayed')['hasSnapshot'])
        self.assertEqual(self.service.write_staged('client', 'delayed', authorize=authorize)['stage'], 'succeeded')
        self.assertEqual(target.read_bytes(), b'captured')

    def test_release_before_commit_prevents_file_mutation(self):
        token = self.connect()
        self.service.start('client', 'release-race', 'save', sheet='s1', token=token, revision='1')
        original = self.source.read_bytes()
        entered, proceed = threading.Event(), threading.Event()
        @contextlib.contextmanager
        def release_during_authorization(_row):
            entered.set()
            self.assertTrue(proceed.wait(5))
            yield
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.service.write, 'client', 'release-race', b'new', authorize=release_during_authorization)
            self.assertTrue(entered.wait(5))
            self.service.release('client', 'release-race')
            proceed.set()
            with self.assertRaises(pf.OperationError):
                pending.result(timeout=5)
        self.assertEqual(self.service.status('client', 'release-race')['stage'], 'released')
        self.assertEqual(self.source.read_bytes(), original)

    def test_registry_lock_is_shared_across_processes(self):
        script = (CHILD_PATH + 'from src.project_management_tool.project_files import registry_lock; '
                  'import sys; print("attempting", flush=True); '
                  'exec("with registry_lock(sys.argv[1]):\\n print(\\"acquired\\", flush=True)")')
        def attempt(locked):
            with contextlib.ExitStack() as stack:
                if locked:
                    stack.enter_context(pf.registry_lock(self.registry))
                child = subprocess.Popen([sys.executable, '-u', '-c', script, str(self.registry)],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
                assert child.stdout is not None
                self.assertEqual(child.stdout.readline().strip(), 'attempting')
                output = child.stdout
                messages = queue.Queue()
                reader = threading.Thread(target=lambda: messages.put(output.readline().strip()), daemon=True)
                reader.start()
                if locked:
                    with self.assertRaises(queue.Empty):
                        messages.get(timeout=0.5)
                else:
                    self.assertEqual(messages.get(timeout=5), 'acquired', 'negative control must acquire without a held lock')
            if locked:
                self.assertEqual(messages.get(timeout=5), 'acquired')
            reader.join(timeout=5)
            _, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, stderr)
        attempt(False)
        attempt(True)

    def test_save_as_to_connected_source_checks_original_fingerprint(self):
        token = self.connect()
        self.source.write_bytes(b'external')
        self.choose('same-source', 'save_as', self.source, sheet='s1', token=token, revision='1')
        @contextlib.contextmanager
        def editable(_row):
            yield {'readOnly': False}
        with self.assertRaises(pf.FileConflict):
            self.service.write('client', 'same-source', b'new', authorize=editable)
        self.assertEqual(self.source.read_bytes(), b'external')

    def test_copy_only_rejects_source_aliases_but_allows_separate_destination(self):
        token = self.connect()
        alias = self.root / 'alias-copy.plan'
        try:
            os.link(self.source, alias)
        except OSError:
            self.skipTest('hard links unavailable')
        self.choose('copy-same', 'save_as', alias, sheet='s1', token=token, revision='1', copy_only=True)
        @contextlib.contextmanager
        def editable(_row):
            yield {'readOnly': False}
        original = self.source.read_bytes()
        with self.assertRaises(pf.FileConflict):
            self.service.write('client', 'copy-same', b'new', authorize=editable)
        self.assertEqual(self.source.read_bytes(), original)
        link = self.root / 'link-copy.plan'
        try:
            link.symlink_to(self.source)
        except OSError:
            link = None
        if link is not None:
            self.choose('copy-link', 'save_as', link, sheet='s1', token=token, revision='1', copy_only=True)
            with self.assertRaises(pf.FileConflict):
                self.service.write('client', 'copy-link', b'new', authorize=editable)
            self.assertEqual(self.source.read_bytes(), original)
        destination = self.root / 'copy.plan'
        self.choose('copy-other', 'save_as', destination, sheet='s1', token=token, revision='1', copy_only=True)
        self.assertEqual(self.service.write('client', 'copy-other', b'new', authorize=editable)['stage'], 'succeeded')
        self.assertEqual(destination.read_bytes(), b'new')
        self.assertEqual(self.source.read_bytes(), original)

    def test_aliases_and_denied_workspace_authorization(self):
        token = self.connect()
        alias = self.root / 'alias.plan'
        try:
            os.link(self.source, alias)
        except OSError:
            self.skipTest('hard links unavailable')
        self.assertTrue(pf.same_destination(self.source, alias))
        self.service.start('client', 'denied', 'save', sheet='s1', token=token, revision='1')
        @contextlib.contextmanager
        def deny(_row):
            raise PermissionError('stale workspace')
            yield
        original = self.source.read_bytes()
        with self.assertRaises(PermissionError):
            self.service.write('client', 'denied', b'changed', authorize=deny)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(self.service.status('client', 'denied')['stage'], 'ready')


if __name__ == '__main__':
    unittest.main()
