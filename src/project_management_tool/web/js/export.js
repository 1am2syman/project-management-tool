// Export menu: Excel (.xlsx) and PDF, for the active sheet or the whole workbook.
import { buildXlsx } from './xlsx.js';
import { buildPdf } from './pdf.js';
import { setHTML } from './dom.js';

export function createExport(ctx) {
  const { store } = ctx;
  const btn = document.querySelector('#expbtn'), menu = document.querySelector('#expmenu');

  const stamp = () => new Date().toISOString().slice(0, 10);
  const fname = (s) => String(s).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'project';
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function projects(all) {
    store.save();
    const sheets = all ? store.wb.sheets : [store.sheet()];
    return sheets.map((s) => ({ name: s.name, store: store.view(s.id) }));
  }
  async function run(kind, all) {
    const ps = projects(all), base = all ? `workbook-${stamp()}` : `${fname(ps[0].name)}-${stamp()}`;
    try {
      if (kind === 'xlsx') download(await buildXlsx(ps), `${base}.xlsx`);
      else download(buildPdf(ps), `${base}.pdf`);
      ctx.toast(`Exported ${all ? `${ps.length} sheet${ps.length > 1 ? 's' : ''}` : `“${ps[0].name}”`} as ${kind === 'xlsx' ? 'Excel' : 'PDF'}`);
    } catch (err) { console.error(err); ctx.toast(`Export failed: ${err.message}`); }
  }

  const item = (k, a, label, hint) => `<button data-k="${k}" data-all="${a}"><b>${label}</b><span>${hint}</span></button>`;
  function open() {
    const n = store.wb.sheets.length;
    setHTML(menu, '<div class="ttl">Export</div>' +
      item('xlsx', 0, 'Excel · this sheet', 'Tasks + Gantt, styled, filters, grouping') +
      (n > 1 ? item('xlsx', 1, `Excel · all ${n} sheets`, 'One workbook, two tabs per project') : '') +
      item('pdf', 0, 'PDF · this sheet', 'Vector Gantt with links, A4 landscape') +
      (n > 1 ? item('pdf', 1, `PDF · all ${n} sheets`, 'One document, pages per project') : ''));
    menu.hidden = false;
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - 260, innerWidth - 268))}px`; menu.style.top = `${r.bottom + 6}px`;
  }
  const close = () => { menu.hidden = true; };
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(); });
  menu.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; close(); run(b.dataset.k, b.dataset.all === '1'); });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return { run };
}
