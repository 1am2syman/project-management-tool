"""Bounded project-file I/O primitives used by the local file service.

These helpers do not authorize paths: callers must obtain them from a local
connection or an OS chooser, and hold the workspace and destination locks for
comparison and commit. External programs do not participate in those locks.
"""
import concurrent.futures
import contextlib
import hashlib
import json
import os
import re
import stat
import tempfile
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from .native_dialogs import DialogBusy
from .persistence import MAX_BYTES


class FileConflict(Exception):
    """The destination changed after it was selected or last confirmed."""


class FileTooLarge(ValueError):
    """A project exceeds the project file size limit."""


def canonical_path(path):
    return Path(path).resolve(strict=False)


def same_destination(left, right):
    left, right = canonical_path(left), canonical_path(right)
    try:
        return os.path.samefile(left, right)
    except FileNotFoundError:
        return os.path.normcase(str(left)) == os.path.normcase(str(right))


# On Windows st_ctime is the creation time, and a path lookup can lag the handle's metadata after a rewrite
# (NTFS directory entries update lazily). A rewrite then looks like a change on every read. Size, mtime and
# identity still detect a change there, so ctime is compared only where it is the change time.
_WINDOWS = os.name == 'nt'


def _signature(info):
    if _WINDOWS:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_file(path, *, validate_utf8=True):
    """Return the exact bounded bytes and their fingerprint, refusing an unstable read."""
    digest = hashlib.sha256()
    chunks = []
    total = 0
    with open(path, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise OSError('Selected item is not a regular file')
        while True:
            chunk = stream.read(min(1024 * 1024, MAX_BYTES + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                raise FileTooLarge('Plan project files must be 64 MB or smaller')
            chunks.append(chunk)
            digest.update(chunk)
        after = os.fstat(stream.fileno())
    if _signature(before) != _signature(after) or _signature(after) != _signature(os.stat(path)):
        raise FileConflict('The file changed while it was being read')
    data = b''.join(chunks)
    if validate_utf8:
        data.decode('utf-8')  # Keep BOM and fingerprint tied to the exact bytes.
    return data, digest.hexdigest()


def file_identity(path):
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return None
    return json.dumps(_signature(info), separators=(',', ':'))


def fingerprint(path):
    try:
        return read_file(path, validate_utf8=False)[1]
    except FileNotFoundError:
        return None


def _replace(temp, destination, existed):
    if os.name != 'nt':
        if existed:
            os.replace(temp, destination)
        else:
            # link is exclusive, so creation cannot overwrite an unexpected target.
            os.link(temp, destination)
            os.unlink(temp)
        return
    import ctypes
    from ctypes import WinDLL, WinError, get_last_error, wintypes  # type: ignore[attr-defined]
    kernel = WinDLL('kernel32', use_last_error=True)
    kernel.ReplaceFileW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                   wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
    kernel.ReplaceFileW.restype = wintypes.BOOL
    kernel.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    kernel.MoveFileExW.restype = wintypes.BOOL
    if existed:
        ok = kernel.ReplaceFileW(str(destination), str(temp), None, 0, None, None)
    else:
        # MOVEFILE_WRITE_THROUGH; omit REPLACE_EXISTING for exclusive creation.
        ok = kernel.MoveFileExW(str(temp), str(destination), 0x8)
    if not ok:
        raise WinError(get_last_error())


def checked_write(path, data, previous, *, previous_identity=None, temporary=None, before_replace=lambda: None):
    """Commit bytes if the current fingerprint matches; return the new fingerprint.

    The caller must journal the intended fingerprints durably before this call
    and reconcile exceptions occurring during or after replacement. The check
    cannot exclude writes from unrelated programs between check and replacement.
    """
    if not isinstance(data, bytes):
        raise TypeError('Project content must be bytes')
    if len(data) > MAX_BYTES:
        raise FileTooLarge('Plan project files must be 64 MB or smaller')
    data.decode('utf-8')
    path = canonical_path(path)
    desired = hashlib.sha256(data).hexdigest()
    if fingerprint(path) != previous or (previous is not None and file_identity(path) != previous_identity):
        raise FileConflict('The file changed outside Plan')
    if temporary is None:
        fd, temp_name = tempfile.mkstemp(prefix='.plan-write-', suffix='.tmp', dir=path.parent)
    else:
        temp_name = str(temporary)
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if previous is not None and os.name != 'nt':
            # On Windows ReplaceFile retains destination metadata; preserve mode on POSIX.
            os.chmod(temp_name, stat.S_IMODE(os.stat(path).st_mode))
        if fingerprint(path) != previous or (previous is not None and file_identity(path) != previous_identity):
            raise FileConflict('The file changed outside Plan')
        before_replace()
        _replace(temp_name, path, previous is not None)
        if fingerprint(path) != desired:
            raise FileConflict('Could not confirm the saved file')
        return desired
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)


# A single registry-wide lock deliberately serializes every destination. Unlike
# a path-derived lock, it also covers hard links, junctions, case aliases and a
# destination transitioning from absent to present. Other applications do not
# acquire this lock, so their writes can still race the final replacement.
@contextlib.contextmanager
def registry_lock(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(directory / 'file-operations.lock', os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, 'r+b') as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b'\0')
            stream.flush()
        stream.seek(0)
        if os.name == 'nt':
            import msvcrt  # type: ignore[import-not-found]
            # LK_LOCK retries for a bounded period; failure is safer than an unlocked write.
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)


def _lock_byte(stream, *, blocking):
    stream.seek(0)
    if os.name == 'nt':
        import msvcrt  # type: ignore[import-not-found]
        msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))


def _unlock_byte(stream):
    stream.seek(0)
    if os.name == 'nt':
        import msvcrt  # type: ignore[import-not-found]
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(stream, fcntl.LOCK_UN)


def lease_file(directory, identity):
    leases = directory / 'leases'
    leases.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(leases / (identity + '.lock'), os.O_RDWR | os.O_CREAT, 0o600)
    stream = os.fdopen(descriptor, 'r+b')
    if os.fstat(stream.fileno()).st_size == 0:
        stream.write(b'\0')
        stream.flush()
    return stream


class OperationError(Exception):
    pass


class FileService:
    """Persistent operation journal and connections, isolated by workspace/client.

    chooser.choose returns a Future whose result is an OS-selected path or None.
    The authorize callback is supplied by the HTTP integration and must check
    sheet/token/revision against a locked workspace before file mutation.
    """
    def __init__(self, directory, workspace, chooser, *, fault=None):
        self.directory = Path(directory).resolve()
        self.workspace = os.path.normcase(str(canonical_path(workspace)))
        self.chooser = chooser
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix='plan-file-io')
        self._lifecycle = threading.RLock()
        self._event_lock = threading.Lock()
        self._events = deque(maxlen=200)
        self._event_stages = {}
        self._closed = False
        self.fault = fault or (lambda stage: None)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / 'file-connections.sqlite3'
        self.instance = uuid.uuid4().hex
        self._lease = lease_file(self.directory, self.instance)
        _lock_byte(self._lease, blocking=True)
        try:
            self._initialize_registry()
            self.reconcile()
            self.cleanup()
        except BaseException:
            _unlock_byte(self._lease)
            self._lease.close()
            with contextlib.suppress(FileNotFoundError):
                (self.directory / 'leases' / (self.instance + '.lock')).unlink()
            self._executor.shutdown(wait=True)
            raise

    def _initialize_registry(self):
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        with contextlib.closing(self._connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            identity = db.execute('PRAGMA application_id').fetchone()[0]
            if identity == 0:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table'").fetchone():
                    raise ValueError('The local connection database belongs to another application')
                db.execute('''CREATE TABLE operations (
                    workspace TEXT NOT NULL, client TEXT NOT NULL, id TEXT NOT NULL,
                    kind TEXT NOT NULL, sheet TEXT, requested_sheet TEXT, token TEXT, source_token TEXT, revision TEXT,
                    stage TEXT NOT NULL, path TEXT, previous TEXT, previous_identity TEXT, proposed TEXT,
                    content BLOB, error TEXT, temporary TEXT, owner TEXT NOT NULL, copy_only INTEGER NOT NULL, commit_revision TEXT, created REAL NOT NULL,
                    PRIMARY KEY (workspace, client, id))''')
                db.execute('''CREATE TABLE connections (
                    workspace TEXT NOT NULL, token TEXT NOT NULL, sheet TEXT NOT NULL,
                    path TEXT NOT NULL, fingerprint TEXT NOT NULL, identity TEXT NOT NULL,
                    PRIMARY KEY (workspace, token))''')
                db.execute('CREATE TABLE settings (workspace TEXT PRIMARY KEY, last_folder TEXT NOT NULL)')
                db.execute('PRAGMA application_id=1346784325')
                db.execute('PRAGMA user_version=1')
            elif identity != 1346784325 or db.execute('PRAGMA user_version').fetchone()[0] != 1:
                raise ValueError('Unknown local connection database format')
            db.commit()
        if os.name != 'nt':
            os.chmod(self.path, 0o600)


    def close(self):
        with self._lifecycle:
            if self._closed:
                return
            self._closed = True
        try:
            self.chooser.close()
        finally:
            self._executor.shutdown(wait=True)
            _unlock_byte(self._lease)
            self._lease.close()
            with contextlib.suppress(FileNotFoundError):
                (self.directory / 'leases' / (self.instance + '.lock')).unlink()

    def _connect(self):
        import sqlite3
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA secure_delete=ON')
        db.execute('PRAGMA busy_timeout=30000')
        return db

    def _get(self, db, client, operation):
        row = db.execute('SELECT * FROM operations WHERE workspace=? AND client=? AND id=?',
                         (self.workspace, client, operation)).fetchone()
        if row is None:
            raise LookupError('Unknown file operation')
        return row

    def _public(self, row):
        key = (row['client'], row['id'])
        with self._event_lock:
            if self._event_stages.get(key) != row['stage']:
                if len(self._event_stages) >= 200:
                    self._event_stages.clear()
                self._event_stages[key] = row['stage']
                self._events.append({'backend': 'python', 'kind': row['kind'], 'stage': row['stage'],
                                     'durationMs': max(0, round((time.time() - row['created']) * 1000)),
                                     'code': row['error']})
        result = {'id': row['id'], 'kind': row['kind'], 'stage': row['stage']}
        if row['error']:
            result['error'] = row['error']
        if row['stage'] in ('ready', 'succeeded') and row['token']:
            result['token'] = row['token']
        if row['kind'] in ('save', 'save_as'):
            result['hasSnapshot'] = row['content'] is not None
        return result

    def diagnostics(self):
        with self._event_lock:
            return list(self._events)

    def status(self, client, operation):
        with contextlib.closing(self._connect()) as db:
            row = self._get(db, client, operation)
            result = self._public(row)
        if result['stage'] == 'writing':
            # Wait for a live writer holding the registry lock, or reconcile an
            # interrupted writer after it releases the OS lock on process exit.
            self.reconcile()
            with contextlib.closing(self._connect()) as db:
                result = self._public(self._get(db, client, operation))
        return result

    def connection(self, sheet, token):
        with contextlib.closing(self._connect()) as db:
            row = db.execute('SELECT * FROM connections WHERE workspace=? AND sheet=? AND token=?',
                             (self.workspace, sheet, token)).fetchone()
            return dict(row) if row else None

    def start(self, client, operation, kind, *, sheet=None, token=None, revision=None, suggested_name='', copy_only=False):
        with self._lifecycle:
            return self._start(client, operation, kind, sheet=sheet, token=token, revision=revision, suggested_name=suggested_name, copy_only=copy_only)

    def _start(self, client, operation, kind, *, sheet=None, token=None, revision=None, suggested_name='', copy_only=False):
        import uuid
        if self._closed:
            raise OperationError('File service is closed')
        if kind not in ('open', 'save', 'save_as'):
            raise ValueError('Unknown file operation')
        for value in (client, operation):
            if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
                raise ValueError('Invalid operation identity')
        if kind != 'open' and (not isinstance(sheet, str) or not 1 <= len(sheet) <= 100):
            raise ValueError('A project is required')
        if token is not None and (not isinstance(token, str) or len(token) > 100):
            raise ValueError('Invalid connection token')
        if revision is not None and (not isinstance(revision, str) or len(revision) > 30):
            raise ValueError('Invalid workspace revision')
        if not isinstance(copy_only, bool) or (copy_only and kind != 'save_as'):
            raise ValueError('Invalid copy mode')
        if not isinstance(suggested_name, str) or len(suggested_name) > 255:
            raise ValueError('Invalid suggested name')
        provisional = 'local-' + uuid.uuid4().hex if kind in ('open', 'save_as') else token
        initial_folder = ''
        with contextlib.closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            folder = db.execute('SELECT last_folder FROM settings WHERE workspace=?', (self.workspace,)).fetchone()
            if folder:
                initial_folder = folder['last_folder']
            if kind == 'save_as' and token:
                source = db.execute('SELECT path FROM connections WHERE workspace=? AND sheet=? AND token=?',
                                    (self.workspace, sheet, token)).fetchone()
                if source:
                    initial_folder = str(Path(source['path']).parent)
            existing = db.execute('SELECT * FROM operations WHERE workspace=? AND client=? AND id=?',
                                  (self.workspace, client, operation)).fetchone()
            if existing:
                if (existing['kind'], existing['requested_sheet'], existing['revision'], existing['source_token'], bool(existing['copy_only'])) != (kind, sheet, revision, token, copy_only):
                    raise OperationError('Operation ID already belongs to another request')
                return self._public(existing)
            active = db.execute("SELECT COUNT(*) FROM operations WHERE stage IN ('choosing','ready','writing')").fetchone()[0]
            if active >= 20:
                raise OperationError('Too many unfinished file operations')
            if kind == 'save':
                binding = db.execute('SELECT * FROM connections WHERE workspace=? AND sheet=? AND token=?',
                                     (self.workspace, sheet, token)).fetchone()
                if binding is None:
                    raise LookupError('Project file connection not found')
                stage, path, previous, identity = 'ready', binding['path'], binding['fingerprint'], binding['identity']
            else:
                stage, path, previous, identity = 'choosing', None, None, None
            db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (self.workspace, client, operation, kind, sheet, sheet, provisional, token, revision,
                        stage, path, previous, identity, None, None, None, None, self.instance, copy_only, None, time.time()))
            db.execute("DELETE FROM operations WHERE rowid IN (SELECT rowid FROM operations WHERE stage IN "
                       "('cancelled','failed','conflict','released','succeeded') ORDER BY created DESC LIMIT -1 OFFSET 1000)")
        if kind != 'save':
            try:
                future = self.chooser.choose('open' if kind == 'open' else 'save', suggested_name, initial_folder)
                future.add_done_callback(lambda result: self._executor.submit(self._selected, client, operation, result))
            except DialogBusy:
                self._finish_error(client, operation, 'busy')
            except Exception:
                self._finish_error(client, operation, 'chooser_failed')
        return self.status(client, operation)

    def _finish_error(self, client, operation, code):
        with contextlib.closing(self._connect()) as db, db:
            db.execute('UPDATE operations SET stage=?,error=?,content=NULL WHERE workspace=? AND client=? AND id=? AND stage=?',
                       ('failed', code, self.workspace, client, operation, 'choosing'))

    def _selected(self, client, operation, future):
        try:
            selected = future.result()
            if selected is None:
                stage, path, previous, identity, data = 'cancelled', None, None, None, None
            else:
                path = str(canonical_path(selected))
                with contextlib.closing(self._connect()) as db:
                    row = self._get(db, client, operation)
                    kind = row['kind']
                if kind == 'open':
                    data, previous = read_file(path)
                else:
                    data, previous = None, fingerprint(path)
                identity = file_identity(path)
                stage = 'ready'
            with contextlib.closing(self._connect()) as db, db:
                changed = db.execute('UPDATE operations SET stage=?,path=?,previous=?,previous_identity=?,content=CASE WHEN kind=? THEN ? WHEN ?=? THEN content ELSE NULL END '
                                     'WHERE workspace=? AND client=? AND id=? AND stage=?',
                                     (stage, path, previous, identity, 'open', data, stage, 'ready', self.workspace, client, operation, 'choosing')).rowcount
                if changed and stage == 'ready' and path is not None:
                    db.execute('INSERT INTO settings VALUES (?,?) ON CONFLICT(workspace) DO UPDATE SET last_folder=excluded.last_folder',
                               (self.workspace, str(Path(path).parent)))
        except UnicodeError:
            self._finish_error(client, operation, 'invalid_utf8')
        except FileTooLarge:
            self._finish_error(client, operation, 'too_large')
        except PermissionError:
            self._finish_error(client, operation, 'permission_denied')
        except FileNotFoundError:
            self._finish_error(client, operation, 'not_found')
        except FileConflict:
            self._finish_error(client, operation, 'external_change')
        except Exception:
            self._finish_error(client, operation, 'selection_failed')

    def content(self, client, operation):
        with contextlib.closing(self._connect()) as db:
            row = self._get(db, client, operation)
            if row['kind'] != 'open' or row['stage'] != 'ready' or row['content'] is None:
                raise OperationError('Open content is not ready')
            return bytes(row['content'])

    def attach(self, client, operation, sheet):
        with contextlib.closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            row = self._get(db, client, operation)
            if row['stage'] not in ('ready', 'succeeded') or row['kind'] not in ('open', 'save_as'):
                raise OperationError('Selection cannot be attached')
            if row['kind'] == 'save_as' and row['stage'] != 'succeeded':
                raise OperationError('The file has not been saved')
            if row['sheet'] and row['sheet'] != sheet:
                raise OperationError('Selection belongs to another project')
            existing = db.execute('SELECT sheet FROM connections WHERE workspace=? AND token=?',
                                  (self.workspace, row['token'])).fetchone()
            if existing and existing['sheet'] == sheet:
                return row['token']
            digest = row['previous'] if row['kind'] == 'open' else row['proposed']
            identity = file_identity(row['path'])
            if identity is None or fingerprint(row['path']) != digest:
                raise FileConflict('Selected file changed before its connection was attached')
            if row['kind'] == 'open' and identity != row['previous_identity']:
                raise FileConflict('Selected file changed before its connection was attached')
            db.execute('INSERT INTO connections VALUES (?,?,?,?,?,?) ON CONFLICT(workspace,token) '
                       'DO UPDATE SET sheet=excluded.sheet,path=excluded.path,fingerprint=excluded.fingerprint,identity=excluded.identity',
                       (self.workspace, row['token'], sheet, row['path'], digest, identity))
            db.execute('UPDATE operations SET sheet=?,content=NULL,stage=? WHERE workspace=? AND client=? AND id=?',
                       (sheet, 'succeeded', self.workspace, client, operation))
            return row['token']

    def release(self, client, operation):
        with contextlib.closing(self._connect()) as db, db:
            self._get(db, client, operation)
            self.fault('release_after_read')
            db.execute('UPDATE operations SET stage=?,content=NULL WHERE workspace=? AND client=? AND id=? '
                       'AND stage IN (?,?,?,?,?)',
                       ('released', self.workspace, client, operation, 'choosing', 'ready', 'cancelled', 'failed', 'conflict'))

    def stage_snapshot(self, client, operation, data):
        if not isinstance(data, bytes) or len(data) > MAX_BYTES:
            raise FileTooLarge('Plan project files must be 64 MB or smaller')
        data.decode('utf-8')
        with contextlib.closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            row = self._get(db, client, operation)
            if row['kind'] not in ('save', 'save_as'):
                raise OperationError('Snapshot cannot be staged for this operation')
            if row['stage'] in ('cancelled', 'failed'):
                return
            if row['stage'] not in ('choosing', 'ready'):
                raise OperationError('Snapshot cannot be staged for this operation')
            if row['content'] is not None and bytes(row['content']) != data:
                raise OperationError('This operation already has a different snapshot')
            db.execute('UPDATE operations SET content=? WHERE workspace=? AND client=? AND id=?',
                       (data, self.workspace, client, operation))

    def write_staged(self, client, operation, *, authorize, revision=None):
        with contextlib.closing(self._connect()) as db:
            row = self._get(db, client, operation)
            if row['content'] is None:
                if row['stage'] == 'succeeded':
                    return self._public(row)
                raise OperationError('The captured snapshot is unavailable')
            data = bytes(row['content'])
        return self.write(client, operation, data, authorize=authorize, revision=revision)

    def write(self, client, operation, data, *, authorize, revision=None):
        if not isinstance(data, bytes) or len(data) > MAX_BYTES:
            raise FileTooLarge('Plan project files must be 64 MB or smaller')
        data.decode('utf-8')
        proposed = hashlib.sha256(data).hexdigest()
        with registry_lock(self.directory):
            with contextlib.closing(self._connect()) as db:
                row = self._get(db, client, operation)
                if row['stage'] != 'ready':
                    if row['proposed'] == proposed:
                        return self._public(row)
                    raise OperationError('Operation is not ready for this snapshot')
                if row['kind'] not in ('save', 'save_as'):
                    raise OperationError('Operation is not a save')
                if revision is not None:
                    if not isinstance(revision, str) or len(revision) > 30:
                        raise ValueError('Invalid workspace revision')
                    row = dict(row)
                    row['revision'] = revision
                # The integration supplies a context manager that keeps the workspace
                # revision lock held through the short file commit interval.
                with authorize(dict(row)) as sheet:
                    if row['kind'] == 'save_as' and row['source_token'] and isinstance(sheet, dict):
                        source = self.connection(row['sheet'], row['source_token'])
                        restricted = sheet.get('readOnly') or row['copy_only']
                        if not source and restricted:
                            raise FileConflict('Reconnect this read-only project before selecting a safe copy destination')
                        if source and same_destination(source['path'], row['path']):
                            if restricted:
                                raise FileConflict('Use Save As to select a separate file for this read-only project')
                            if row['previous'] != source['fingerprint'] or row['previous_identity'] != source['identity']:
                                raise FileConflict('The connected file changed outside Plan')
                    import uuid
                    temporary = str(Path(row['path']).parent / ('.plan-write-' + uuid.uuid4().hex + '.tmp'))
                    self.fault('before_journal')
                    with db:
                        changed = db.execute('UPDATE operations SET stage=?,proposed=?,temporary=?,commit_revision=? WHERE workspace=? AND client=? AND id=? AND stage=?',
                                             ('writing', proposed, temporary, row['revision'], self.workspace, client, operation, 'ready')).rowcount
                        if changed != 1:
                            raise OperationError('Operation was released or changed before commit')
                    self.fault('after_journal')
                    try:
                        checked_write(row['path'], data, row['previous'], previous_identity=row['previous_identity'],
                                      temporary=temporary, before_replace=lambda: self.fault('before_replace'))
                    except FileConflict:
                        with db:
                            db.execute('UPDATE operations SET stage=?,error=?,content=NULL WHERE workspace=? AND client=? AND id=?',
                                       ('conflict', 'external_change', self.workspace, client, operation))
                        return self.status(client, operation)
                    self.fault('after_replace')
                    self.fault('before_registry_ack')
                    self._ack(db, row, proposed)
            return self.status(client, operation)

    def _ack(self, db, row, proposed):
        with db:
            if row['kind'] == 'save':
                db.execute('UPDATE connections SET fingerprint=?,identity=? WHERE workspace=? AND token=? AND sheet=?',
                           (proposed, file_identity(row['path']), self.workspace, row['token'], row['sheet']))
            db.execute('UPDATE operations SET stage=?,error=NULL,content=NULL WHERE workspace=? AND client=? AND id=?',
                       ('succeeded', self.workspace, row['client'], row['id']))

    def cleanup(self):
        # A per-instance OS lock identifies a dead chooser even across processes.
        # The registry lock prevents a new instance from observing a partial cleanup.
        with registry_lock(self.directory), contextlib.closing(self._connect()) as db, db:
            rows = db.execute('SELECT DISTINCT owner FROM operations WHERE stage=?', ('choosing',)).fetchall()
            for row in rows:
                owner = row['owner']
                if owner == self.instance:
                    continue
                with lease_file(self.directory, owner) as lease:
                    try:
                        _lock_byte(lease, blocking=False)
                    except OSError:
                        continue
                    try:
                        db.execute('UPDATE operations SET stage=?,error=?,content=NULL WHERE owner=? AND stage=?',
                                   ('failed', 'chooser_interrupted', owner, 'choosing'))
                    finally:
                        _unlock_byte(lease)
            # Retain unresolved writes and active dialogs indefinitely. Terminal
            # results are kept for 30 days; provisional selections for seven.
            now = time.time()
            db.execute('DELETE FROM operations WHERE stage IN (?,?,?,?,?) AND created < ?',
                       ('cancelled', 'failed', 'conflict', 'released', 'succeeded', now - 30 * 86400))
            db.execute('DELETE FROM operations WHERE stage=? AND created < ?', ('ready', now - 7 * 86400))
            db.execute("DELETE FROM operations WHERE rowid IN (SELECT rowid FROM operations WHERE stage IN "
                       "('cancelled','failed','conflict','released','succeeded') ORDER BY created DESC LIMIT -1 OFFSET 1000)")
            referenced = {row['owner'] for row in db.execute('SELECT DISTINCT owner FROM operations')}
            for lease_path in (self.directory / 'leases').glob('*.lock'):
                try:
                    if lease_path.stem in referenced or lease_path.stat().st_mtime >= now - 30 * 86400:
                        continue
                    with lease_file(self.directory, lease_path.stem) as lease:
                        _lock_byte(lease, blocking=False)
                        _unlock_byte(lease)
                    lease_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def reconcile(self):
        with registry_lock(self.directory), contextlib.closing(self._connect()) as db:
            rows = db.execute('SELECT * FROM operations WHERE workspace=? AND stage=?',
                              (self.workspace, 'writing')).fetchall()
            for row in rows:
                try:
                    actual = fingerprint(row['path'])
                    temporary = Path(row['temporary']) if row['temporary'] else None
                    if temporary is not None and temporary.parent == Path(row['path']).parent and temporary.name.startswith('.plan-write-') and temporary.name.endswith('.tmp'):
                        with contextlib.suppress(FileNotFoundError):
                            temporary.unlink()
                    if actual == row['proposed']:
                        self._ack(db, row, row['proposed'])
                    else:
                        state = 'failed' if actual == row['previous'] else 'conflict'
                        with db:
                            db.execute('UPDATE operations SET stage=?,error=?,content=NULL WHERE workspace=? AND client=? AND id=?',
                                       (state, 'not_committed' if state == 'failed' else 'external_change',
                                        self.workspace, row['client'], row['id']))
                except (OSError, FileConflict, FileTooLarge):
                    # Preserve journal evidence until the destination is readable again.
                    continue
