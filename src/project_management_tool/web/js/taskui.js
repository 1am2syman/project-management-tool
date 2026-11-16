// Task-area context menu and pointer row moves. Changes commit through Store transactions.
import { esc, setHTML } from './dom.js';

export function createTaskUI(ctx, grid) {
  const { store, ui } = ctx;
  const gx = document.querySelector('#gx');
  const menu = document.createElement('div');
  menu.className = 'task-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Task actions'); menu.tabIndex = -1; menu.hidden = true;
  const marker = document.createElement('div'); marker.className = 'row-drop'; marker.hidden = true;
  const announcement = document.createElement('div'); announcement.className = 'sr-only'; announcement.setAttribute('role', 'status');
  document.body.append(menu, marker, announcement);
  let menuId = null, drag = null, frame = 0, suppressClick = false;
  const editable = () => !store.structureError();
  function closeMenu(focus = false) { menu.hidden = true; if (focus) gx.focus({ preventScroll: true }); }
  function openMenu(id, x, y) {
    if (drag) return;
    grid.commitEdit();
    if (id != null) ctx.select(id, 'name');
    menuId = id;
    const item = (label, action, error, shortcut = '') => `<button role="menuitem" data-task-action="${action}"${error ? ` disabled title="${esc(error)}"` : ''}><span>${label}</span><kbd>${shortcut}</kbd></button>`;
    const reason = store.structureError();
    let html = `<div class="task-menu-title">${id == null ? 'Task area' : esc(store.byId.get(id)?.name || 'Task')}</div>`;
    if (id == null) {
      html += item('Append task', 'task-after', reason, 'Ctrl/⌘+Enter') + item('Append milestone', 'ms-after', reason, 'Ctrl/⌘+Shift+Enter');
    } else {
      const summary = store.info.get(id).summary;
      html += item('Insert task above', 'task-before', reason) + item(summary ? 'Insert task below cascade' : 'Insert task below', 'task-after', reason, 'Ctrl/⌘+Enter');
      html += item('Insert milestone above', 'ms-before', reason) + item(summary ? 'Insert milestone below cascade' : 'Insert milestone below', 'ms-after', reason, 'Ctrl/⌘+Shift+Enter');
      const childError = reason || store.canAddChild(id);
      html += `<div role="separator"></div>${item('Add child task', 'task-child', childError)}${item('Add child milestone', 'ms-child', childError)}`;
      html += `<div role="separator"></div>${item(store.byId.get(id).ms ? 'Convert to task (1 working day)' : 'Convert to milestone', 'convert', reason || (summary ? 'A cascade with children cannot be converted to a milestone' : null))}`;
      if (store.byId.get(id).ms && !summary) {
        const selected = store.criticalTarget()?.id === id;
        html += `<div role="separator"></div>${item(selected ? 'Use project completion for critical path' : 'Use as critical-path target', selected ? 'critical-project' : 'critical-milestone', store.stale ? 'Reload this project before changing the view' : null)}`;
      }
      const modeError = reason || (summary ? 'Summary dates come from their children' : null);
      html += `<div role="separator"></div>${item('Auto-calculate from connections', 'schedule-auto', modeError)}${item('Use manual dates', 'schedule-manual', modeError)}${item('Use date anchor', 'schedule-anchor', modeError)}`;
      const indentError = (dir) => { const plan = store.indentPlan(id, dir); return plan.error || store.movePlan(id, plan.targetId, plan.position).error; };
      html += `<div role="separator"></div>${item('Indent cascade', 'indent', indentError(1), 'Alt+→')}${item('Outdent cascade', 'outdent', indentError(-1), 'Alt+←')}`;
    }
    setHTML(menu, html); menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    (menu.querySelector('button:not(:disabled)') || menu).focus({ preventScroll: true });
  }
  gx.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input,textarea,[contenteditable=true]')) return;
    const row = e.target.closest('.r[data-id]');
    if (!row && !e.target.closest('#gbody')) return;
    e.preventDefault(); openMenu(row ? +row.dataset.id : null, e.clientX, e.clientY);
  });
  document.querySelector('#gb').addEventListener('contextmenu', (e) => {
    const bar = e.target.closest('.bar[data-id]'); if (!bar) return;
    e.preventDefault(); openMenu(+bar.dataset.id, e.clientX, e.clientY);
  });
  document.querySelector('#gb').addEventListener('scroll', () => closeMenu(), { passive: true });
  menu.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-task-action]'); if (!button || button.disabled) return;
    const action = button.dataset.taskAction; closeMenu(true);
    if (action.startsWith('critical-')) {
      const error = store.setCriticalTarget(action === 'critical-project' ? null : menuId); if (error) ctx.toast(error);
    } else if (action.startsWith('schedule-')) {
      const error = store.setScheduling(menuId, action.slice(9)); if (error) ctx.toast(error);
      else { ctx.select(menuId, 'name', true); if (action === 'schedule-auto' && !store.auto) ctx.toast('Calculated from connections. Enable Auto-schedule for live updates.'); }
    } else if (action === 'convert') {
      const error = store.setTaskKind(menuId, !store.byId.get(menuId).ms); if (error) ctx.toast(error);
      else ctx.select(menuId, 'name', true);
    } else if (action === 'indent' || action === 'outdent') {
      const error = store.indent(menuId, action === 'indent' ? 1 : -1); if (error) ctx.toast(error);
      else ctx.select(menuId, 'name', true);
    } else {
      const [kind, position] = action.split('-'); ctx.insertTask(kind === 'ms', position, menuId);
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
  gx.addEventListener('scroll', () => closeMenu(), { passive: true });
  window.addEventListener('resize', () => { closeMenu(); cancelDrag(); });
  document.addEventListener('keydown', (e) => {
    if (!menu.hidden) {
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const i = buttons.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        let next = (i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = buttons.length - 1;
        buttons[next]?.focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(true); if (e.key === 'Escape') e.preventDefault(); e.stopImmediatePropagation(); }
      else if (e.key !== 'Enter' && e.key !== ' ') e.stopImmediatePropagation();
      return;
    }
    if (drag) {
      if (e.key === 'Escape') { e.preventDefault(); cancelDrag(); }
      e.stopImmediatePropagation(); return;
    }
    if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && gx.contains(e.target) && !e.target.closest('input,textarea')) {
      e.preventDefault(); e.stopImmediatePropagation();
      const row = gx.querySelector(`.r[data-id="${ui.selId}"]`), rect = (row || gx).getBoundingClientRect();
      openMenu(row ? ui.selId : null, rect.left + 50, rect.top + 20);
    }
  }, true);

  function clearDrag() {
    if (frame) cancelAnimationFrame(frame); frame = 0;
    const previous = drag; drag = null; marker.hidden = true;
    document.body.classList.remove('reordering-rows');
    for (const row of gx.querySelectorAll('.row-moving')) row.classList.remove('row-moving');
    if (previous && gx.hasPointerCapture(previous.pointerId)) gx.releasePointerCapture(previous.pointerId);
    return previous;
  }
  function cancelDrag() { if (drag) { clearDrag(); suppressClick = false; announcement.textContent = 'Row move cancelled'; } }
  function preview() {
    if (!drag?.active) return;
    const viewport = gx.getBoundingClientRect();
    const el = document.elementFromPoint(drag.x, drag.y), row = el?.closest('#gbody .r[data-id]');
    drag.target = null;
    if (!row || drag.x < viewport.left || drag.x > viewport.right || drag.y < viewport.top || drag.y > viewport.bottom) { marker.hidden = true; return; }
    const targetId = +row.dataset.id, rect = row.getBoundingClientRect(), ratio = (drag.y - rect.top) / rect.height;
    let position = 'child';
    if (ratio < 0.25) position = 'before';
    else if (ratio > 0.75) position = 'after';
    const plan = store.movePlan(drag.id, targetId, position);
    if (!plan.error) drag.target = { targetId, position };
    let line = position === 'before' ? rect.top : rect.bottom;
    if (position === 'after') {
      const target = store.info.get(targetId);
      for (const visible of store.rows) {
        const index = store.info.get(visible.id).i;
        if (index > target.i && index <= target.sub) line = gx.querySelector(`.r[data-id="${visible.id}"]`)?.getBoundingClientRect().bottom || line;
      }
    }
    const moveLabels = { child: 'Nest under', before: 'Move before', after: 'Move after cascade' };
    const label = plan.error || `${moveLabels[position]}: ${store.byId.get(targetId).name}`;
    marker.textContent = label; marker.dataset.position = position; marker.classList.toggle('invalid', !!plan.error);
    marker.style.left = `${viewport.left + 44 + (position === 'child' ? 16 : 0)}px`;
    marker.style.width = `${Math.max(140, Math.min(viewport.width - 56, 460))}px`;
    marker.style.top = `${Math.max(viewport.top + 65, Math.min(line, viewport.bottom - 4))}px`;
    marker.hidden = false;
  }
  function scrollFrame() {
    frame = 0; if (!drag?.active) return;
    const rect = gx.getBoundingClientRect(), head = gx.querySelector('#ghead').getBoundingClientRect().bottom;
    if (drag.x >= rect.left && drag.x <= rect.right) {
      let delta = 0;
      if (drag.y < head + 24) delta = -10;
      else if (drag.y > rect.bottom - 28) delta = 10;
      if (delta) { gx.scrollTop += delta; preview(); }
    }
    frame = requestAnimationFrame(scrollFrame);
  }
  gx.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.row-handle'); if (!handle || e.button !== 0 || drag) return;
    e.preventDefault();
    if (!editable()) { ctx.toast(store.structureError()); return; }
    grid.commitEdit(); closeMenu();
    const id = +handle.closest('.r[data-id]').dataset.id;
    ctx.select(id, 'name'); gx.focus({ preventScroll: true });
    drag = { id, pointerId: e.pointerId, sheetId: store.wb.active, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, target: null };
    gx.setPointerCapture(e.pointerId);
  });
  gx.addEventListener('pointermove', (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < 5) return;
    if (!drag.active) {
      drag.active = true; suppressClick = true; document.body.classList.add('reordering-rows');
      const f = store.info.get(drag.id);
      for (const row of gx.querySelectorAll('.r[data-id]')) { const i = store.info.get(+row.dataset.id).i; row.classList.toggle('row-moving', i >= f.i && i <= f.sub); }
      frame = requestAnimationFrame(scrollFrame);
    }
    preview();
  });
  gx.addEventListener('pointerup', (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.active) preview();
    const previous = clearDrag();
    if (previous.active && previous.target && previous.sheetId === store.wb.active) {
      const error = store.moveTask(previous.id, previous.target.targetId, previous.target.position);
      if (error) ctx.toast(error);
      else { ctx.select(previous.id, 'name', true); announcement.textContent = 'Cascade moved'; }
    }
    setTimeout(() => { suppressClick = false; }, 0);
  });
  gx.addEventListener('pointercancel', cancelDrag);
  gx.addEventListener('lostpointercapture', () => { if (drag) cancelDrag(); });
  gx.addEventListener('click', (e) => { if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  store.on((kind) => { if (kind === 'sheet') { closeMenu(); cancelDrag(); } });
  return { isDragging: () => !!drag, cancelDrag, closeMenu };
}
