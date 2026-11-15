// Single audited entry point for building DOM from markup strings.
// Contract: every user-supplied value interpolated into `markup` MUST pass through esc() first.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function setHTML(el, markup) {
  // DOMParser documents have scripting disabled, so a stray <script> in the markup stays inert when adopted.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${markup}`, 'text/html');
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
  const close = () => { document.removeEventListener('keydown', key, true); back.remove(); onClose?.(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', key, true);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.querySelector('.m-x').addEventListener('click', close);
  return { el: back, body, close };
}
