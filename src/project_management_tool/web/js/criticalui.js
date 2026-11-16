import { esc, openModal } from './dom.js';

export function createCriticalUI(ctx, grid) {
  const { store } = ctx, button = document.querySelector('#critical-target');
  let dialog = null;
  store.on((kind) => { if (kind === 'sheet') dialog?.close(); });
  function open() {
    if (dialog) return;
    grid.commitEdit();
    const target = store.criticalTarget();
    const milestones = store.tasks.filter((task) => task.ms && !store.info.get(task.id).summary);
    const modal = openModal('Critical-path target', `<label class="fld"><span>Calculate critical path to</span><select id="critical-target-select"><option value="">Project completion</option>${milestones.map((task) => `<option value="${task.id}"${task.id === target?.id ? ' selected' : ''}>${esc(task.name)} · ${store.rowNum(task.id)}</option>`).join('')}</select></label><p class="mut">Choose a milestone to show the tasks that control its current date. Task dates and scheduling modes stay as scheduled. Project completion considers the whole project.</p>${milestones.length ? '' : '<p class="mut">Add a milestone to choose a specific finish.</p>'}<p class="set-err" role="alert" hidden></p><div class="rem-actions"><button class="primary" id="apply-critical-target">Show critical path</button></div>`, { onClose: () => { dialog = null; } });
    dialog = modal;
    modal.body.querySelector('#apply-critical-target').addEventListener('click', () => {
      const value = modal.body.querySelector('select').value;
      const error = store.setCriticalTarget(value ? Number(value) : null);
      if (error) { const alert = modal.body.querySelector('[role=alert]'); alert.textContent = error; alert.hidden = false; return; }
      modal.close();
    });
  }
  button.addEventListener('click', open);
  return {
    render() {
      const target = store.criticalTarget(), name = target?.name || 'Project completion';
      button.textContent = target ? `To: ${name}` : 'Critical path';
      button.title = `Critical path to ${name}. Click to choose a target.`;
      button.setAttribute('aria-label', `Choose critical-path target. Current target: ${name}`);
      button.classList.toggle('targeted', !!target);
    },
  };
}
