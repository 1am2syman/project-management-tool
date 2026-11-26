import { cleanCalendar, calendarError, dateDay } from './calendar.js';
import { fmtDate, fmtISO } from './model.js';
import { esc, setHTML, openModal } from './dom.js';
import { diagnostics } from './diagnosticlog.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function weekLabel(workdays) {
  const sorted = [...workdays].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Every day';
  if (sorted.length > 2 && sorted.every((day, i) => !i || day === sorted[i - 1] + 1)) return `${DAYS[sorted[0]].slice(0, 3)}–${DAYS[sorted.at(-1)].slice(0, 3)}`;
  return sorted.map((day) => DAYS[day].slice(0, 3)).join(', ');
}
const holidayCount = (calendar) => `${calendar.holidays.length} holiday${calendar.holidays.length === 1 ? '' : 's'}`;
const calendarLabel = (calendar) => `${weekLabel(calendar.workdays)} · ${holidayCount(calendar)}`;
const date = (day, year = false) => `<time datetime="${fmtISO(day)}" title="${fmtISO(day)}">${fmtDate(day)}${year ? `, ${fmtISO(day).slice(0, 4)}` : ''}</time>`;
const shiftLabel = (days) => days ? `${days > 0 ? '+' : '−'}${Math.abs(days)}d` : '—';
export function createCalendarUI(ctx, grid) {
  const { store } = ctx;
  let dialog = null, pending = false;
  async function open(taskId = null, reset = false) {
    if (dialog) return;
    try { if (await grid.commitEdit() === false) return; } catch (error) { ctx.toast(error.message || String(error)); return; }
    if (dialog) return;
    const sheetId = store.wb.active, readonly = !!store.structureError(), drafts = new Map();
    let target = taskId, tab = taskId == null ? 'global' : 'tasks', useGlobal = reset;
    const title = taskId == null ? `Project calendar · ${store.sheet().name}` : `Task calendar · ${store.byId.get(taskId)?.name || 'Task'}`;
    dialog = openModal(title, '', { wide: true, onClose: () => { dialog = null; } });
    const { body } = dialog, modal = dialog.el.querySelector('[role=dialog]');
    modal.classList.add('calendar-modal');
    // Keep actions outside the scrolling content, even with many holidays or changed rows.
    const footer = document.createElement('div'); footer.className = 'calendar-footer rem-actions'; modal.appendChild(footer);
    const task = () => target == null ? null : store.byId.get(target);
    function draft() {
      const key = target ?? 'global';
      if (!drafts.has(key)) drafts.set(key, cleanCalendar(task()?.calendar || store.calendar));
      return drafts.get(key);
    }
    const tabButton = (name, key) => `<button role="tab" id="calendar-tab-${key}" aria-controls="calendar-panel" aria-selected="${tab === key}" tabindex="${tab === key ? '0' : '-1'}" class="${tab === key ? 'on' : ''}" data-calendar-tab="${key}">${name}</button>`;
    function render() {
      const list = tab === 'tasks' && target == null;
      const currentTitle = target == null ? `Project calendar · ${store.sheet().name}` : `Task calendar · ${task()?.name || 'Task'}`;
      modal.setAttribute('aria-label', currentTitle); modal.querySelector('.m-head b').textContent = currentTitle;
      setHTML(body, `<div class="tabs calendar-tabs" role="tablist" aria-label="Calendars">${tabButton('Global', 'global')}${tabButton('Task calendars', 'tasks')}</div><section id="calendar-panel" class="calendar-panel" role="tabpanel" aria-labelledby="calendar-tab-${tab}" tabindex="0">${list ? table() : editor()}</section>`);
      const label = target == null ? 'Save global calendar' : useGlobal ? 'Use global calendar' : task()?.calendar ? 'Save task calendar' : 'Create task calendar';
      let secondary = '';
      if (!list && target != null) {
        if (useGlobal) secondary = '<button class="lnk" data-calendar-keep-custom>← Back to custom calendar</button>';
        else if (task()?.calendar) secondary = `<button class="lnk" data-calendar-inherit${readonly ? ' disabled' : ''}>Use global calendar…</button>`;
      }
      setHTML(footer, `${secondary}<span class="grow"></span><button data-calendar-cancel>${list ? 'Close' : 'Cancel'}</button>${list ? '' : `<button class="primary" data-calendar-apply${readonly ? ' disabled' : ''}>${label}</button>`}`);
      if (!list) { if (!useGlobal) holidays(); preview(); }
    }
    function table() {
      const tasks = store.tasks.filter((t) => t.calendar && !store.info.get(t.id).summary);
      return `<p class="mut">These tasks use independent calendars. To add one, right-click a task or milestone and choose Task calendar…</p>${tasks.length ? `<div class="task-calendars-table"><table><thead><tr><th>Task / milestone</th><th>Working days</th><th>Holidays</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${tasks.map((t) => `<tr><td>${esc(t.name)}<span class="sub">Row ${store.rowNum(t.id)}${t.ms ? ' · Milestone' : ''}</span></td><td><span class="calendar-week-label">${weekLabel(t.calendar.workdays)}</span></td><td>${t.calendar.holidays.length ? `<details><summary>${holidayCount(t.calendar)}</summary>${t.calendar.holidays.map((h) => `<div>${date(dateDay(h.date), true)} · ${esc(h.name || 'Holiday')}</div>`).join('')}</details>` : '<span class="mut">None</span>'}</td><td><div class="calendar-row-actions"><button data-calendar-edit="${t.id}">${readonly ? 'Inspect' : 'Edit'}</button><button class="lnk" data-calendar-reset="${t.id}"${readonly ? ' disabled' : ''}>Use global</button></div></td></tr>`).join('')}</tbody></table></div>` : '<p class="calendar-empty">No task calendars configured. All tasks use the global calendar.</p>'}`;
    }
    function editor() {
      const value = useGlobal ? store.calendar : draft();
      const state = target == null ? 'Global calendar' : useGlobal ? 'Return to global' : task()?.calendar ? 'Custom calendar' : 'Using global calendar';
      const copy = target == null ? 'Applies to tasks without a custom calendar.' : useGlobal ? 'This task will follow future global changes.' : task()?.calendar ? 'Replaces the global working days and holidays for this task only.' : 'Applying creates an independent calendar for this task.';
      return `${target == null ? '' : '<button class="lnk calendar-back" data-calendar-back>← All task calendars</button>'}
      <div class="calendar-state-row"><span class="calendar-state${target != null && task()?.calendar && !useGlobal ? ' custom' : ''}">${state}</span><span class="mut" data-calendar-summary>${calendarLabel(value)}</span></div><p class="mut">${copy}</p>
      ${useGlobal ? `<div class="calendar-reset"><b>Global working days: ${weekLabel(value.workdays)}</b><span class="calendar-reset-holidays" role="region" aria-label="Global holidays" tabindex="0">${holidayCount(value)}${value.holidays.length ? ` · ${value.holidays.map((h) => `${date(dateDay(h.date), true)}${h.name ? ` ${esc(h.name)}` : ''}`).join(' · ')}` : ''}</span><span class="mut">Your custom calendar is removed only when you confirm below.</span></div>` : `
      <fieldset class="calendar-section calendar-week"><legend>Working days</legend><div class="calendar-weekdays">${DAYS.map((name, day) => `<label><input type="checkbox" value="${day}"${value.workdays.includes(day) ? ' checked' : ''}${readonly ? ' disabled' : ''}>${name.slice(0, 3)}</label>`).join('')}</div>
      <div class="calendar-presets"><span>Presets</span>${[['Mon–Fri', '1,2,3,4,5'], ['Sun–Thu', '0,1,2,3,4'], ['Every day', '0,1,2,3,4,5,6']].map(([label, week]) => `<button data-week="${week}"${readonly ? ' disabled' : ''}>${label}</button>`).join('')}</div></fieldset>
      <fieldset class="calendar-section calendar-holidays"><legend>Holidays</legend><div class="calendar-holiday-add"><label class="fld"><span>Date</span><input type="date" data-holiday-date${readonly ? ' disabled' : ''}></label><label class="fld"><span>Name (optional)</span><input data-holiday-name maxlength="100" placeholder="e.g. Office closure"${readonly ? ' disabled' : ''}></label><button data-holiday-add${readonly ? ' disabled' : ''}>Add holiday</button></div><div class="calendar-holiday-list" role="region" aria-label="Configured holidays" tabindex="0" data-holiday-list></div></fieldset>`}
      <div class="set-err" role="alert" data-calendar-error></div><div class="calendar-preview" aria-live="polite" data-calendar-preview></div>
      <p class="mut calendar-help">Durations stay the same. Starts on days off move to the next workday. ${store.auto ? 'Auto-schedule may move connected tasks.' : 'Auto-schedule is off.'} <span title="Finishes recalculate using each task’s working days. Dependency lag uses the receiving task’s calendar.">Schedule details ⓘ</span></p>`;
    }
    function readWeek() { if (!useGlobal) draft().workdays = [...body.querySelectorAll('.calendar-week input:checked')].map((input) => +input.value); }
    function preview() {
      readWeek();
      const errorBox = body.querySelector('[data-calendar-error]'), apply = footer.querySelector('[data-calendar-apply]'), area = body.querySelector('[data-calendar-preview]');
      const value = useGlobal ? store.calendar : draft(), error = store.structureError() || (useGlobal ? null : calendarError(value));
      body.querySelector('[data-calendar-summary]').textContent = calendarLabel(value);
      errorBox.textContent = error || ''; apply.disabled = !!error;
      if (error) { area.textContent = ''; return; }
      const result = store.previewCalendar(useGlobal ? null : value, target);
      if (result.error) { errorBox.textContent = result.error; area.textContent = ''; apply.disabled = true; return; }
      const endDay = (project) => Math.max(project.start, project.end - 1), finish = endDay(result.view.project), before = endDay(store.project), delta = finish - before;
      const period = (f) => f.end - 1 <= f.start ? date(f.start) : `${date(f.start)} → ${date(f.end - 1)}`;
      setHTML(area, `<div class="calendar-preview-heading"><b>${result.changes.length} row${result.changes.length === 1 ? '' : 's'} will change dates</b><span class="mut">Preview · undo available after saving</span></div><div class="calendar-finish">Project finish <b>${store.tasks.length ? `${date(before)}${delta ? ` → ${date(finish)}` : ''}` : 'No tasks'}</b>${store.tasks.length ? `<span class="calendar-delta">${delta ? `${delta > 0 ? '+' : '−'}${Math.abs(delta)} calendar day${Math.abs(delta) === 1 ? '' : 's'}` : 'Unchanged'}</span>` : ''}</div>${result.changes.length ? `<div class="calendar-changes"><table><thead><tr><th>Task</th><th>Current</th><th>With this calendar</th><th>Start shift</th></tr></thead><tbody>${result.changes.map((row) => `<tr${row.id === target ? ' class="is-target"' : ''}><td>${esc(row.name)}</td><td>${period(row.before)}</td><td>${period(row.after)}</td><td title="Calendar days">${shiftLabel(row.after.start - row.before.start)}</td></tr>`).join('')}</tbody></table></div>` : ''}`);
    }
    function holidays() {
      const value = draft(); value.holidays.sort((a, b) => a.date.localeCompare(b.date));
      setHTML(body.querySelector('[data-holiday-list]'), value.holidays.length ? value.holidays.map((h, index) => `<div class="calendar-holiday">${date(dateDay(h.date), true)}<span>${esc(h.name || 'Holiday')}</span><button class="lnk" data-holiday-remove="${index}" aria-label="Remove holiday ${h.date}"${readonly ? ' disabled' : ''}>Remove</button></div>`).join('') : '<p class="mut">No holidays added.</p>');
    }
    body.addEventListener('change', (e) => { if (e.target.closest('.calendar-week')) preview(); });
    body.addEventListener('keydown', (e) => {
      if (!e.target.matches('[role=tab]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      tab = e.key === 'Home' ? 'global' : e.key === 'End' ? 'tasks' : tab === 'global' ? 'tasks' : 'global';
      target = null; useGlobal = false; render(); body.querySelector(`[data-calendar-tab="${tab}"]`).focus();
    });
    modal.addEventListener('click', async (e) => {
      if (pending) return;
      const button = e.target.closest('button'); if (!button || button.disabled) return;
      if (button.hasAttribute('data-calendar-cancel')) { dialog.close(); return; }
      if (store.wb.active !== sheetId) { dialog.close(); return; }
      if (button.dataset.calendarTab || button.hasAttribute('data-calendar-back')) {
        tab = button.dataset.calendarTab || 'tasks'; target = null; useGlobal = false; render(); return;
      }
      if (button.dataset.calendarEdit || button.dataset.calendarReset) {
        target = +(button.dataset.calendarEdit || button.dataset.calendarReset); useGlobal = button.dataset.calendarReset != null; render(); return;
      }
      const errorBox = body.querySelector('[data-calendar-error]');
      if (button.hasAttribute('data-calendar-inherit')) { readWeek(); useGlobal = true; render(); }
      else if (button.hasAttribute('data-calendar-keep-custom')) {
        useGlobal = false; render();
        (body.querySelector('.calendar-week input:not(:disabled)') || body.querySelector('.calendar-panel')).focus({ preventScroll: true });
      } else if (button.dataset.week != null) {
        const week = button.dataset.week.split(',').map(Number);
        body.querySelectorAll('.calendar-week input').forEach((input) => { input.checked = week.includes(+input.value); }); preview();
      } else if (button.hasAttribute('data-holiday-add')) {
        const dateInput = body.querySelector('[data-holiday-date]'), nameInput = body.querySelector('[data-holiday-name]'), value = draft();
        if (dateDay(dateInput.value) == null) { errorBox.textContent = 'Choose a valid holiday date'; dateInput.focus(); return; }
        if (value.holidays.some((h) => h.date === dateInput.value)) { errorBox.textContent = 'That holiday date is already listed'; return; }
        value.holidays.push({ date: dateInput.value, name: nameInput.value.trim() }); dateInput.value = ''; nameInput.value = ''; holidays(); preview();
      } else if (button.dataset.holidayRemove != null) { draft().holidays.splice(+button.dataset.holidayRemove, 1); holidays(); preview(); }
      else if (button.hasAttribute('data-calendar-apply')) {
        readWeek(); const applied = useGlobal ? null : draft();
        const current = dialog; pending = true; current.setPending(true);
        try {
          const error = await store.setCalendar(applied, target);
          if (error?.cancelled) return;
          if (error) { errorBox.textContent = error; return; }
          diagnostics.record('calendar.apply', { scope: target == null ? 'global' : 'task', reset: useGlobal, workdays: applied ? applied.workdays.length : store.calendar.workdays.length, holidayCount: applied ? applied.holidays.length : store.calendar.holidays.length });
          current.setPending(false); current.close(); ctx.toast(target == null ? 'Global calendar applied' : useGlobal ? 'Task now uses the global calendar' : 'Task calendar applied');
        } catch (error) { errorBox.textContent = error.message || String(error); }
        finally { pending = false; current.setPending(false); }
      }
    });
    render();
  }
  document.querySelector('#calendarbtn').addEventListener('click', () => open());
  store.on((kind) => { if ((kind === 'sheet' || kind === 'version') && dialog) dialog.close(); });
  return { open };
}
