import { esc, openModal } from './dom.js';

export function createCriticalUI(ctx, grid) {
  const { store } = ctx, button = document.querySelector('#critical-target');
  let dialog = null;
  store.on((kind) => { if (kind === 'sheet') dialog?.close(); });
  function open() {
    if (dialog) return;
    grid.commitEdit();
    const target = store.criticalTarget(), options = store.criticalOptions();
    const milestones = store.tasks.filter((task) => task.ms && !store.info.get(task.id).summary);
    const modal = openModal('Critical-path target', `<label class="fld"><span>Define critical activities as</span><select id="critical-method"><option value="longest">Longest Path</option><option value="float">Total Float less than or equal to</option></select></label><label class="fld" id="critical-threshold-field"><span>Total Float threshold (working days)</span><input id="critical-threshold" type="number" min="0" max="99999999" step="1" value="${options.threshold}"></label><p class="mut" id="critical-method-help"></p><label class="fld"><span>Calculate critical path to</span><select id="critical-target-select"><option value="">Project completion</option>${milestones.map((task) => `<option value="${task.id}"${task.id === target?.id ? ' selected' : ''}>${esc(task.name)} · ${store.rowNum(task.id)}</option>`).join('')}</select></label><p class="mut">Choose a milestone to show its path. Project completion considers all activities determining the latest finish. Task dates, scheduling modes and calculated slack stay unchanged when switching methods.</p>${milestones.length ? '' : '<p class="mut">Add a milestone to choose a specific finish.</p>'}<p class="set-err" role="alert" hidden></p><div class="rem-actions"><button class="primary" id="apply-critical-target">Show critical path</button></div>`, { onClose: () => { dialog = null; } });
    dialog = modal;
    const method = modal.body.querySelector('#critical-method'), threshold = modal.body.querySelector('#critical-threshold');
    method.value = options.method;
    function explain() {
      const alert = modal.body.querySelector('[role=alert]'); alert.hidden = true; alert.textContent = '';
      const longest = method.value === 'longest';
      modal.body.querySelector('#critical-threshold-field').hidden = longest;
      threshold.disabled = longest;
      modal.body.querySelector('#critical-method-help').textContent = longest
        ? 'Trace driving relationships back from the finish, including tied paths. Activities can have positive slack where calendars differ. Manual dates and gaps beyond dependency requirements stop the trace.'
        : 'Highlight unfinished activities whose total float is at or below this threshold. Float is measured in each activity’s working calendar; different calendars can leave gaps in the highlighted chain.';
    }
    method.addEventListener('change', explain); explain();
    modal.body.querySelector('#apply-critical-target').addEventListener('click', () => {
      const alert = modal.body.querySelector('[role=alert]');
      if (method.value === 'float' && (!threshold.value.trim() || !threshold.checkValidity())) { alert.textContent = 'Enter a whole number from 0 to 99999999 working days.'; alert.hidden = false; threshold.focus(); return; }
      const value = modal.body.querySelector('#critical-target-select').value;
      const error = store.setCriticalTarget(value ? Number(value) : null, { method: method.value, threshold: method.value === 'float' ? Number(threshold.value) : options.threshold });
      if (error) { alert.textContent = error; alert.hidden = false; return; }
      modal.close();
    });
  }
  button.addEventListener('click', open);
  return {
    render() {
      const target = store.criticalTarget(), name = target?.name || 'Project completion', longest = store.criticalOptions().method === 'longest';
      button.textContent = target ? `To: ${name}` : longest ? 'Longest path' : 'Critical path';
      button.title = `${store.criticalLabel()} to ${name}. Click to choose a method and target.`;
      button.setAttribute('aria-label', `Choose critical-path target. Current target: ${name}. Method: ${store.criticalLabel()}`);
      button.classList.toggle('targeted', !!target);
    },
  };
}
