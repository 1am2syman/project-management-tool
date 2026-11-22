import { appState } from './appstate.js';
import { fmtISO } from './model.js';
import { esc, openModal, setHTML } from './dom.js';
import { diagnostics } from './diagnosticlog.js';

export function slackLabel(info, free = false) {
  const value = free ? info.freeFloat : info.float;
  return value == null ? (info.summary ? 'Not calculated' : 'Outside selected target') : `${value} working day${Math.abs(value) === 1 ? '' : 's'}`;
}

export function createSlackUI(ctx, grid) {
  const { store, ui } = ctx, button = document.querySelector('#slackbtn');
  const saved = appState.getItem('pm-slack-mode');
  ui.slackMode = ['off', 'selected', 'all'].includes(saved) ? saved : 'selected';
  let dialog = null;
  const close = () => dialog?.close();
  store.on((kind) => { if (kind === 'sheet') close(); });
  function limitText(ids, fallback) {
    if (!ids.length) return esc(fallback);
    return ids.map((id) => {
      const link = store.links.find((l) => l.id === id), task = store.byId.get(link?.to);
      return `${esc(task?.name || 'Successor')} (${esc(link?.type)}${link?.lag ? ` ${link.lag > 0 ? '+' : ''}${link.lag} working days` : ''})`;
    }).join(', ');
  }
  function content() {
    const task = store.byId.get(ui.selId), f = store.info.get(ui.selId), target = store.criticalTarget();
    const targetName = target?.name || 'Project completion';
    const intro = `<p class="slack-target">Total-slack target: <b>${esc(targetName)}</b></p>`;
    if (!task || !f) return intro + '<p>Select a task in the sheet or Gantt to inspect its slack.</p>';
    if (f.summary) return intro + `<h3>${esc(task.name)}</h3><p>Not calculated for summary rows. Inspect individual tasks or milestones; summary dates roll up from their children.</p>`;
    const violations = store.links.filter((l) => l.violated).length;
    const warning = violations ? `<p class="slack-warning" role="status">This schedule has ${violations} violated dependenc${violations === 1 ? 'y' : 'ies'}. Resolve conflicts before treating positive slack as a safe allowance. Manual dates and date anchors are not moved by this analysis.</p>` : '';
    const dates = (start, end) => start == null ? 'Outside selected target' : `${fmtISO(start)} → ${fmtISO(task.ms ? start : end - 1)}`;
    const totalLimit = f.float == null ? 'Outside selected target' : limitText(f.totalLimiters, targetName);
    const freeLimit = limitText(f.freeLimiters, target?.id === task.id ? targetName : 'Project completion (no immediate successors)');
    const interpretation = (value, kind) => value == null ? '' : value < 0 ? `<p class="slack-warning">${kind} is negative: the task must move ${-value} working day${value === -1 ? '' : 's'} earlier to meet this limit.</p>` : value === 0 ? `<p>No ${kind.toLowerCase()} remains.</p>` : '';
    const pathNote = store.criticalOptions().method === 'longest' && f.longestPath ? `<p class="mut">On the Longest Path to ${esc(targetName)}.${f.float > 0 ? ' Positive slack remains valid: differing working calendars can allow delay within a driving chain.' : ''}${task.progress >= 100 ? ' Completed activities are not highlighted.' : ''}</p>` : '';
    return intro + `<h3>${esc(task.name)}</h3>${pathNote}${warning}<div class="slack-metrics"><section><h4>Total slack</h4><strong>${esc(slackLabel(f))}</strong><p>Delay before the target moves, allowing downstream tasks to move within their slack.</p><dl><dt>Latest start → finish</dt><dd>${dates(f.latestStart, f.latestEnd)}</dd><dt>Limited by</dt><dd>${totalLimit}</dd></dl>${interpretation(f.float, 'Total slack')}</section><section><h4>Free slack</h4><strong>${esc(slackLabel(f, true))}</strong><p>Delay before an immediate successor’s current dates are affected. Terminal tasks use project completion; the selected milestone stays fixed.</p><dl><dt>Latest start → finish</dt><dd>${dates(f.freeStart, f.freeEnd)}</dd><dt>Limited by</dt><dd>${freeLimit}</dd></dl>${interpretation(f.freeFloat, 'Free slack')}</section></div><p class="mut">These are separate limits. Where both apply, neither may be negative; use the smaller allowance to protect both successors and the target. Slack is shared along a dependency chain and cannot be spent independently on every task. Analysis keeps task durations and dates unchanged.</p>`;
  }
  function render() {
    button.title = `Task slack · Gantt: ${ui.slackMode === 'all' ? 'all tasks' : ui.slackMode === 'selected' ? 'selected task' : 'off'}`;
    button.classList.toggle('active', ui.slackMode !== 'off');
    if (dialog) setHTML(dialog.body.querySelector('#slack-content'), content());
  }
  function open(id) {
    grid.commitEdit();
    if (id != null && id !== ui.selId) ctx.select(id, 'float');
    if (dialog) { render(); return; }
    dialog = openModal('Task slack', `<label class="fld"><span>Show slack on Gantt</span><select id="slack-mode"><option value="off">Off</option><option value="selected">Selected task</option><option value="all">All tasks</option></select></label><p class="slack-key"><span class="free-key">Thick tail: free</span><span class="total-key">Dashed tail: total</span> · The tail runs from the task’s finish to its latest finish; it is not extra duration. Only positive allowances are drawn.</p><div id="slack-content"></div>`, { wide: true, onClose: () => { dialog = null; } });
    const select = dialog.body.querySelector('#slack-mode'); select.value = ui.slackMode;
    select.addEventListener('change', () => { ui.slackMode = select.value; appState.setItem('pm-slack-mode', ui.slackMode); diagnostics.record('slack.mode', { mode: ui.slackMode }); ctx.requestRender(); });
    render();
  }
  button.addEventListener('click', () => open());
  return { open, render, close };
}
