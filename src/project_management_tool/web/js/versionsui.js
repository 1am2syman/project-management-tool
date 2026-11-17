// Project versions: Snapshot button, version dropdown, read-only preview banner, and
// restore / copy / rename / delete. Versions belong to the active project tab.
import { esc, openModal, setHTML } from './dom.js';
import { metrics, fmtDay } from './versiondiff.js';

const when = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown date');
export const versionLabel = (v) => `v${v.n} · ${v.name}`;

export function createVersionsUI(ctx) {
  const { store } = ctx;
  const $ = (s) => document.querySelector(s);
  const pick = $('#versionbtn'), label = $('#versionlbl'), snapBtn = $('#snapshotbtn'), analyzeBtn = $('#analysisbtn');
  const menu = $('#versionmenu'), banner = $('#verbanner'), app = $('#app');
  const summaries = new Map();
  // Version data never changes, so its computed finish date is cached per version.
  function summary(v) {
    const key = `${store.wb.active}:${v.id}:${v.at}`;
    if (!summaries.has(key)) { try { summaries.set(key, metrics(store.versionView(v.id))); } catch { summaries.set(key, null); } }
    return summaries.get(key);
  }

  function render() {
    const v = store.previewing, list = store.versions();
    label.textContent = v ? versionLabel(v) : 'Current';
    pick.classList.toggle('previewing', !!v);
    pick.title = v ? `Viewing ${versionLabel(v)} (read-only). Choose another version or Current.` : `Current plan · ${list.length} saved version${list.length === 1 ? '' : 's'}`;
    snapBtn.disabled = !!store.stale;
    app.classList.toggle('previewing', !!v);
    banner.hidden = !v;
    if (v && banner._key !== `${v.id}|${v.name}|${v.note}`) {
      banner._key = `${v.id}|${v.name}|${v.note}`;
      const ro = store.sheet().readOnly;
      setHTML(banner, `<span class="lock"><svg viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>Viewing version</span>` +
        `<span class="vb-name"><b>${esc(versionLabel(v))}</b> · saved ${esc(when(v.at))}${v.by ? ` by ${esc(v.by)}` : ''} · read-only</span>` +
        (v.note ? `<span class="vb-note" title="${esc(v.note)}">${esc(v.note)}</span>` : '') +
        `<span class="grow"></span><button data-vb="analyze">Compare to current</button>` +
        `<button data-vb="restore"${ro ? ' disabled title="Shared read-only projects cannot be restored"' : ''}>Restore…</button>` +
        `<button data-vb="copy">Copy as new project</button><button data-vb="exit" class="vb-exit">Back to current</button>`);
    }
    if (!v) banner._key = '';
    if (!menu.hidden) fill();
  }

  // ---------- dropdown ----------
  function fill() {
    const list = store.versions(), current = store.previewing?.id || '';
    const row = (v) => {
      const m = summary(v);
      return `<div class="vrow-wrap${v.id === current ? ' on' : ''}"><button class="vrow" role="menuitemradio" aria-checked="${v.id === current}" data-v="${esc(v.id)}"><b>${esc(versionLabel(v))}</b><span>${esc(when(v.at))}${m ? ` · finish ${esc(fmtDay(m.finish))}` : ''}${v.by ? ` · ${esc(v.by)}` : ''}</span>${v.note ? `<em>${esc(v.note)}</em>` : ''}</button>` +
        `<button class="vx" data-edit="${esc(v.id)}" title="Rename or edit note" aria-label="Rename ${esc(versionLabel(v))}">✎</button><button class="vx del" data-del="${esc(v.id)}" title="Delete version" aria-label="Delete ${esc(versionLabel(v))}">✕</button></div>`;
    };
    setHTML(menu, `<div class="ttl">Versions · ${esc(store.sheet().name)}</div>` +
      `<div class="vrow-wrap${current ? '' : ' on'}"><button class="vrow" role="menuitemradio" aria-checked="${!current}" data-v=""><b>Current plan</b><span>Live and editable</span></button></div>` +
      `<div class="vlist">${list.length ? [...list].reverse().map(row).join('') : '<p class="vempty">No versions yet. <b>Snapshot</b> saves the current plan so you can view, restore and compare it later.</p>'}</div>` +
      `<div class="vfoot"><button data-vm="snap"${store.stale ? ' disabled' : ''}>Take snapshot…</button><button data-vm="analyze">Version analysis…</button></div>`);
  }
  function openMenu() {
    fill(); menu.hidden = false; pick.setAttribute('aria-expanded', 'true');
    const r = pick.getBoundingClientRect(), w = menu.getBoundingClientRect().width;
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`; menu.style.top = `${r.bottom + 6}px`;
    (menu.querySelector('.vrow-wrap.on .vrow') || menu.querySelector('.vrow'))?.focus();
  }
  function closeMenu(refocus = false) { if (menu.hidden) return; menu.hidden = true; pick.setAttribute('aria-expanded', 'false'); if (refocus) pick.focus(); }
  pick.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(); });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.v !== undefined) { closeMenu(); show(b.dataset.v); }
    else if (b.dataset.edit) { closeMenu(); edit(b.dataset.edit); }
    else if (b.dataset.del) { closeMenu(); remove(b.dataset.del); }
    else if (b.dataset.vm === 'snap') { closeMenu(); snapshot(); }
    else if (b.dataset.vm === 'analyze') { closeMenu(); ctx.analysis.open(); }
  });
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const items = [...menu.querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !pick.contains(e.target)) closeMenu(); }, true);
  addEventListener('blur', () => closeMenu());

  // ---------- actions ----------
  function show(vid) {
    if (!vid) { store.exitPreview(); return; }
    const error = store.previewVersion(vid); if (error) ctx.toast(error);
  }
  function snapshot() {
    if (store.stale) { ctx.toast(store.versionError()); return; }
    const n = Math.max(store.sheet().nextVersion || 1, (store.versions().at(-1)?.n || 0) + 1), latest = store.versions().at(-1);
    const same = latest && store.unchangedSinceLatest();
    const dialog = openModal('Save version', `
      <p class="help">Saves the current plan of <b>${esc(store.sheet().name)}</b> — tasks, dates, relationships, calendar and scheduling modes — as a read-only version you can view, restore and compare later.</p>
      ${same ? `<p class="vwarn">No changes since ${esc(versionLabel(latest))}.</p>` : ''}
      <label class="fld"><span>Version name</span><input id="vname" maxlength="80" value="${esc(`Version ${n}`)}"></label>
      <label class="fld"><span>Note (optional)</span><textarea id="vnote" rows="3" maxlength="1000" placeholder="e.g. Baseline approved by the steering committee"></textarea></label>
      <p class="set-err" role="alert"></p>
      <div class="rem-actions"><span class="grow"></span><button data-cancel>Cancel</button><button class="primary" data-save>Save version</button></div>`);
    const body = dialog.body, name = body.querySelector('#vname'), err = body.querySelector('.set-err');
    setTimeout(() => { name.focus(); name.select(); }, 0);
    const save = () => {
      const r = store.snapshotVersion({ name: name.value, note: body.querySelector('#vnote').value, by: '' });
      if (r.error) { err.textContent = r.error; return; }
      dialog.close(); ctx.toast(`Saved ${versionLabel(r.version)}`);
    };
    body.querySelector('[data-save]').addEventListener('click', save);
    body.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }
  function edit(vid) {
    const v = store.version(vid); if (!v) return;
    const dialog = openModal(`Edit ${versionLabel(v)}`, `
      <label class="fld"><span>Version name</span><input id="vname" maxlength="80" value="${esc(v.name)}"></label>
      <label class="fld"><span>Note</span><textarea id="vnote" rows="3" maxlength="1000">${esc(v.note)}</textarea></label>
      <p class="mut">Saved ${esc(when(v.at))}${v.by ? ` by ${esc(v.by)}` : ''}. The plan inside a version cannot be edited.</p>
      <p class="set-err" role="alert"></p>
      <div class="rem-actions"><span class="grow"></span><button data-cancel>Cancel</button><button class="primary" data-save>Save</button></div>`);
    const body = dialog.body, err = body.querySelector('.set-err');
    const save = () => { const e = store.updateVersion(vid, { name: body.querySelector('#vname').value, note: body.querySelector('#vnote').value }); if (e) err.textContent = e; else dialog.close(); };
    body.querySelector('[data-save]').addEventListener('click', save);
    body.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    body.querySelector('#vname').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }
  function remove(vid) {
    const v = store.version(vid); if (!v) return;
    if (!window.confirm(`Delete ${versionLabel(v)}? This cannot be undone.`)) return;
    const e = store.deleteVersion(vid); ctx.toast(e || `Deleted ${versionLabel(v)}`);
  }
  function restore(vid) {
    const v = store.version(vid); if (!v) return;
    if (store.sheet().readOnly) { ctx.toast('Shared read-only projects cannot be restored'); return; }
    const same = store.unchangedSinceLatest(), autoNote = store.auto && !v.auto;
    const dialog = openModal(`Restore ${versionLabel(v)}`, `
      <p class="help">Replace the current plan of <b>${esc(store.sheet().name)}</b> with <b>${esc(versionLabel(v))}</b> from ${esc(when(v.at))}. Tasks, dates, relationships, calendar and scheduling modes are restored; reminders, sharing and other versions stay as they are. Undo (Ctrl/⌘+Z) reverses the restore.</p>
      ${autoNote ? '<p class="vwarn">Auto-schedule is on but was off for this version: automatic tasks will be recalculated from their connections. Turn Auto-schedule off first to keep this version’s dates exactly.</p>' : ''}
      <label class="vcheck"><input type="checkbox" id="vkeep"${same ? '' : ' checked'}> Save the current plan as a version first${same ? ' <span class="mut">(already saved as the latest version)</span>' : ''}</label>
      <p class="set-err" role="alert"></p>
      <div class="rem-actions"><span class="grow"></span><button data-cancel>Cancel</button><button class="primary" data-restore>Restore version</button></div>`);
    const body = dialog.body;
    body.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    body.querySelector('[data-restore]').addEventListener('click', () => {
      if (body.querySelector('#vkeep').checked) {
        const r = store.snapshotVersion({ name: `Before restoring v${v.n}`, by: '' });
        if (r.error) { body.querySelector('.set-err').textContent = r.error; return; }
      }
      const e = store.restoreVersion(vid);
      if (e) { body.querySelector('.set-err').textContent = e; return; }
      dialog.close(); ctx.toast(`Restored ${versionLabel(v)} · Undo reverses it`);
    });
  }
  function copy(vid) {
    const r = store.copyVersionAsProject(vid);
    ctx.toast(r.error || `Created “${store.sheet().name}” from the version`);
  }

  snapBtn.addEventListener('click', snapshot);
  analyzeBtn.addEventListener('click', () => ctx.analysis.open());
  banner.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-vb]'); if (!b || b.disabled) return;
    const v = store.previewing; if (!v) return;
    if (b.dataset.vb === 'exit') store.exitPreview();
    else if (b.dataset.vb === 'analyze') ctx.analysis.open(v.id, '');
    else if (b.dataset.vb === 'restore') restore(v.id);
    else if (b.dataset.vb === 'copy') copy(v.id);
  });
  return { render, snapshot, restore, copy, show, closeMenu };
}
