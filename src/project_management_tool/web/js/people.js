// People directory: Microsoft 365 colleagues (when signed in) + people already used in this workbook,
// surfaced as a type-ahead picker on the Owner cell. Picking a person stores their name and email on the task.
import { esc, setHTML } from './dom.js';
import * as m365 from './m365.js';

const AV = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444'];
export const initials = (n) => String(n).split(/[\s@._-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
export const avColor = (n) => AV[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];
export const avatar = (n) => `<span class="av" style="background:${avColor(n)}">${esc(initials(n))}</span>`;

export function createPeople(ctx) {
  const { store } = ctx;
  const cache = new Map(); // lower-case email -> person (everything the directory has told us this session)
  let relevant = null, relevantErr = '';
  const add = (p) => { if (p && p.email) cache.set(p.email.toLowerCase(), { ...cache.get(p.email.toLowerCase()), ...p }); return p; };

  function local() { // people already on tasks in any sheet
    const out = new Map();
    for (const s of store.wb.sheets) for (const t of s.data.tasks) if (t.owner && t.email) out.set(t.email.toLowerCase(), { id: t.email, name: t.owner, email: t.email, title: '', dept: '', local: true });
    return [...out.values()];
  }
  function resolve(text) { // exact display-name or email match among known people; ambiguous names resolve to nothing
    const q = String(text).trim().toLowerCase(); if (!q) return null;
    const hits = [...cache.values(), ...local()].filter((p) => p.email.toLowerCase() === q || p.name.toLowerCase() === q);
    const uniq = new Map(hits.map((p) => [p.email.toLowerCase(), p])); return uniq.size === 1 ? [...uniq.values()][0] : null;
  }
  store.resolvePerson = resolve;

  async function suggestions(q) {
    q = q.trim().toLowerCase();
    const mine = local().filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
    if (!m365.isSignedIn()) return { items: mine.slice(0, 8), note: m365.isConfigured() ? 'Sign in to Microsoft 365 to search your organisation' : 'Connect Microsoft 365 to search your organisation' };
    let remote = [], note = '';
    try {
      if (q.length >= 2) remote = await m365.searchPeople(q);
      else {
        if (!relevant && !relevantErr) { try { relevant = await m365.relevantPeople(); } catch (e) { relevantErr = e.message; } }
        remote = relevant || [];
        if (!remote.length) note = 'Type at least 2 letters to search the directory';
      }
    } catch (e) { note = e.status === 403 ? 'Your organisation has not allowed directory search for this app' : e.message; }
    remote.forEach(add);
    const seen = new Set(), items = [];
    for (const p of [...remote, ...mine]) { const k = p.email.toLowerCase(); if (!seen.has(k)) { seen.add(k); items.push(p); } }
    return { items: items.slice(0, 12), note };
  }

  // ---------- type-ahead dropdown attached to an <input> ----------
  function attach(inp, onPick) {
    const box = document.createElement('div'); box.className = 'pplist'; box.setAttribute('role', 'listbox'); document.body.appendChild(box);
    let items = [], idx = -1, seq = 0, timer = 0, dead = false, touched = false; // until the user types, show suggestions instead of searching for the current value
    const place = () => { const r = inp.getBoundingClientRect(); box.style.left = `${Math.min(r.left, innerWidth - 300)}px`; box.style.top = `${r.bottom + 4}px`; box.style.minWidth = `${Math.max(r.width, 280)}px`; };
    const paint = (note) => {
      setHTML(box, items.map((p, i) => `<div class="pp${i === idx ? ' on' : ''}" role="option" data-i="${i}">${avatar(p.name)}<span class="pn"><b>${esc(p.name)}</b><i>${esc(p.email)}${p.title ? ` · ${esc(p.title)}` : ''}</i></span></div>`).join('') +
        (note ? `<div class="ppnote">${esc(note)}</div>` : '') + (!items.length && !note ? '<div class="ppnote">No matches. Press Enter to keep the typed name.</div>' : ''));
      box.hidden = false; place();
    };
    async function refresh() {
      const my = ++seq, r = await suggestions(touched ? inp.value : '');
      if (dead || my !== seq) return;
      items = r.items; idx = items.length && touched && inp.value.trim() ? 0 : -1; paint(r.note);
    }
    const queue = () => { touched = true; clearTimeout(timer); timer = setTimeout(refresh, 220); };
    const pick = (p) => { cleanup(); onPick(p); };
    function key(e) {
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && idx >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(items[idx]); }
    }
    function cleanup() { dead = true; clearTimeout(timer); inp.removeEventListener('keydown', key, true); inp.removeEventListener('input', queue); inp.removeEventListener('blur', cleanup); box.remove(); }
    box.addEventListener('pointerdown', (e) => { e.preventDefault(); const row = e.target.closest('.pp'); if (row) pick(items[+row.dataset.i]); }); // preventDefault keeps focus in the input
    inp.addEventListener('keydown', key, true); inp.addEventListener('input', queue); inp.addEventListener('blur', cleanup);
    refresh();
    return cleanup;
  }
  return { attach, resolve, known: () => [...cache.values()] };
}
