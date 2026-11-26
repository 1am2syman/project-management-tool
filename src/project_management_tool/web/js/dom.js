// Single audited entry point for building DOM from markup strings.
// Contract: every user-supplied value interpolated into `markup` MUST pass through esc() first.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function setHTML(el, markup) {
  // A DOMParser document does not run <script>, but event-handler attributes (onerror=…) DO fire once the nodes are adopted,
  // so strip them (and javascript: URLs) here as a second line of defence behind esc().
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${markup}`, 'text/html');
  for (const n of doc.body.querySelectorAll('*')) {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*(javascript|data):/i.test(a.value))) n.removeAttribute(a.name);
  }
  el.replaceChildren(...[...doc.body.childNodes].map((n) => document.adoptNode(n)));
}

export function setSVG(el, markup) {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
  el.replaceChildren(...[...doc.documentElement.childNodes].map((n) => document.importNode(n, true)));
}

// Modal dialog helper: returns { el, body, close }. Esc / backdrop click closes.
export function openModal(title, bodyMarkup, { wide = false, onClose } = {}) {
  const back = document.createElement('div'); back.className = 'modal-back';
  setHTML(back, `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="m-head"><b>${esc(title)}</b><button class="m-x" aria-label="Close">×</button></div><div class="m-body"></div></div>`);
  const body = back.querySelector('.m-body'); setHTML(body, bodyMarkup);
  document.body.appendChild(back);
  const prev = document.activeElement, modal = back.querySelector('.modal');
  modal.setAttribute('tabindex', '-1');
  let pending = false;
  const disabled = new Map();
  const notice = document.createElement('span'); notice.className = 'modal-pending'; notice.setAttribute('role', 'status'); notice.textContent = 'Pending…'; notice.hidden = true;
  back.querySelector('.m-head').appendChild(notice);
  const setPending = (value) => {
    pending = !!value; notice.hidden = !pending; modal.setAttribute('aria-busy', String(pending));
    if (pending) {
      for (const control of modal.querySelectorAll('button,input,select,textarea')) { if (!disabled.has(control)) disabled.set(control, control.disabled); control.disabled = true; }
    } else { for (const [control, previous] of disabled) control.disabled = previous; disabled.clear(); }
  };
  const close = () => { if (pending) return; document.removeEventListener('keydown', key, true); back.remove(); onClose?.(); if (prev && prev.isConnected && prev.focus) prev.focus(); };
  const focusables = () => [...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
  const key = (e) => {
    if (!back.isConnected) return;
    const backs = document.querySelectorAll('.modal-back');
    if (backs[backs.length - 1] !== back) return; // only the topmost modal handles Escape and Tab
    if (e.key === 'Escape') { if (document.querySelector('.pplist')) return; e.stopPropagation(); close(); return; } // an open people list takes Escape first
    if (e.key === 'Tab') { // keep keyboard focus inside the dialog
      const f = focusables(); if (!f.length) { e.preventDefault(); modal.focus(); return; }
      const first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (!modal.contains(a)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', key, true);
  setTimeout(() => { if (back.isConnected && !modal.contains(document.activeElement)) (modal.querySelector('input:not([disabled]),textarea,select') || modal).focus(); }, 0);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.querySelector('.m-x').addEventListener('click', close);
  return { el: back, body, close, setPending };
}
