import { esc, openModal, setHTML } from './dom.js';
import { fmtDate } from './model.js';
import { diagnostics } from './diagnosticlog.js';

function sheetSummary(sheet) {
  const parts = [`${sheet.data.tasks.length} rows`, `${sheet.data.links.length} relationships`];
  if (sheet.versions?.length) parts.push(`${sheet.versions.length} saved version${sheet.versions.length === 1 ? '' : 's'}`);
  if (sheet.data.baselined) parts.push('baselined');
  if (sheet.data.log?.length) parts.push(`${sheet.data.log.length} delay log`);
  const cal = sheet.data.calendar;
  if (cal && ((cal.workdays?.length ?? 7) !== 7 || (cal.holidays?.length ?? 0) > 0)) {
    parts.push(`${cal.workdays.length}d week${cal.holidays?.length ? ` · ${cal.holidays.length} hol` : ''}`);
  }
  const tc = sheet.data.tasks.filter((t) => t.calendar).length;
  if (tc) parts.push(`${tc} task cal`);
  if (sheet.criticalPath?.method === 'longest') parts.push('Longest path');
  else if (sheet.criticalPath?.threshold > 0) parts.push(`Float ≤ ${sheet.criticalPath.threshold}d`);
  return parts.join(' · ');
}

function sheetTable(sheet) {
  const tasks = sheet.data.tasks;
  const hasAgreed = tasks.some((t) => t.agr);
  const hasActuals = tasks.some((t) => t.actualStart != null || t.actualEnd != null);
  const hasNotes = tasks.some((t) => t.notes);
  const actualsOf = (t) => {
    if (t.actualStart == null && t.actualEnd == null) return '';
    if (t.ms || t.actualEnd == null) return t.actualStart != null ? fmtDate(t.actualStart) : '';
    return `${t.actualStart != null ? fmtDate(t.actualStart) : '—'} → ${fmtDate(t.actualEnd)}`;
  };
  return `<table><thead><tr><th>Task</th><th>Start</th><th>Days</th><th>Done</th>${hasAgreed ? '<th>Agreed</th>' : ''}${hasActuals ? '<th>Actuals</th>' : ''}${hasNotes ? '<th>Notes</th>' : ''}</tr></thead><tbody>${tasks.map((task) => `<tr><td>${esc(task.name)}</td><td>${Number.isFinite(task.start) ? esc(fmtDate(task.start)) : ''}</td><td>${task.ms ? '◆' : esc(task.dur ?? '')}</td><td>${esc(task.progress ?? 0)}%</td>${hasAgreed ? `<td>${task.agr && Number.isFinite(task.agr.f) ? esc(fmtDate(task.agr.f)) : ''}</td>` : ''}${hasActuals ? `<td>${esc(actualsOf(task))}</td>` : ''}${hasNotes ? `<td>${esc(String(task.notes || '').slice(0, 80))}</td>` : ''}</tr>`).join('')}</tbody></table>`;
}

export function createHistory() {
  document.querySelector('#historybtn').addEventListener('click', () => {
    let closed = false, cursor = null;
    diagnostics.record('history.open');
    const dialog = openModal('App history', `
      <p class="help">Saved versions include all projects, calendars, delay accounting, settings and undo/redo state. Viewing a version keeps your current work unchanged.</p>
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
        const result = await diagnostics.trace('history.list', () => get(`api/history${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`));
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
        const result = await diagnostics.trace('history.version', () => get(`api/history/${encodeURIComponent(revision)}`));
        if (closed || !button.classList.contains('on')) return;
        const state = result.state, prefs = state.preferences || {};
        const critMode = prefs.critical === false ? 'off' : prefs.criticalOnly ? 'only' : 'show';
        const meta = [`${state.workbook.sheets.length} project${state.workbook.sheets.length === 1 ? '' : 's'}`, `Auto-schedule ${prefs.auto === false ? 'off' : 'on'}`, `Critical ${critMode}`];
        if (state.templates?.length) meta.push(`${state.templates.length} template${state.templates.length === 1 ? '' : 's'}`);
        setHTML(preview, `<h3>Version ${esc(revision)}</h3><p class="mut">${esc(meta.join(' · '))}</p>` + state.workbook.sheets.map((sheet) => `
          <details open><summary>${esc(sheet.name)} · ${esc(sheetSummary(sheet))}</summary>${sheetTable(sheet)}</details>`).join(''));
      } catch (e) { if (!closed) error.textContent = e.message; }
    });
    more.addEventListener('click', () => void load());
    void load();
  });
}
