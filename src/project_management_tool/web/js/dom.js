// Single audited entry point for building DOM from markup strings.
// Contract: every user-supplied value interpolated into `markup` MUST pass through esc() first.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function setHTML(el, markup) {
  const range = document.createRange();
  range.selectNodeContents(el);
  el.replaceChildren(range.createContextualFragment(markup));
}

export function setSVG(el, markup) {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
  el.replaceChildren(...[...doc.documentElement.childNodes].map((n) => document.importNode(n, true)));
}
