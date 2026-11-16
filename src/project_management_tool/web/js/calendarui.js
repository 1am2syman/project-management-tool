import { cleanCalendar, calendarError, dateDay } from './calendar.js';
import { fmtISO } from './model.js';
import { esc, setHTML, openModal } from './dom.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function createCalendarUI(ctx, grid) {
  const { store } = ctx;
  let dialog = null;
  document.querySelector('#calendarbtn').addEventListener('click', () => {
    if (dialog) return;
    grid.commitEdit();
    const sheetId = store.wb.active, draft = cleanCalendar(store.calendar), readonly = !!store.structureError();
    dialog = openModal(`Project calendar · ${store.sheet().name}`, `
      <p class="mut">Task durations and relationship lag count working days. Days off are shaded on the Gantt. Applying keeps durations, moves starts on days off to the next workday, and recalculates finishes. With Auto-schedule on, successors also move as needed.</p>
      <fieldset class="calendar-week"><legend>Working weekdays</legend>${DAYS.map((name, day) => `<label><input type="checkbox" value="${day}"${draft.workdays.includes(day) ? ' checked' : ''}${readonly ? ' disabled' : ''}>${name.slice(0, 3)}</label>`).join('')}</fieldset>
      <div class="calendar-presets"><button data-week="1,2,3,4,5"${readonly ? ' disabled' : ''}>Mon–Fri</button><button data-week="0,1,2,3,4"${readonly ? ' disabled' : ''}>Sun–Thu</button><button data-week="0,1,2,3,4,5,6"${readonly ? ' disabled' : ''}>Every day</button></div>
      <section class="calendar-holidays"><b>Custom holidays</b><div class="calendar-holiday-add"><label class="fld"><span>Date</span><input type="date" data-holiday-date${readonly ? ' disabled' : ''}></label><label class="fld"><span>Name (optional)</span><input data-holiday-name maxlength="100" placeholder="e.g. Office closure"${readonly ? ' disabled' : ''}></label><button data-holiday-add${readonly ? ' disabled' : ''}>Add holiday</button></div><div data-holiday-list></div></section>
      <div class="set-err" role="alert" data-calendar-error></div><div class="calendar-preview" aria-live="polite" data-calendar-preview></div>
      <div class="rem-actions"><button class="primary" data-calendar-apply${readonly ? ' disabled' : ''}>Apply calendar</button><button data-calendar-cancel>Cancel</button></div>`, { wide: true, onClose: () => { dialog = null; } });
    const { body } = dialog;
    const errorBox = body.querySelector('[data-calendar-error]');
    function readWeek() { draft.workdays = [...body.querySelectorAll('.calendar-week input:checked')].map((input) => +input.value); }
    function preview() {
      readWeek();
      const error = store.structureError() || calendarError(draft); errorBox.textContent = error || '';
      const area = body.querySelector('[data-calendar-preview]'), apply = body.querySelector('[data-calendar-apply]');
      apply.disabled = !!error;
      if (error) { area.textContent = ''; return; }
      const result = store.previewCalendar(draft);
      if (result.error) { errorBox.textContent = result.error; apply.disabled = true; return; }
      const finish = result.view.project.end;
      const period = (f) => `${fmtISO(f.start)} → ${fmtISO(Math.max(f.start, f.end - 1))}`;
      setHTML(area, `<b>${result.changes.length} row${result.changes.length === 1 ? '' : 's'} will change dates</b><span class="sub">Project finish: ${store.tasks.length ? fmtISO(Math.max(result.view.project.start, finish - 1)) : 'No tasks'}. You can undo the calendar change.</span>${result.changes.length ? `<div class="calendar-changes"><table><thead><tr><th>Task</th><th>Current</th><th>With this calendar</th></tr></thead><tbody>${result.changes.slice(0, 8).map((row) => `<tr><td>${esc(row.name)}</td><td>${period(row.before)}</td><td>${period(row.after)}</td></tr>`).join('')}</tbody></table></div>${result.changes.length > 8 ? '<span class="sub">Showing the first 8 changed rows.</span>' : ''}` : ''}`);
    }
    function holidays() {
      draft.holidays.sort((a, b) => a.date.localeCompare(b.date));
      setHTML(body.querySelector('[data-holiday-list]'), draft.holidays.length ? draft.holidays.map((h, index) => `<div class="calendar-holiday"><time>${h.date}</time><span>${esc(h.name || 'Holiday')}</span><button data-holiday-remove="${index}" aria-label="Remove holiday ${h.date}"${readonly ? ' disabled' : ''}>Remove</button></div>`).join('') : '<p class="mut">No custom holidays.</p>');
    }
    body.addEventListener('change', (e) => { if (e.target.closest('.calendar-week')) preview(); });
    body.addEventListener('click', (e) => {
      const button = e.target.closest('button'); if (!button || button.disabled) return;
      if (button.hasAttribute('data-calendar-cancel')) { dialog.close(); return; }
      if (store.wb.active !== sheetId) { dialog.close(); return; }
      if (button.dataset.week != null) {
        const week = button.dataset.week.split(',').map(Number);
        body.querySelectorAll('.calendar-week input').forEach((input) => { input.checked = week.includes(+input.value); }); preview();
      } else if (button.hasAttribute('data-holiday-add')) {
        const dateInput = body.querySelector('[data-holiday-date]'), nameInput = body.querySelector('[data-holiday-name]');
        if (dateDay(dateInput.value) == null) { errorBox.textContent = 'Choose a valid holiday date'; dateInput.focus(); return; }
        if (draft.holidays.some((h) => h.date === dateInput.value)) { errorBox.textContent = 'That holiday date is already listed'; return; }
        draft.holidays.push({ date: dateInput.value, name: nameInput.value.trim() }); dateInput.value = ''; nameInput.value = ''; holidays(); preview();
      } else if (button.dataset.holidayRemove != null) { draft.holidays.splice(+button.dataset.holidayRemove, 1); holidays(); preview(); }
      else if (button.hasAttribute('data-calendar-apply')) {
        readWeek(); const error = store.setCalendar(draft);
        if (error) { errorBox.textContent = error; return; }
        dialog.close(); ctx.toast('Project calendar applied');
      }
    });
    holidays(); preview();
  });
  store.on((kind) => { if (kind === 'sheet' && dialog) dialog.close(); });
}
