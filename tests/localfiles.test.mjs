import test from 'node:test';
import assert from 'node:assert/strict';
import { openLocalFiles } from '../src/project_management_tool/web/js/localfiles.js';

const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function fakeBrowser(fetch) {
  const values = new Map();
  return { document: { baseURI: 'http://127.0.0.1:5173/' }, fetch, crypto: { randomUUID: () => 'client-id' },
    sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    setTimeout };
}

test('server session rotation reboots authorization for status without replaying mutation', async () => {
  let session = 'first', starts = 0, bootstraps = 0;
  const browser = fakeBrowser(async (url, options) => {
    if (url.pathname.endsWith('/file-access')) { bootstraps++; return response(200, { version: 1, available: true, session }); }
    if (options.headers['X-Plan-Session'] !== session) return response(403, { error: 'expired' });
    if (options.method === 'POST') { starts++; return response(200, { id: 'op', stage: 'choosing' }); }
    return response(200, { id: 'op', stage: 'ready' });
  });
  const service = await openLocalFiles(browser);
  session = 'second';
  assert.equal((await service.status('op')).stage, 'ready');
  assert.equal(bootstraps, 2);
  assert.equal(starts, 0);
});

test('native initialization failure does not select browser fallback', async () => {
  const browser = fakeBrowser(async () => response(200, { version: 1, available: false, status: 'failed' }));
  await assert.rejects(openLocalFiles(browser), /could not start/);
});

test('start absent at server retries same operation identity after transport failure', async () => {
  let attempts = 0; const bodies = [];
  const browser = fakeBrowser(async (url, options) => {
    if (url.pathname.endsWith('/file-access')) return response(200, { version: 1, available: true, session: 'session' });
    if (options.method === 'POST') {
      bodies.push(JSON.parse(options.body));
      if (++attempts === 1) throw new Error('network disconnected');
      return response(200, { id: 'op', stage: 'choosing' });
    }
    return response(404, { error: 'Unknown operation' });
  });
  const service = await openLocalFiles(browser);
  assert.equal((await service.start({ id: 'op', kind: 'open' })).stage, 'choosing');
  assert.deepEqual(bodies, [{ id: 'op', kind: 'open' }, { id: 'op', kind: 'open' }]);
});

test('locked-file guidance survives reconciliation without clearing an uncertain write', async () => {
  for (const stage of ['ready', 'writing', 'failed', 'succeeded']) {
    const browser = fakeBrowser(async url => {
      if (url.pathname.endsWith('/file-access')) return response(200, { version: 1, available: true, session: 'session' });
      if (url.pathname.endsWith('/commit')) return response(503, { error: 'The file is open in another program. Close it and try again.', code: 'file_in_use' });
      return response(200, { id: 'op', stage, error: stage === 'failed' ? 'not_committed' : undefined });
    });
    const service = await openLocalFiles(browser);
    if (stage === 'failed') assert.equal((await service.write('op', '1')).error, 'file_in_use');
    else if (stage === 'succeeded') assert.equal((await service.write('op', '1')).stage, 'succeeded');
    else {
      await assert.rejects(service.write('op', '1'), error => {
        assert.match(error.message, /Close it and try again/);
        assert.equal(error.message.includes('Could not confirm'), stage === 'writing');
        return true;
      });
      assert.equal(service.pending().phase, 'writing');
    }
  }
});
