import { LINK_TYPES } from './model.js';
import { esc, openModal } from './dom.js';

const TYPE_NAME = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish', SF: 'Start → Finish' };
const describe = (l) => `${l.type}${l.lag ? `${l.lag > 0 ? '+' : ''}${l.lag}d` : ''}`;
const signature = (links) => JSON.stringify(links.map(({ id, from, to, type, lag }) => ({ id, from, to, type, lag })));

// Both a connector click and a repeated drag edit the same relationship, with no writes until confirmation.
export function createRelationshipEditor(ctx) {
  const { store, ui } = ctx;
  const reviewButton = document.querySelector('#reviewlinks');
  let pending = false;
  let dialog = null, editorSheet = null, reviewedSheet = null;

  function close() { if (pending) return; const active = dialog; dialog = null; active?.close(); }

  function review() {
    const pair = store.linkConflicts()[0];
    if (pair && !store.readOnly) open(pair[0].id);
  }

  function open(id, proposedType) {
    if (pending) return;
    const first = store.links.find((l) => l.id === id); if (!first) return;
    close();
    ctx.selectLink(id);
    const sheetId = store.sheet().id, pair = store.linksBetween(first.from, first.to);
    const before = signature(pair), conflict = pair.length > 1, readOnly = store.readOnly;
    const from = store.byId.get(first.from), to = store.byId.get(first.to);
    let chosen = first;
    editorSheet = sheetId;
    const current = openModal(conflict ? 'Review existing relationships' : 'Change relationship', `
      <form class="relationship-form">
        <p class="help"><b>${esc(from.name)}</b> → <b>${esc(to.name)}</b></p>
        ${conflict ? `<p class="help">This saved task pair has ${pair.length} relationships. Choose one to keep. Confirming replaces the other relationships for this pair; Cancel keeps them unchanged.</p>
          <label class="fld"><span>Relationship to keep</span><select name="existing"${readOnly ? ' disabled' : ''}>${pair.map((l) => `<option value="${esc(l.id)}"${l.id === id ? ' selected' : ''}>${esc(describe(l))} · ${esc(TYPE_NAME[l.type])}</option>`).join('')}</select></label>` : ''}
        <p class="mut" data-current></p>
        <label class="fld"><span>Relationship type</span><select name="type"${readOnly ? ' disabled' : ''}>${LINK_TYPES.map((type) => `<option value="${type}">${type} · ${esc(TYPE_NAME[type])}</option>`).join('')}</select></label>
        <label class="fld"><span>Lag (days)</span><input name="lag" type="number" step="1" required${readOnly ? ' disabled' : ''}></label>
        <p class="mut">Changes apply only after confirmation. The existing lag is kept unless you edit it.</p>
        <p class="set-err" role="alert" data-error></p>
        <div class="relationship-actions">
          ${!conflict && !readOnly ? '<button type="button" class="lnk red" data-remove>Remove relationship</button>' : ''}
          <span class="grow"></span><button type="button" data-cancel>${readOnly ? 'Close' : 'Cancel'}</button>
          ${!readOnly ? `<button type="submit" class="primary">${conflict ? 'Keep one relationship' : 'Confirm change'}</button>` : ''}
        </div>
      </form>`, { onClose: () => { if (dialog === current) dialog = null; } });
    dialog = current;
    const form = current.body.querySelector('form'), typeInput = form.elements.namedItem('type'), lagInput = form.elements.namedItem('lag');
    const submit = form.querySelector('[type=submit]'), error = form.querySelector('[data-error]');
    const refresh = () => {
      form.querySelector('[data-current]').textContent = `Current: ${describe(chosen)} · ${TYPE_NAME[chosen.type]}`;
      if (submit) submit.disabled = !conflict && typeInput.value === chosen.type && Number(lagInput.value) === chosen.lag;
    };
    const fill = () => { typeInput.value = proposedType || chosen.type; lagInput.value = chosen.lag; refresh(); };
    fill();
    form.addEventListener('input', refresh);
    form.querySelector('[name=existing]')?.addEventListener('change', (e) => { chosen = pair.find((l) => l.id === e.target.value); fill(); });
    form.querySelector('[data-cancel]').addEventListener('click', close);
    const stillCurrent = () => {
      if (store.sheet().id !== sheetId || store.readOnly) { close(); ctx.toast('The project changed; reopen the relationship to edit it.'); return false; }
      if (store.stale) { error.textContent = 'This project changed in another tab. Reload it before editing relationships.'; return false; }
      if (signature(store.linksBetween(first.from, first.to)) !== before) { error.textContent = 'These relationships changed while the editor was open. Close and reopen it before applying changes.'; return false; }
      return true;
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (pending || readOnly || !form.reportValidity() || !stillCurrent()) return;
      pending = true; current.setPending(true);
      try {
        const err = await store.updateLink(chosen.id, { type: typeInput.value, lag: Number(lagInput.value) }, { resolvePair: conflict });
        if (err?.cancelled) return;
        if (err) { error.textContent = err; return; }
        ui.linkId = chosen.id;
        pending = false; current.setPending(false); close(); ctx.requestRender();
        if (conflict) queueMicrotask(review);
      } catch (failure) { error.textContent = failure.message || String(failure); }
      finally { pending = false; current.setPending(false); }
    });
    form.querySelector('[data-remove]')?.addEventListener('click', async () => {
      if (pending || !stillCurrent()) return;
      pending = true; current.setPending(true);
      try {
        const err = await store.removeLink(chosen.id);
        if (err?.cancelled) return;
        if (err) { error.textContent = err; return; }
        ui.linkId = null; pending = false; current.setPending(false); close(); ctx.requestRender();
      } catch (failure) { error.textContent = failure.message || String(failure); }
      finally { pending = false; current.setPending(false); }
    });
  }

  function render() {
    const sheetId = store.sheet().id, count = store.linkConflicts().length;
    reviewButton.hidden = !count || store.readOnly;
    reviewButton.textContent = `Review relationships (${count})`;
    if (dialog && editorSheet !== sheetId) close();
    if (reviewedSheet !== sheetId) {
      reviewedSheet = sheetId;
      // Wait until the initial render has finished; cancellation leaves a persistent review button.
      if (count && !store.readOnly) queueMicrotask(() => { if (store.sheet().id === sheetId && !dialog) review(); });
    }
  }
  reviewButton.addEventListener('click', review);
  return { open, close, render, isOpen: () => !!dialog };
}
