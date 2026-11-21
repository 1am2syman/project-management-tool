// Workbook-local owner suggestions. Picking a person stores their name and email on the task.
import { esc, setHTML } from './dom.js';

const AV = ['#2d3a4b', '#0f766e', '#b45309', '#9f1239', '#57544d', '#15803d', '#7c2d12', '#3f3c36'];
export const initials = (n) => String(n).split(/[\s@._-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
export const avColor = (n) => AV[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];
export const avatar = (n) => `<span class="av" style="background:${avColor(n)}">${esc(initials(n))}</span>`;

export function createPeople(ctx) {
  const { store } = ctx;

  function local() { // people already on tasks in any sheet
    const out = new Map();
    for (const s of store.wb.sheets) for (const t of s.data.tasks) if (t.owner && t.email) out.set(t.email.toLowerCase(), { id: t.email, name: t.owner, email: t.email, title: '', dept: '', local: true });
    return [...out.values()];
  }
  function resolve(text) { // exact display-name or email match among known people; ambiguous names resolve to nothing
    const q = String(text).trim().toLowerCase(); if (!q) return null;
    const hits = local().filter((p) => p.email.toLowerCase() === q || p.name.toLowerCase() === q);
    const uniq = new Map(hits.map((p) => [p.email.toLowerCase(), p])); return uniq.size === 1 ? [...uniq.values()][0] : null;
  }
  store.resolvePerson = resolve;
  async function suggestions(q) {
    q = q.trim().toLowerCase();
    const items = local().filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
    return { items: items.slice(0, 12), note: items.length ? 'People already entered in this workbook' : 'No local matches. Press Enter to keep the typed name.' };
  }

  // ---------- type-ahead dropdown attached to an <input> ----------
  let listN = 0;
  function attach(inp, onPick) {
    const box = document.createElement('div'); box.className = 'pplist'; box.setAttribute('role', 'listbox'); box.id = `pplist-${++listN}`;
    inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-controls', box.id); document.body.appendChild(box);
    let items = [], idx = -1, seq = 0, timer = 0, dead = false, touched = false; // until the user types, show suggestions instead of searching for the current value
    const place = () => { const r = inp.getBoundingClientRect(); box.style.left = `${Math.min(r.left, innerWidth - 300)}px`; box.style.top = `${r.bottom + 4}px`; box.style.minWidth = `${Math.max(r.width, 280)}px`; };
    const paint = (note) => {
      setHTML(box, items.map((p, i) => `<div class="pp${i === idx ? ' on' : ''}" role="option" id="${box.id}-${i}" aria-selected="${i === idx}" data-i="${i}">${avatar(p.name)}<span class="pn"><b>${esc(p.name)}</b><i>${esc(p.email)}${p.title ? ` · ${esc(p.title)}` : ''}</i></span></div>`).join('') +
        (note ? `<div class="ppnote">${esc(note)}</div>` : '') + (!items.length && !note ? '<div class="ppnote">No matches. Press Enter to keep the typed name.</div>' : ''));
      box.hidden = false; place();
      inp.setAttribute('aria-expanded', 'true'); inp.setAttribute('aria-activedescendant', idx >= 0 ? `${box.id}-${idx}` : '');
    };
    async function refresh() {
      const my = ++seq, r = await suggestions(touched ? inp.value : '');
      if (dead || my !== seq) return;
      items = r.items; idx = items.length && touched && inp.value.trim() ? 0 : -1; paint(r.note);
    }
    const queue = () => { touched = true; idx = -1; items = []; box.hidden = true; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); clearTimeout(timer); timer = setTimeout(refresh, 220); }; // results of an older query must not stay pickable
    const pick = (p, ev) => { cleanup(); onPick(p, ev); };
    function key(e) {
      if (e.key === 'Escape' && inp.closest('.modal')) { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); return; } // close the list, not the dialog
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && idx >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(items[idx], e); }
    }
    function cleanup() { dead = true; clearTimeout(timer); inp.removeEventListener('keydown', key, true); inp.removeEventListener('input', queue); inp.removeEventListener('blur', cleanup); box.remove(); inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); }
    box.addEventListener('pointerdown', (e) => { e.preventDefault(); const row = e.target.closest('.pp'), person = row && items[+row.dataset.i]; if (person) pick(person, e); }); // preventDefault keeps focus in the input
    inp.addEventListener('keydown', key, true); inp.addEventListener('input', queue); inp.addEventListener('blur', cleanup);
    refresh();
    return cleanup;
  }
  return { attach, resolve, known: local };
}
