// Gantt: timeline header, keyed DOM bars, SVG orthogonal dependency routing,
// pointer-driven move / resize / progress / link-create / pan, wheel zoom, edge auto-scroll.
import { DAY, MONTHS, dow, today, fmtDate, ymd } from './model.js';
import { setHTML, setSVG, esc } from './dom.js';
import { appState } from './appstate.js';

import { dims } from './dims.js';
const PAD_B = 40;
const monday = (d) => d - ((dow(d) + 6) % 7);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LETTER = 'SMTWTFS';

function isoWeek(d) {
  const th = d + 3 - ((dow(d) + 6) % 7);
  const y = ymd(th)[0], y0 = Date.UTC(y, 0, 1) / DAY;
  return Math.floor((th - y0) / 7) + 1;
}

// Build an orthogonal path with rounded corners. dA: exit direction at A (+1 right / -1 left),
// dF: direction of travel on the final segment into B (+1 = enters a start edge, -1 = a finish edge).
let ppdNow = () => 16;
function route(ax, ay, dA, bx, by, dF) {
  const g = ppdNow() < 5 ? 4 : 11;
  let lo = -Infinity, hi = Infinity;
  if (dA > 0) lo = Math.max(lo, ax + g); else hi = Math.min(hi, ax - g);
  if (dF > 0) hi = Math.min(hi, bx - g); else lo = Math.max(lo, bx + g);
  let pts;
  if (lo <= hi) { const xm = dA > 0 ? lo : hi; pts = [[ax, ay], [xm, ay], [xm, by], [bx, by]]; }
  else {
    const a1 = ax + dA * g, b1 = bx - dF * g, my = by > ay ? ay + dims.row / 2 : ay - dims.row / 2 + (by === ay ? dims.row : 0);
    pts = [[ax, ay], [a1, ay], [a1, my], [b1, my], [b1, by], [bx, by]];
  }
  return roundPath(pts);
}
function roundPath(pts) {
  // dedupe + drop collinear points
  const q = [pts[0]];
  for (let i = 1; i < pts.length; i++) { const p = pts[i], l = q[q.length - 1]; if (Math.abs(p[0] - l[0]) > 0.01 || Math.abs(p[1] - l[1]) > 0.01) q.push(p); }
  const r = 5; let d = `M${q[0][0].toFixed(1)} ${q[0][1].toFixed(1)}`;
  for (let i = 1; i < q.length - 1; i++) {
    const p0 = q[i - 1], p = q[i], p1 = q[i + 1];
    const l0 = Math.hypot(p[0] - p0[0], p[1] - p0[1]), l1 = Math.hypot(p1[0] - p[0], p1[1] - p[1]), rr = Math.min(r, l0 / 2, l1 / 2);
    const a = [p[0] + (p0[0] - p[0]) / l0 * rr, p[1] + (p0[1] - p[1]) / l0 * rr], b = [p[0] + (p1[0] - p[0]) / l1 * rr, p[1] + (p1[1] - p[1]) / l1 * rr];
    d += `L${a[0].toFixed(1)} ${a[1].toFixed(1)}Q${p[0].toFixed(1)} ${p[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  const e = q[q.length - 1]; d += `L${e[0].toFixed(1)} ${e[1].toFixed(1)}`;
  return d;
}

export function createGantt(ctx) {
  const { store, ui } = ctx;
  const $ = (s) => document.querySelector(s);
  const root = $('#app'), gb = $('#gb'), canvas = $('#canvas'), bg = $('#bg'), linksEl = $('#links'), barsEl = $('#bars'), linkdrag = $('#linkdrag');
  const ghdin = $('#ghdin'), todayline = $('#todayline'), tip = $('#tip'), seg = $('#zoomseg');
  const rowsel = document.createElement('div'); rowsel.className = 'rowsel'; canvas.insertBefore(rowsel, $('#links'));
  const slackEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  slackEl.classList.add('slack-overlay'); slackEl.setAttribute('aria-hidden', 'true'); canvas.insertBefore(slackEl, barsEl);
  const slackRows = () => store.rows.filter((t) => ui.slackMode !== 'off' && (ui.slackMode === 'all' || ui.selId === t.id) && !store.info.get(t.id).summary);
  function slackEnd() {
    let end = store.project.end;
    for (const t of slackRows()) { const f = store.info.get(t.id); if (f.float > 0) end = Math.max(end, f.latestEnd); if (f.freeFloat > 0) end = Math.max(end, f.freeEnd); }
    return end;
  }
  let ppd = 16, origin = null, endDay = 0, W = 0, H = 0, taskH = 0, layoutKey = '';
  const barEls = new Map();
  let vwCache = 0;
  if (window.ResizeObserver) new ResizeObserver(() => { const w = gb.clientWidth; if (w !== vwCache) { vwCache = w; if (origin != null) ctx.requestRender(); } }).observe(gb);
  let drag = null, raf = 0, bgDefs = '', bgBody = '', pendShift = 0;

  ppdNow = () => ppd;
  const xOf = (d) => (d - origin) * ppd;
  let restoringView = true, viewTimer = 0, queuedView = null;
  function readViews() {
    try { const value = JSON.parse(appState.getItem('pm-gantt-views') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }
  function flushView() {
    clearTimeout(viewTimer); viewTimer = 0;
    if (!queuedView) return;
    const views = readViews(); views[queuedView.id] = queuedView.value; queuedView = null;
    appState.setItem('pm-gantt-views', JSON.stringify(views));
  }
  function queueView() {
    if (restoringView || drag || origin == null) return;
    queuedView = { id: store.wb.active, value: { ppd, leftDay: Math.round((origin + gb.scrollLeft / ppd) * 1000) / 1000, top: gb.scrollTop } };
    clearTimeout(viewTimer); viewTimer = setTimeout(flushView, 120);
  }
  window.addEventListener('pm-flush-view', () => { queueView(); flushView(); });

  // ---------- layout / header / background ----------
  function layout() {
    const P = store.project;
    if (origin == null) origin = monday(P.start - 14);
    else if (P.start < origin) { const no = monday(P.start - 14); pendShift += (origin - no) * ppd; origin = no; layoutKey = ''; } // tasks moved earlier than the timeline: grow it leftwards
    const vw = vwCache || gb.clientWidth || 800; // cached: reading clientWidth after the grid's DOM writes would force a layout every frame
    const target = Math.max(slackEnd() + 45, origin + Math.ceil(vw / ppd) + 7);
    endDay = origin + Math.ceil((target - origin) / 14) * 14;
    W = (endDay - origin) * ppd;
    taskH = store.rows.length * dims.row;
    H = taskH + dims.row + 4 + PAD_B; // match the grid's total row and bottom padding for scroll sync
    const key = `${origin}|${endDay}|${ppd}|${H}|${JSON.stringify(store.calendar)}`;
    if (key === layoutKey) return;
    layoutKey = key;
    buildHead(); buildBg();
  }

  // Views collapse the timeline: quarter / month / week / day. Mode is derived from px-per-day so
  // ctrl+wheel zooming flows continuously between them.
  const modeOf = (p) => (p < 3.8 ? 'quarter' : p < 10 ? 'month' : p < 26 ? 'week' : 'day');
  const TIERS = { quarter: ['year', 'quarter', 'month'], month: ['quarter', 'month', 'week'], week: ['month', 'week', 'day'], day: ['month', 'week', 'day'] };
  const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const utc = (y, m, d) => Date.UTC(y, m, d) / DAY;
  function nextBoundary(unit, d) {
    const [y, m] = ymd(d);
    if (unit === 'year') return utc(y + 1, 0, 1);
    if (unit === 'quarter') return utc(y, (Math.floor(m / 3) + 1) * 3, 1);
    if (unit === 'month') return utc(y, m + 1, 1);
    if (unit === 'week') return monday(d) + 7;
    return d + 1;
  }
  function spanLabel(unit, d, w, last) {
    const [y, m, dd] = ymd(d);
    if (unit === 'year') return w >= 40 ? String(y) : '';
    if (unit === 'quarter') return w >= 90 ? `Q${Math.floor(m / 3) + 1} · ${y}` : w >= 26 ? `Q${Math.floor(m / 3) + 1}` : '';
    if (unit === 'month') return w >= 130 ? `${FULL[m]} ${y}` : w >= 30 ? MONTHS[m].slice(0, 3) : w >= 24 ? MONTHS[m][0] : last === 'x' ? '' : '';
    if (unit === 'week') return w >= 96 ? `W${isoWeek(d)} · ${fmtDate(d)}` : w >= 36 ? `W${isoWeek(d)}` : w >= 20 ? String(dd) : '';
    return '';
  }
  function buildHead() {
    const tiers = TIERS[modeOf(ppd)];
    let h = '';
    tiers.forEach((unit, ti) => {
      for (let d = unit === 'week' ? monday(origin) : origin; d < endDay;) {
        const nb = nextBoundary(unit, d), s = Math.max(d, origin), e = Math.min(nb, endDay), w = (e - s) * ppd;
        const dow0 = dow(d), we = unit === 'day' && !store.work.isWork(d);
        const cur = today >= d && today < nb;
        let inner = '';
        if (unit === 'day') { if (ppd >= 14) inner = `${ppd >= 26 ? `<small>${LETTER[dow0]}</small>` : ''}${ymd(d)[2]}`; }
        else inner = spanLabel(unit, d, w);
        h += `<div class="t${ti + 1}${we ? ' we' : ''}${cur ? (unit === 'day' ? ' td' : ' tdu') : ''}" style="left:${xOf(s)}px;width:${w}px">${inner}</div>`;
        d = nb;
      }
    });
    ghdin.style.width = `${W}px`;
    setHTML(ghdin, h);
  }

  function buildBg() {
    if (ppd >= 5) {
      const off = [...Array(7)].map((_, i) => !store.work.week.has(dow(origin + i)) ? `<rect x="${i * ppd}" y="0" width="${ppd}" height="100" fill="rgba(15,23,42,.035)"/>` : '').join('');
      const wk = `<pattern id="wk" width="${7 * ppd}" height="100" patternUnits="userSpaceOnUse">${off}</pattern>`;
      const step = ppd >= 20 ? ppd : 7 * ppd, a = ppd >= 20 ? 0.045 : 0.07;
      bgDefs = `<defs>${wk}<pattern id="dl" width="${step}" height="100" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="1" height="100" fill="rgba(15,23,42,${a})"/></pattern></defs>`;
      bgBody = `<rect width="${W}" height="${taskH}" fill="url(#wk)"/><rect width="${W}" height="${taskH}" fill="url(#dl)"/>`;
    } else { bgDefs = ''; bgBody = ''; }
    // explicit month / quarter boundaries in the coarse views
    let lines = store.work.holidays.filter((day) => day >= origin && day < endDay).map((day) => `<rect x="${xOf(day)}" y="0" width="${Math.max(1, ppd)}" height="${taskH}" fill="rgba(245,158,11,.14)"/>`).join('');
    if (ppd < 10) for (let d = nextBoundary('month', origin - 1); d < endDay; d = nextBoundary('month', d)) { const q = ymd(d)[1] % 3 === 0; lines += `<rect x="${xOf(d)}" y="0" width="1" height="${taskH}" fill="rgba(15,23,42,${q ? 0.12 : 0.06})"/>`; }
    bg.setAttribute('width', W); bg.setAttribute('height', taskH);
    setSVG(bg, bgDefs + bgBody + lines);
  }

  // ---------- bars ----------
  function makeBar(id) {
    const el = document.createElement('div');
    el.dataset.id = id;
    setHTML(el, '<div class="fill"></div><span class="label"><span class="label-text"></span></span><i class="h resize-start"></i><i class="h resize-end"></i><b class="dot s"></b><b class="dot f"></b><u class="prog"></u>');
    el._fill = el.children[0]; el._label = el.children[1]; el._text = el._label.firstElementChild; el._prog = el.children[6];
    return el;
  }

  // The bar under the pointer follows it by fractions of a day (the dates snap, the bar glides); it settles onto the day grid on release.
  function nudged(t, f, x1, x2) {
    if (!drag || drag.id !== t.id || !drag.frac || f.summary) return [x1, x2];
    const d = drag.frac * ppd;
    return drag.kind === 'move' ? [x1 + d, x2 + d] : drag.kind === 'rl' ? [Math.min(x1 + d, x2 - 6), x2] : drag.kind === 'rr' ? [x1, Math.max(x2 + d, x1 + 6)] : [x1, x2];
  }
  // Snap painted bounds without rounding dates or the timeline's zoom scale.
  const pixel = (v) => { const scale = window.devicePixelRatio || 1; return Math.round(v * scale) / scale; };
  function positionBar(el, ms, x1, x2) {
    const left = pixel(ms ? x1 : x1 + 1);
    el.style.left = left + 'px';
    if (!ms) el.style.width = Math.max(6, pixel(x2 - 1) - left) + 'px';
  }
  function nudge() { // cheap per-pointer-move update of just the dragged bar
    const el = barEls.get(drag.id), t = store.byId.get(drag.id), f = store.info.get(drag.id); if (!el || !t || !f || f.summary) return;
    const [x1, x2] = nudged(t, f, xOf(f.start), xOf(f.end));
    positionBar(el, t.ms, x1, x2);
  }

  const tctx = document.createElement('canvas').getContext('2d'), twCache = new Map(); let twKey = '';
  function textW(s) { // width of a bar label in the bar font, cached per density
    const k = dims.name, ref = barsEl.querySelector('.label'); if (!ref) return s.length * 6.5;
    if (k !== twKey) { twKey = k; twCache.clear(); const cs = getComputedStyle(ref); tctx.font = `500 ${cs.fontSize} ${cs.fontFamily}`; tctx.fontVariantCaps = cs.fontVariantCaps; }
    let w = twCache.get(s); if (w == null) { w = tctx.measureText(s).width; twCache.set(s, w); } return w;
  }

  // focus mode: classes for the selected task's parents/children and predecessor/successor chains
  const relClass = (id) => ctx.relClass(id);
  function renderBars() {
    const seen = new Set();
    store.rows.forEach((t, i) => {
      const f = store.info.get(t.id); let el = barEls.get(t.id);
      if (!el) { el = makeBar(t.id); barEls.set(t.id, el); barsEl.appendChild(el); }
      seen.add(t.id);
      let x1 = xOf(f.start), x2 = xOf(f.end); const y = i * dims.row + (dims.row - dims.bar) / 2;
      [x1, x2] = nudged(t, f, x1, x2);
      const ms = t.ms && !f.summary;
      const rc = relClass(t.id);
      const schedule = store.scheduling(t.id);
      el.setAttribute('aria-label', `${t.name} · ${schedule.label}`);
      const cls = 'bar' + rc + (f.summary ? ' summary' : '') + (ms ? ' ms' : '') + (f.critical ? ' critical' : '') + (t.id === ui.selId ? ' selected' : '') +
        (ms && t.progress >= 100 ? ' done' : '') + (drag && drag.id === t.id && drag.moved ? ' dragging' : '');
      if (el._cls !== cls) { el.className = cls; el._cls = cls; }
      let w = ms ? 18 : Math.max(6, x2 - x1 - 2);
      positionBar(el, ms, x1, x2);
      el.style.top = pixel(y) + 'px';
      if (el._lt !== t.name) { el._text.textContent = t.name; el.title = t.name; el._lt = t.name; }
      el.title = `${t.name} · ${schedule.label}: ${schedule.detail}${!f.summary ? ` · Total slack: ${f.float == null ? 'outside selected target' : f.float + ' working days'} · Free slack: ${f.freeFloat} working days${f.critical ? ` · ${store.criticalLabel()}${store.criticalOptions().method === 'longest' && f.float > 0 ? ': on the driving path; calendar working periods allow positive slack' : ''}` : ''}` : ''}${ctx.delay?.tooltip(t.id) ?? ''}`;
      { // soft shading on the task where the delay started, only for its own delay days
        const sh = ms || f.summary ? null : ctx.delay?.shade(t.id);
        if (sh) {
          if (!el._shade) { el._shade = document.createElement('div'); el._shade.className = 'dly-shade'; el.appendChild(el._shade); }
          el._shade.style.width = Math.max(2, Math.min(w, (sh.to - sh.from) * ppd)) + 'px';
        } else if (el._shade) { el._shade.remove(); el._shade = null; }
      }
      // Keep readable bars self-contained; only very short bars need an external label.
      const out = !f.summary && !ms && w < 80 && textW(t.name) + 16 > w;
      el._label.classList.toggle('out', out);
      const labelX = ms ? x1 + dims.msz * 1.5 + 9 : x1 + 1 + w + (f.summary ? 8 : 18);
      el._label.style.maxWidth = f.summary || ms || out ? Math.max(0, Math.min(200, W - labelX - 8)) + 'px' : '';
      const hw = ms || f.summary ? 8 : clamp(w * 0.22, 3, 8); if (el._hw !== hw) { el._hw = hw; el.style.setProperty('--hw', hw + 'px'); }
      const p = f.progress;
      el._fill.style.width = p + '%'; el._fill.classList.toggle('full', p >= 100);
      el._prog.style.left = p + '%';
    });
    for (const [id, el] of barEls) if (!seen.has(id)) { el.remove(); barEls.delete(id); }
  }

  // ---------- links ----------
  function anchor(id, end, rowIdx) {
    const f = store.info.get(id), t = store.byId.get(id), y = rowIdx * dims.row + dims.row / 2;
    if (t.ms && !f.summary) return [pixel(xOf(f.start)) + (end === 's' ? -1 : 1) * (dims.msz / 2 + 4), y];
    return [end === 's' ? pixel(xOf(f.start) + 1) : Math.max(pixel(xOf(f.start) + 1) + 6, pixel(xOf(f.end) - 1)), y];
  }
  // Link paths are keyed by id and only re-parsed when their geometry or state changed, so a drag touches a handful of paths, not all of them.
  const linkEls = new Map(), linkScratch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  function paintLinks(want) {
    const keep = new Set(want.map((w) => w[0]));
    for (const [id, o] of linkEls) if (!keep.has(id)) { o.el.remove(); linkEls.delete(id); }
    const changed = want.filter(([id, html]) => !linkEls.has(id) || linkEls.get(id).html !== html);
    if (!changed.length) return;
    setSVG(linkScratch, changed.map((c) => c[1]).join(''));
    const fresh = [...linkScratch.children];
    changed.forEach(([id, html], i) => { const o = linkEls.get(id); if (o) o.el.replaceWith(fresh[i]); else linksEl.appendChild(fresh[i]); linkEls.set(id, { el: fresh[i], html }); });
  }
  function renderLinks() {
    const idx = new Map(store.rows.map((t, i) => [t.id, i]));
    linksEl.setAttribute('width', W); linksEl.setAttribute('height', H);
    const want = [];
    for (const l of store.links) {
      const a = idx.get(l.from), b = idx.get(l.to); if (a == null || b == null) continue;
      const fe = l.type[0] === 'F' ? 'f' : 's', te = l.type[1] === 'F' ? 'f' : 's';
      const [ax, ay] = anchor(l.from, fe, a), [bx, by] = anchor(l.to, te, b);
      const dA = fe === 'f' ? 1 : -1, dF = te === 's' ? 1 : -1;
      let d, arrow;
      const tt = store.byId.get(l.to);
      if (l.type === 'FS' && by !== ay && !(tt.ms) && bx - ax < 2 * (ppd < 5 ? 4 : 11)) { // back-to-back: drop into the top/bottom edge of the successor instead of looping around it
        const s = by > ay ? 1 : -1, xv = Math.max(ax + 3, bx + 5), ty = by - s * dims.bar / 2;
        d = roundPath([[ax, ay], [xv, ay], [xv, ty]]); arrow = `${xv},${ty} ${xv - 4},${ty - s * 7} ${xv + 4},${ty - s * 7}`;
      } else {
        d = route(ax, ay, dA, bx, by, dF);
        arrow = `${bx},${by} ${bx - dF * 7},${by - 4} ${bx - dF * 7},${by + 4}`;
      }
      const rl = ctx.rel ? (ctx.rel.upL.has(l.id) ? ' r-up' : ctx.rel.downL.has(l.id) ? ' r-down' : ' dim') : '';
      want.push([l.id, `<g class="lk${rl}${l.critical ? ' crit' : ''}${l.violated ? ' viol' : ''}${ui.linkId === l.id ? ' sel' : ''}" data-id="${esc(l.id)}"><path class="hit" d="${d}"/><path class="vis" d="${d}"/><polygon class="ah" points="${arrow}"/></g>`]);
    }
    paintLinks(want);
  }

  function renderSlack() {
    slackEl.setAttribute('width', W); slackEl.setAttribute('height', taskH);
    const indices = new Map(store.rows.map((task, i) => [task.id, i]));
    // A slack tail continues from the task's finish: the thick part reaches the free-slack
    // limit, the thin dashed part continues to the total-slack limit. Only the selected task gets a label.
    const markup = slackRows().map((task) => {
      const f = store.info.get(task.id), total = f.float > 0 ? f.float : 0, free = f.freeFloat > 0 ? f.freeFloat : 0;
      if (!total && !free) return '';
      const cy = pixel(indices.get(task.id) * dims.row + dims.row / 2), h = Math.max(3, Math.round(dims.bar * 0.18)), y = cy - h / 2;
      const edge = (day) => pixel(task.ms ? xOf(day) : xOf(day) - 1); // milestone centre or bar's right edge
      const x0 = task.ms ? pixel(xOf(f.start) + dims.msz * 0.72) : edge(f.end);
      const xTotal = total ? edge(task.ms ? f.latestStart : f.latestEnd) : x0, xFree = free ? edge(task.ms ? f.freeStart : f.freeEnd) : x0, xEnd = Math.max(xTotal, xFree);
      // Segments never overlap, so the translucent fill stays one even tone.
      const thin = Math.max(1, Math.round(h / 2)), from = free ? xFree : x0;
      let shapes = free ? `<rect class="slack-free" x="${x0}" y="${y}" width="${Math.max(2, xFree - x0)}" height="${h}"/>` : '';
      if (total && xTotal > from) shapes += `<line class="slack-total" x1="${from}" y1="${cy}" x2="${xTotal}" y2="${cy}" stroke-width="${thin}"/>`;
      const cap = (x) => `<line class="slack-cap" x1="${x}" y1="${pixel(cy - dims.bar * 0.32)}" x2="${x}" y2="${pixel(cy + dims.bar * 0.32)}"/>`;
      shapes += cap(xEnd) + (total && xTotal < xEnd ? cap(xTotal) : '');
      if (ui.selId === task.id) {
        const text = !total ? `${free}d free` : total === free ? `${total}d slack` : `${total}d total · ${free}d free`;
        shapes += `<text x="${xEnd + 7}" y="${pixel(cy + 4)}">${text}</text>`;
      }
      const dim = ctx.rel && relClass(task.id).includes('dim') ? ' dim' : '';
      return `<g class="slack-item${dim}" data-task="${task.id}">${shapes}</g>`;
    }).join('');
    if (slackEl._markup !== markup) { setSVG(slackEl, markup); slackEl._markup = markup; }
  }

  // ---------- render ----------
  function render() {
    layout();
    root.classList.toggle('crit-on', store.critical);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    if (pendShift) { gb.scrollLeft += pendShift; if (drag && drag.cx0 != null) drag.cx0 += pendShift; pendShift = 0; }
    const si = store.rows.findIndex((t) => t.id === ui.selId);
    rowsel.style.display = si >= 0 ? '' : 'none'; rowsel.style.top = si * dims.row + 'px';
    const tx = xOf(today) + ppd / 2;
    todayline.style.height = taskH + 'px';
    todayline.style.display = taskH > 0 && tx > 0 && tx < W ? '' : 'none'; todayline.style.left = tx + 'px';
    renderBars(); renderLinks(); renderSlack(); ctx.delay?.decorate({ canvas, W, H: taskH, xOf, pixel });
    if (!drag) syncHead(); // while dragging, scrolling (autoscroll/pan) already syncs through the scroll event; reading scrollLeft here would force a layout
    updateSeg();
  }
  function syncHead() { ghdin.style.left = -gb.scrollLeft + 'px'; }
  function updateSeg() {
    let best = null, bd = Infinity;
    seg.querySelectorAll('button[data-zoom]').forEach((b) => { const d = Math.abs(Math.log(+b.dataset.zoom / ppd)); if (d < bd) { bd = d; best = b; } });
    seg.querySelectorAll('button[data-zoom]').forEach((b) => b.classList.toggle('on', b === best && bd < 0.45));
  }

  // ---------- zoom / navigation ----------
  function anchorDay() { // what the presets should keep in view: the selection, else today (if inside the project), else the project start
    const P = store.project, f = ui.selId != null ? store.info.get(ui.selId) : null;
    return f ? f.start : today >= P.start && today <= P.end ? today : P.start;
  }
  function setPpd(np, clientX, preset) {
    np = clamp(np, 1.2, 90); if (Math.abs(np - ppd) < 0.01) return;
    const rect = gb.getBoundingClientRect();
    let ax = clientX != null ? clientX - rect.left : rect.width / 2, day = origin + (gb.scrollLeft + ax) / ppd;
    if (preset) { day = anchorDay(); ax = Math.min(rect.width * 0.3, 160); }
    ppd = np; render();
    gb.scrollLeft = (day - origin) * ppd - ax; syncHead(); queueView();
  }
  function fit() {
    const P = store.project, vw = gb.clientWidth;
    if (vw < 60 || !store.rows.length) return;
    // Measure labels, milestone diamonds, connection handles and routed elbows together.
    // Their bounds change with zoom, so measure again after each adjustment.
    let padding = 20;
    ppd = Math.min(90, (vw - 40) / Math.max(1, slackEnd() - P.start));
    for (let i = 0; i < 12; i++) {
      origin = P.start - Math.ceil(padding / ppd); layoutKey = ''; render();
      const left = canvas.getBoundingClientRect().left;
      let first = Infinity, right = 0;
      const elements = [...barEls.values()].flatMap((el) => [el, el._label, ...el.querySelectorAll('.dot')]);
      elements.push(...linksEl.querySelectorAll('.vis,.ah'), ...slackEl.querySelectorAll('.slack-item'));
      for (const el of elements) {
        const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
        const diamond = el.classList.contains('ms') ? dims.msz * (Math.SQRT2 - 1) / 2 : 0;
        first = Math.min(first, rect.left - left - diamond);
        right = Math.max(right, rect.right - left + diamond);
      }
      // Leave room for the connector hit area and enlarged handles on hover.
      if (first < 8) { padding += 8 - first; continue; }
      if (right <= vw - 16) break;
      ppd *= Math.max(0.1, (vw - padding - 16) / Math.max(vw - padding, right - padding));
    }
    gb.scrollLeft = 0; syncHead(); queueView();
  }
  function reset() {
    flushView(); restoringView = true;
    const view = readViews()[store.wb.active];
    ppd = Number.isFinite(view?.ppd) ? clamp(view.ppd, 0.000001, 90) : 16;
    origin = null; layoutKey = '';
    for (const el of barEls.values()) el.remove();
    barEls.clear(); gb.scrollTop = 0; gb.scrollLeft = 0; closePop();
  }
  function initialScroll() {
    const view = readViews()[store.wb.active];
    gb.scrollLeft = Number.isFinite(view?.leftDay) ? Math.max(0, xOf(view.leftDay)) : Math.max(0, xOf(store.project.start) - 36);
    gb.scrollTop = Number(view?.top) || 0; ctx.syncV(gb.scrollTop);
    syncHead(); restoringView = false; queueView();
  }
  function goToday() { gb.scrollTo({ left: xOf(today) - gb.clientWidth / 2, behavior: 'smooth' }); }
  function reveal(id, horizontal) {
    const i = store.rows.findIndex((t) => t.id === id); if (i < 0) return;
    const top = i * dims.row, bot = top + dims.row, vh = gb.clientHeight - 12;
    if (top < gb.scrollTop) gb.scrollTop = top; else if (bot > gb.scrollTop + vh) gb.scrollTop = bot - vh;
    if (horizontal) {
      const f = store.info.get(id), x1 = xOf(f.start), x2 = xOf(f.end);
      if (x2 < gb.scrollLeft + 20 || x1 > gb.scrollLeft + gb.clientWidth - 20) gb.scrollTo({ left: x1 - gb.clientWidth / 3, behavior: 'smooth' });
    }
  }

  // ---------- relationship editor ----------
  function closePop() { ctx.relationships.close(); }
  function openPop(id, proposedType) { ctx.relationships.open(id, proposedType); }

  // ---------- tooltip ----------
  function showTip(html, x, y) { setHTML(tip, html); tip.classList.add('on'); tip.style.left = Math.min(x + 14, innerWidth - 260) + 'px'; tip.style.top = Math.max(8, y - 44) + 'px'; }
  const hideTip = () => tip.classList.remove('on');
  function dragTip() {
    if (!drag || !drag.moved) return;
    const t = store.byId.get(drag.id), f = store.info.get(drag.id);
    if (drag.kind === 'prog') { showTip(`<b>${esc(t.name)}</b> <span>${Math.round(t.progress)}% complete</span>`, drag.lastX, drag.lastY); return; }
    const dur = store.duration(t.id);
    showTip(`<b>${esc(t.name)}</b> <span>${fmtDate(f.start)}${t.ms ? '' : ` → ${fmtDate(f.end - 1)} · ${dur}d`}</span>`, drag.lastX, drag.lastY);
  }

  // ---------- pointer interaction ----------
  const contentX = (clientX) => clientX - gb.getBoundingClientRect().left + gb.scrollLeft;
  const contentY = (clientY) => clientY - gb.getBoundingClientRect().top + gb.scrollTop;

  gb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const gr = gb.getBoundingClientRect();
    if (e.clientX - gr.left >= gb.clientWidth || e.clientY - gr.top >= gb.clientHeight) return; // scrollbar
    const dot = e.target.closest('.dot'), prog = e.target.closest('.prog'), hnd = e.target.closest('.h'), bar = e.target.closest('.bar'), lk = e.target.closest('.lk');
    if (lk) { openPop(lk.dataset.id); return; }
    if (!bar) {
      drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, sl: gb.scrollLeft, st: gb.scrollTop, moved: false, lastX: e.clientX, lastY: e.clientY };
      gb.setPointerCapture(e.pointerId); return;
    }
    const id = +bar.dataset.id;
    if (ui.selId !== id || ui.linkId) ctx.select(id, ui.col);
    if (store.stale) { ctx.toast('This project changed in another window; reload before editing.'); return; }
    if (store.readOnly) { store.emit('denied'); return; } // viewers can look, not touch
    gb.setPointerCapture(e.pointerId);
    if (dot) { drag = { kind: 'link', id, end: dot.classList.contains('f') ? 'f' : 's', moved: true, lastX: e.clientX, lastY: e.clientY, target: null }; root.classList.add('linking'); e.preventDefault(); return; }
    store.beginDrag();
    const kind = prog ? 'prog' : hnd ? (hnd.classList.contains('resize-start') ? 'rl' : 'rr') : 'move';
    drag = { kind, id, x0: e.clientX, y0: e.clientY, cx0: contentX(e.clientX), moved: false, lastX: e.clientX, lastY: e.clientY, delta: null };
    e.preventDefault();
  });

  gb.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 3) return;
    if (!drag.moved) { drag.moved = true; if (drag.kind === 'pan') gb.classList.add('panning'); }
    step();
    if (drag && drag.kind !== 'pan' && !raf) raf = requestAnimationFrame(loop);
  });

  function loop() {
    raf = 0; if (!drag) return;
    const r = gb.getBoundingClientRect(), zone = 56; let v = 0;
    if (drag.lastX > r.right - zone) v = ((drag.lastX - (r.right - zone)) / zone) * 22;
    else if (drag.lastX < r.left + zone) v = -((r.left + zone - drag.lastX) / zone) * 22;
    let vy = 0;
    if (drag.lastY > r.bottom - zone) vy = ((drag.lastY - (r.bottom - zone)) / zone) * 18;
    else if (drag.lastY < r.top + zone) vy = -((r.top + zone - drag.lastY) / zone) * 18;
    if (drag.kind !== 'pan' && (v || vy)) { gb.scrollLeft += v; gb.scrollTop += vy; step(); raf = requestAnimationFrame(loop); }
  }

  function step() {
    if (!drag) return;
    const { kind, id } = drag;
    if (kind === 'pan') { gb.scrollLeft = drag.sl - (drag.lastX - drag.x0); gb.scrollTop = drag.st - (drag.lastY - drag.y0); return; }
    if (kind === 'link') { linkStep(); return; }
    const cx = contentX(drag.lastX);
    if (kind === 'prog') {
      const f = store.info.get(id), x1 = xOf(f.start), w = xOf(f.end) - x1;
      store.dragApply(() => store.dragProgress(id, ((cx - x1) / w) * 100));
    } else {
      const rawD = (cx - drag.cx0) / ppd, delta = Math.round(rawD);
      drag.frac = rawD - delta;
      if (delta === drag.delta) { nudge(); dragTip(); return; }
      drag.delta = delta;
      store.dragApply(() => { if (kind === 'move') store.dragMove(id, delta); else store.dragResize(id, kind === 'rl' ? 'l' : 'r', delta); });
    }
    dragTip();
  }

  function linkStep() {
    const cx = contentX(drag.lastX), cy = contentY(drag.lastY), rows = store.rows;
    const fi = rows.findIndex((t) => t.id === drag.id), [ax, ay] = anchor(drag.id, drag.end, fi);
    let target = null, bad = false;
    const ri = Math.floor(cy / dims.row), t = rows[ri];
    if (t && t.id !== drag.id) {
      const f = store.info.get(t.id);
      if (!f.summary) {
        const ms = t.ms, x1 = xOf(f.start) - (ms ? 14 : 0), x2 = xOf(f.end) + (ms ? 14 : 0);
        if (cx >= x1 - 18 && cx <= x2 + 18) { target = { id: t.id, end: cx < (x1 + x2) / 2 ? 's' : 'f', ri }; bad = !!store.canLink(drag.id, t.id); }
      }
    }
    for (const [id, el] of barEls) { const on = !!target && !bad && target.id === id; el.querySelector('.dot.s').classList.toggle('target', on && target.end === 's'); el.querySelector('.dot.f').classList.toggle('target', on && target.end === 'f'); }
    drag.target = bad ? null : target;
    let ex = cx, ey = cy;
    if (target) [ex, ey] = anchor(target.id, target.end, target.ri);
    const col = bad ? '#e11d48' : '#2b59e6', sx = ax;
    const mx = (sx + ex) / 2;
    linkdrag.setAttribute('width', W); linkdrag.setAttribute('height', H);
    setSVG(linkdrag, `<path d="M${sx} ${ay} C${mx} ${ay} ${mx} ${ey} ${ex} ${ey}" stroke="${col}" stroke-width="2" stroke-dasharray="5 4" fill="none"/><circle cx="${ex}" cy="${ey}" r="4.5" fill="${col}" stroke="none"/>`);
  }

  function finish(commit) {
    if (!drag) return;
    const d = drag; drag = null; if (raf) { cancelAnimationFrame(raf); raf = 0; }
    gb.classList.remove('panning'); root.classList.remove('linking'); hideTip();
    if (d.kind === 'pan') { if (!d.moved) { ctx.select(null); } }
    else if (d.kind === 'link') {
      setSVG(linkdrag, '');
      barEls.forEach((el) => el.querySelectorAll('.dot').forEach((x) => x.classList.remove('target')));
      if (commit && d.target) {
        const existing = store.linksBetween(d.id, d.target.id);
        const type = (d.end === 'f' ? 'F' : 'S') + (d.target.end === 'f' ? 'F' : 'S');
        if (existing.length) {
          const link = existing.find((l) => l.type === type) || existing[0];
          if (existing.length === 1 && link.type === type) ctx.selectLink(link.id);
          else openPop(link.id, type);
        } else {
          const err = store.addLink(d.id, d.end, d.target.id, d.target.end); if (err) ctx.toast(err);
        }
      }
      else if (commit && d.moved) { const ri = Math.floor(contentY(d.lastY) / dims.row), t = store.rows[ri]; if (t && t.id !== d.id) { const err = store.canLink(d.id, t.id); if (err) ctx.toast(err); } }
    } else store.endDrag(commit && d.moved, { id: d.id, kind: d.kind });
    ctx.requestRender(); queueView(); flushView();
  }
  gb.addEventListener('pointerup', () => finish(true));
  gb.addEventListener('pointercancel', () => finish(false));
  gb.addEventListener('lostpointercapture', () => { if (drag) finish(true); });

  gb.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setPpd(ppd * Math.exp(-e.deltaY * 0.0018), e.clientX); }
  }, { passive: false });
  gb.addEventListener('scroll', () => { syncHead(); ctx.syncV(gb.scrollTop); queueView(); });

  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.fit) fit(); else setPpd(+b.dataset.zoom, null, true); });

  reset();
  return {
    render, setPpd, goToday, reveal, closePop, fit, initialScroll, reset,
    zoomStep: (dir) => setPpd(ppd * (dir > 0 ? 1.3 : 1 / 1.3)),
    cancelDrag: () => finish(false),
    isDragging: () => !!drag && drag.moved,
    setScrollTop: (v) => { if (gb.scrollTop !== v) gb.scrollTop = v; },
    popOpen: () => ctx.relationships.isOpen(),
  };
}
