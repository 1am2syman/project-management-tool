// Shared waterfall presentation: chart geometry also feeds the vector PDF export.
import { esc } from './dom.js';
import { fmtDate } from './model.js';
import { fmtDay, signed } from './versiondiff.js';
import { WATERFALL_TYPES } from './finishwaterfall.js';

export const contribution = (step) => step.type === 'subtotal' ? fmtDay(step.to) : `${signed(step.work)}${step.days !== step.work ? ` (${signed(step.days, '')} calendar days)` : ''}`;
// Approved changes to the agreed dates are never drawn as delay: they have their own neutral colour.
const AGREED_TYPES = ['revision', 'inclusion', 'omission'];
export const stepTone = (step) => step.type === 'subtotal' ? 'subtotal' : AGREED_TYPES.includes(step.type) ? 'agreed' : step.type === 'pending' ? 'pending' : step.days > 0 ? 'late' : step.days < 0 ? 'early' : 'flat';
export const stepColor = (step) => ({ subtotal: '#2b59e6', agreed: '#6b7fd7', pending: '#94a3b8' })[stepTone(step)] || (step.type === 'residual' ? '#b45309' : step.days > 0 ? '#f43f5e' : step.days < 0 ? '#15803d' : '#64748b');
export function nameLines(text, max = 22, count = 3) {
  const words = text.split(/\s+/), lines = []; let line = '';
  for (let word of words) {
    if (word.length > max) word = `${word.slice(0, max - 1)}…`;
    if (line && line.length + word.length + 1 > max) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  if (lines.length > count) { lines.length = count; lines[count - 1] = `${lines[count - 1].slice(0, max - 1)}…`; }
  return lines;
}
export function waterfallLayout(w, width, height = 390, steps = w.steps, start = w.baseline, end = w.compared) {
  const values = [start, end, ...steps.flatMap((s) => [s.from, s.to])];
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max(2, Math.ceil((hi - lo) * .12)); lo -= pad; hi += pad;
  const left = 76, right = 16, top = 38, bottom = height - 105, unit = (width - left - right) / (steps.length + 2);
  const X = (i) => left + unit * (i + .5), Y = (date) => bottom - ((date - lo) / (hi - lo)) * (bottom - top);
  const ticks = [], span = hi - lo, tick = [1, 2, 3, 7, 14, 28, 56, 91, 182, 365, 730].find((n) => span / n <= 6) || Math.ceil(span / 6);
  for (let t = Math.ceil(lo / tick) * tick; t <= hi; t += tick) ticks.push(t);
  return { lo, hi, left, right, top, bottom, unit, bar: Math.min(76, unit * .64), X, Y, ticks };
}
export function waterfallChart(w, width, selected = 0) {
  const height = 330, { left, right, bottom, unit, bar, X, Y, ticks } = waterfallLayout(w, width, height);
  // Dense comparisons retain the complete path. Numbers map to the named step picker.
  const numbered = unit < 118;
  let svg = '';
  for (const t of ticks) svg += `<line class="wf-grid" x1="${left}" x2="${width - right}" y1="${Y(t)}" y2="${Y(t)}"/><text class="wf-axis" x="${left - 8}" y="${Y(t) + 4}" text-anchor="end">${esc(fmtDate(t))}</text>`;
  svg += `<line class="wf-base" x1="${left}" x2="${width - right}" y1="${Y(w.baseline)}" y2="${Y(w.baseline)}"/>`;
  const endpoint = (i, date, label) => `<rect class="wf-end" x="${X(i) - bar / 2}" y="${Y(date)}" width="${bar}" height="${Math.max(2, bottom - Y(date))}" rx="4"/><text class="wf-value" x="${X(i)}" y="${Y(date) - 10}" text-anchor="middle">${esc(fmtDate(date))}</text><text class="wf-name" x="${X(i)}" y="${bottom + 24}" text-anchor="middle">${label}</text>`;
  svg += endpoint(0, w.baseline, w.startLabel || 'Baseline');
  let prevX = X(0) + bar / 2, previous = w.baseline;
  w.steps.forEach((step, i) => {
    const total = step.type === 'subtotal';
    const x = X(i + 1), top = total ? Y(step.to) : Y(Math.max(step.from, step.to)), h = total ? Math.max(2, bottom - Y(step.to)) : Math.abs(Y(step.from) - Y(step.to));
    svg += `<line class="wf-connector" x1="${prevX}" x2="${x - bar / 2}" y1="${Y(previous)}" y2="${Y(previous)}"/>`;
    svg += `<g class="wf-step" data-wf-step="${i}" role="button" tabindex="0" aria-pressed="${i === selected}" aria-label="${esc(`${i + 1}. ${step.title}, ${WATERFALL_TYPES[step.type]}, ${contribution(step)}`)}"><title>${esc(`${step.title}: ${contribution(step)} · ${fmtDay(step.from)} → ${fmtDay(step.to)}`)}</title>`;
    svg += `<rect class="wf-selected${selected === i ? ' is-selected' : ''}" x="${x - unit / 2 + 3}" y="16" width="${Math.max(1, unit - 6)}" height="${height - 28}" rx="7"/>`;
    svg += `<rect class="wf-bar" x="${x - bar / 2}" y="${h ? top : top - 1.5}" width="${bar}" height="${Math.max(3, h)}" rx="3" fill="${stepColor(step)}"/><text class="wf-value ${stepTone(step)}" x="${x}" y="${top - 11}" text-anchor="middle">${total ? esc(fmtDate(step.to)) : `${esc(signed(step.work))}${!step.work && step.days ? '*' : ''}`}</text>`;
    const lines = numbered ? [String(i + 1)] : nameLines(step.title, Math.max(12, Math.floor(unit / 6.8)), 3);
    lines.forEach((line, k) => { svg += `<text class="wf-name" x="${x}" y="${bottom + 24 + k * 16}" text-anchor="middle">${esc(line)}</text>`; });
    svg += '</g>';
    prevX = x + bar / 2; previous = step.to;
  });
  svg += `<line class="wf-connector" x1="${prevX}" x2="${X(w.steps.length + 1) - bar / 2}" y1="${Y(previous)}" y2="${Y(previous)}"/>` + endpoint(w.steps.length + 1, w.compared, w.endLabel || 'Compared');
  return { svg, height };
}
export function waterfallMarkup(w) {
  if (!w.available) return `<div class="wf-unavailable"><h3>Finish movement</h3><p>${esc(w.note)}</p></div>`;
  return `<div class="wf"><div class="wf-heading"><h3>${esc(w.title || 'Why the finish moved')}</h3><div class="wf-legend"><span><i class="late"></i>Delay</span><span><i class="early"></i>Recovered</span>${w.steps.some((s) => ['revision', 'inclusion', 'omission', 'subtotal'].includes(s.type)) ? '<span><i class="agreed"></i>Agreed change</span>' : ''}${w.steps.some((s) => s.type === 'pending') ? '<span><i class="pending"></i>Pending inclusion</span>' : ''}${w.steps.some((s) => s.type === 'residual') ? '<span><i class="residual"></i>Unexplained</span>' : ''}</div></div>
    <div class="wf-kpis"><div><span>${esc(w.startLabel || 'Baseline')}</span><b>${esc(fmtDay(w.baseline))}</b></div><span class="wf-arrow" aria-hidden="true">→</span><div><span>${esc(w.endLabel || 'Compared')}</span><b>${esc(fmtDay(w.compared))}</b></div><div class="wf-net"><span>${esc(w.shiftLabel || 'Finish shift')}</span><b class="${stepTone(w)}">${esc(w.days ? contribution(w) : 'No change')}</b></div></div>
    ${w.steps.length ? `<div class="wf-layout"><div class="wf-scroll"><svg class="wf-chart" role="group" aria-label="Contributions to project finish"></svg></div><aside class="wf-detail" aria-label="Selected contribution"></aside></div>` : '<p class="wf-empty">No scheduling changes.</p>'}
    <div class="wf-footer">${w.steps.length ? `<details class="wf-breakdown"><summary>All contributions <span>${w.steps.length}</span></summary><div class="wf-table"><table class="an-t"><thead><tr><th>Item / change group</th><th>Change</th><th>Revision</th><th>Resulting finish</th><th class="n">Project impact</th></tr></thead><tbody>${w.steps.map((s, i) => `<tr data-wf-row="${i}"><td><button data-wf-select="${i}">${esc(s.title)}</button></td><td>${esc(WATERFALL_TYPES[s.type])}</td><td>${s.items.map((item) => `${s.items.length > 1 ? `${esc(item.name)}${item.kind ? ` (${esc(item.kind)})` : ''}: ` : ''}${esc(item.before)} → ${esc(item.after)}`).join('<br>') || `${s.relationships.length} dependency edits`}</td><td>${esc(fmtDay(s.to))}</td><td class="n ${stepTone(s)}">${esc(contribution(s))}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <details class="wf-note"><summary>Calculation notes</summary><p>${esc(w.note)}</p><p>${esc(w.method)}</p><p>Zero-effect changes stay visible. Contributions use the compared calendar; * marks a calendar-day shift with no working-day shift.</p></details></div></div>`;
}
export function waterfallDetails(w, index) {
  const s = w.steps[index]; if (!s) return '';
  const compact = (value) => value.replace(/(\d+) working days?/g, '$1d').replace(/ · auto\b/g, '');
  const facts = s.items.map((item) => `<div>${s.items.length > 1 || item.name !== s.title ? `<div class="wf-item">${esc(item.name)}${item.kind && item.kind !== 'revised' ? ` <span class="chip">${esc(item.kind)}</span>` : ''}</div>` : ''}<div class="wf-values" title="${esc(`${item.before} → ${item.after}`)}"><span>${esc(compact(item.before))}</span><span aria-hidden="true">→</span><strong>${esc(compact(item.after))}</strong></div></div>`).join('');
  return `<label class="wf-picker"><span>Step ${index + 1} of ${w.steps.length}</span><select data-wf-pick aria-label="Select contribution">${w.steps.map((step, i) => `<option value="${i}"${i === index ? ' selected' : ''}>${i + 1}. ${esc(step.title)}</option>`).join('')}</select></label>
    <div class="wf-kind">${esc(WATERFALL_TYPES[s.type])}</div><h3 tabindex="-1">${esc(s.title)}</h3><div class="wf-impact ${stepTone(s)}"><b aria-label="Contribution to project finish: ${esc(contribution(s))}">${esc(contribution(s))}</b><span>${esc(fmtDay(s.from))} → ${esc(fmtDay(s.to))}</span></div>
    ${facts ? `<div class="wf-facts">${facts}</div>` : ''}
    <details class="wf-explain"><summary>Why this step?</summary><p>${esc(s.reason)}</p>
      ${s.relationships.length ? `<h4>Dependencies</h4><ul>${s.relationships.map((l) => `<li>${esc(l.name)}: ${esc(l.before)} → ${esc(l.after)}</li>`).join('')}</ul>` : ''}
      ${s.paths.length ? `<h4>Controlling paths</h4><ul class="wf-chains">${s.paths.map((p) => `<li>${esc(p.join(' → '))}</li>`).join('')}</ul>` : ''}
      ${s.type !== 'residual' && s.type !== 'calendar' ? `<p>Finish drivers: ${esc(s.driversBefore.join(', ') || 'None')} → ${esc(s.driversAfter.join(', ') || 'None')}</p>` : ''}
      ${!s.days ? '<p>No effect on project finish.</p>' : ''}
    </details><div class="wf-actions"><button data-wf-prev aria-label="Previous contribution"${index === 0 ? ' disabled' : ''}>← Previous</button><button data-wf-next aria-label="Next contribution"${index === w.steps.length - 1 ? ' disabled' : ''}>Next →</button></div>`;
}
