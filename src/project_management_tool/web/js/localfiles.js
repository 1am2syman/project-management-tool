import { diagnostics } from './diagnosticlog.js';

// A bootstrap header forces a CORS preflight for foreign origins; no credentials
// or paths are placed in URLs. A page refresh keeps its client and operation IDs.
export async function openLocalFiles(browser = window) {
  const root = new URL('api/', browser.document.baseURI);
  async function bootstrap() {
    let response;
    try {
      response = await browser.fetch(new URL('file-access', root), {
        headers: { 'X-Plan-Bootstrap': '1' }, cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error('Could not contact the local file service. Check the Plan server and try again.');
    }
    if (response.status === 404 || response.status === 405) return null;
    if (!response.ok) throw new Error('Could not initialize local file access.');
    const capability = await response.json();
    if (capability.version !== 1 || typeof capability.available !== 'boolean') throw new Error('Unsupported local file access protocol.');
    if (capability.status === 'failed') throw new Error('The local file service could not start. Check the Plan server and try again.');
    if (!capability.available) return null;
    if (typeof capability.session !== 'string') throw new Error('Local file authorization is incomplete.');
    return capability.session;
  }
  let session = await bootstrap();
  if (!session) return null;
  let client = browser.sessionStorage.getItem('plan-file-client');
  if (!client) { client = browser.crypto.randomUUID(); browser.sessionStorage.setItem('plan-file-client', client); }
  async function request(path, options = {}, safeRetry = false) {
    const perform = () => browser.fetch(new URL(path, root), { ...options, cache: 'no-store', headers: { 'X-Plan-Session': session, 'X-Plan-Client': client, ...options.headers } });
    let result = await perform();
    if (result.status === 403) {
      session = await bootstrap();
      if (!session) throw new Error('Local file access is no longer available.');
      // A rejected mutation is never replayed automatically. Its caller checks
      // the existing operation ID before deciding how to recover.
      if (!options.method || options.method === 'GET' || safeRetry) result = await perform();
      else throw new Error('Local file session changed. Recheck the previous operation.');
    }
    if (!result.ok) {
      let body; try { body = await result.json(); } catch { /* generic message below */ }
      const error = new Error(body?.error || 'Local file operation failed.');
      error.status = result.status;
      error.reason = body?.reason;
      error.code = body?.code;
      throw error;
    }
    return result;
  }
  const json = async (path, options) => (await request(path, options)).json();
  const post = (path, body) => json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    newId: () => browser.crypto.randomUUID(),
    async start(body) {
      browser.sessionStorage.setItem('plan-file-pending', JSON.stringify({ id: body.id, kind: body.kind, phase: 'starting', sheet: body.sheet || null, copyOnly: !!body.copyOnly, start: body }));
      try { return await post('file-operations', body); }
      catch (error) {
        // A lost response may have started the chooser. Query the same ID first.
        try { return await this.status(body.id); }
        catch (statusError) {
          if (statusError.status === 404) return post('file-operations', body);
          throw error;
        }
      }
    },
    resumeStart: body => post('file-operations', body),
    connected: async (sheet, token) => {
      const response = await request('file-connections/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheet, token }) }, true);
      return (await response.json()).connected === true;
    },
    status: id => json(`file-operations/${encodeURIComponent(id)}`),
    content: async id => (await request(`file-operations/${encodeURIComponent(id)}/content`)).text(),
    async stage(id, contents) {
      try { return await json(`file-operations/${encodeURIComponent(id)}/snapshot`, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: contents }); }
      catch (error) { try { const status = await this.status(id); if (status.hasSnapshot) return status; } catch { /* retain pending operation */ } throw error; }
    },
    async write(id, revision) {
      this.remember({ id, phase: 'writing' });
      try { return await json(`file-operations/${encodeURIComponent(id)}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Plan-Revision': revision }, body: '{}' }); }
      catch (error) {
        // Read the recorded outcome instead of guessing from the error. A ready row has
        // no journal entry, so no bytes were written.
        let status = null;
        try { status = await this.status(id); } catch { /* outcome remains uncertain */ }
        const actionable = ['file_in_use', 'permission_denied'].includes(error.code);
        if (status && !['ready', 'writing'].includes(status.stage)) {
          return status.stage === 'failed' && actionable ? { ...status, error: error.code } : status;
        }
        if (actionable) {
          if (status?.stage === 'ready') throw error;
          throw new Error(`${error.message} Could not confirm the project save. Check the selected file before trying again.`);
        }
        // A 409 with the selection still ready is a definitive refusal. Rethrow it with its reason: the caller
        // retries the same selection on a newer revision, or releases it.
        if (status?.stage === 'ready' && error.status === 409) throw error;
        if (status?.stage === 'ready') throw new Error('The project was not saved. Try again.');
        throw new Error('Could not confirm the project save. Check the selected file before trying again.');
      }
    },
    attach: (id, sheet, revision) => post(`file-operations/${encodeURIComponent(id)}/attach`, { sheet, revision }),
    release: id => post(`file-operations/${encodeURIComponent(id)}/release`, {}),
    pending() { try { return JSON.parse(browser.sessionStorage.getItem('plan-file-pending') || 'null'); } catch { return null; } },
    remember(fields) { browser.sessionStorage.setItem('plan-file-pending', JSON.stringify({ ...this.pending(), ...fields })); },
    clear() { browser.sessionStorage.removeItem('plan-file-pending'); },
    async wait(id) {
      let delay = 150;
      for (;;) {
        const value = await this.status(id);
        diagnostics.record('file.local.stage', { stage: value.stage, kind: value.kind });
        if (!['choosing', 'reading', 'selected'].includes(value.stage)) return value; // writing is reported, never polled
        await new Promise(resolve => browser.setTimeout(resolve, delay));
        delay = Math.min(1500, Math.round(delay * 1.5));
      }
    },
  };
}
