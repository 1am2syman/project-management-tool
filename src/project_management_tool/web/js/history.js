import { esc, openModal, setHTML } from './dom.js';
import { fmtDate } from './model.js';

export function createHistory() {
  document.querySelector('#historybtn').addEventListener('click', () => {
    let closed = false, cursor = null;
    const dialog = openModal('App history', `
      <p class="help">Saved versions include all projects, settings and undo/redo state. Viewing a version keeps your current work unchanged.</p>
      <div class="history-layout"><div><div class="history-list" data-list></div><button data-more>Load older versions</button></div>
      <section class="history-preview" data-preview><p class="mut">Select a saved version to inspect its projects.</p></section></div>
      <p class="set-err" role="alert" data-error></p>`, { wide: true, onClose: () => { closed = true; } });
    const body = dialog.body, list = body.querySelector('[data-list]'), more = body.querySelector('[data-more]');
    const error = body.querySelector('[data-error]'), preview = body.querySelector('[data-preview]');
    async function get(path) {
      const response = await fetch(new URL(path, document.baseURI), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not read history');
      return result;
    }
    async function load() {
      more.disabled = true; error.textContent = '';
      try {
        const result = await get(`api/history${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
        if (closed) return;
        const chunk = document.createElement('div');
        setHTML(chunk, result.entries.map((entry) => `<button class="history-entry" data-version="${esc(entry.revision)}"><b>${esc(entry.summary)}</b><span>${esc(new Date(entry.at).toLocaleString())} · v${esc(entry.revision)}</span></button>`).join(''));
        list.append(...chunk.children);
        cursor = result.entries.at(-1)?.revision || cursor;
        more.hidden = !result.more;
        if (!list.children.length) list.textContent = 'No saved versions yet.';
      } catch (e) { if (!closed) error.textContent = e.message; }
      finally { more.disabled = false; }
    }
    list.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-version]'); if (!button) return;
      const revision = button.dataset.version;
      list.querySelectorAll('button').forEach((entry) => entry.classList.toggle('on', entry === button));
      preview.textContent = 'Loading version…'; error.textContent = '';
      try {
        const result = await get(`api/history/${encodeURIComponent(revision)}`);
        if (closed || !button.classList.contains('on')) return;
        const state = result.state;
        setHTML(preview, `<h3>Version ${esc(revision)}</h3><p class="mut">${state.workbook.sheets.length} projects · Auto-schedule ${state.preferences?.auto === false ? 'off' : 'on'}</p>` + state.workbook.sheets.map((sheet) => `
          <details open><summary>${esc(sheet.name)} · ${sheet.data.tasks.length} rows · ${sheet.data.links.length} relationships</summary>
          <table><thead><tr><th>Task</th><th>Start</th><th>Days</th><th>Done</th></tr></thead><tbody>${sheet.data.tasks.map((task) => `<tr><td>${esc(task.name)}</td><td>${Number.isFinite(task.start) ? esc(fmtDate(task.start)) : ''}</td><td>${esc(task.dur ?? '')}</td><td>${esc(task.progress ?? 0)}%</td></tr>`).join('')}</tbody></table></details>`).join(''));
      } catch (e) { if (!closed) error.textContent = e.message; }
    });
    more.addEventListener('click', () => void load());
    void load();
  });
}
