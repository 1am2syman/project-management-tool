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
