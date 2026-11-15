// Gantt: timeline header, keyed DOM bars (transform-positioned), SVG orthogonal dependency routing,
// pointer-driven move / resize / progress / link-create / pan, wheel zoom, edge auto-scroll.
import { DAY, MONTHS, dow, today, fmtDate, ymd } from './model.js';
import { setHTML, setSVG, esc } from './dom.js';

export const ROW = 34, BAR_H = 22, TOTAL_H = 38, PAD_B = 40;
const monday = (d) => d - ((dow(d) + 6) % 7);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LETTER = 'SMTWTFS';
const TYPE_NAME = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish', SF: 'Start → Finish' };

function isoWeek(d) {
  const th = d + 3 - ((dow(d) + 6) % 7);
  const y = ymd(th)[0], y0 = Date.UTC(y, 0, 1) / DAY;
  return Math.floor((th - y0) / 7) + 1;
}

// Build an orthogonal path with rounded corners. dA: exit direction at A (+1 right / -1 left),
// dF: direction of travel on the final segment into B (+1 = enters a start edge, -1 = a finish edge).
function route(ax, ay, dA, bx, by, dF) {
  const g = 11;
  let lo = -Infinity, hi = Infinity;
  if (dA > 0) lo = Math.max(lo, ax + g); else hi = Math.min(hi, ax - g);
  if (dF > 0) hi = Math.min(hi, bx - g); else lo = Math.max(lo, bx + g);
  let pts;
  if (lo <= hi) { const xm = dA > 0 ? lo : hi; pts = [[ax, ay], [xm, ay], [xm, by], [bx, by]]; }
  else {
    const a1 = ax + dA * g, b1 = bx - dF * g, my = by > ay ? ay + ROW / 2 : ay - ROW / 2 + (by === ay ? ROW : 0);
    pts = [[ax, ay], [a1, ay], [a1, my], [b1, my], [b1, by], [bx, by]];
  }
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
  const ghdin = $('#ghdin'), todayline = $('#todayline'), tip = $('#tip'), pop = $('#linkpop'), seg = $('#zoomseg');
  const rowsel = document.createElement('div'); rowsel.className = 'rowsel'; canvas.insertBefore(rowsel, $('#links'));
  let ppd = 28, origin = null, endDay = 0, W = 0, H = 0, layoutKey = '';
  const barEls = new Map();
  let drag = null, raf = 0, popLink = null;

  const xOf = (d) => (d - origin) * ppd;

  // ---------- layout / header / background ----------
  function layout() {
    const P = store.project;
    if (origin == null) origin = monday(P.start - 14);
    const vw = gb.clientWidth || 800;
    const target = Math.max(P.end + 45, origin + Math.ceil(vw / ppd) + 7);
    endDay = origin + Math.ceil((target - origin) / 14) * 14;
    W = (endDay - origin) * ppd;
    H = store.rows.length * ROW + TOTAL_H + PAD_B;
    const key = `${origin}|${endDay}|${ppd}|${H}`;
    if (key === layoutKey) return;
    layoutKey = key;
    buildHead(); buildBg();
  }

  function buildHead() {
    let h = '';
    for (let d = origin; d < endDay;) {
      const [y, m] = ymd(d), next = Math.min(Date.UTC(y, m + 1, 1) / DAY, endDay), w = (next - d) * ppd;
      h += `<div class="t1" style="left:${xOf(d)}px;width:${w}px">${w > 90 ? `${MONTHS[m]} ${y}` : w > 34 ? MONTHS[m] : ''}</div>`;
      d = next;
    }
    for (let d = origin; d < endDay; d += 7) {
      const w = 7 * ppd;
      h += `<div class="t2" style="left:${xOf(d)}px;width:${w}px">${w >= 84 ? `W${isoWeek(d)} · ${fmtDate(d)}` : w >= 40 ? `W${isoWeek(d)}` : ''}</div>`;
    }
    if (ppd >= 16) {
      for (let d = origin; d < endDay; d++) {
        const wd = dow(d), we = wd === 0 || wd === 6;
        h += `<div class="t3${we ? ' we' : ''}${d === today ? ' td' : ''}" style="left:${xOf(d)}px;width:${ppd}px">${ppd >= 26 ? `<small>${LETTER[wd]}</small>` : ''}${ymd(d)[2]}</div>`;
      }
    }
    ghdin.style.width = W + 'px';
    setHTML(ghdin, h);
  }

  function buildBg() {
    const sat = (6 - dow(origin) + 7) % 7, s1 = sat, s2 = (sat + 1) % 7;
    const lines = ppd >= 20
      ? `<pattern id="dl" width="${ppd}" height="100" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="1" height="100" fill="rgba(15,23,42,.045)"/></pattern>`
      : `<pattern id="dl" width="${7 * ppd}" height="100" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="1" height="100" fill="rgba(15,23,42,.07)"/></pattern>`;
    bg.setAttribute('width', W); bg.setAttribute('height', H);
    setSVG(bg, `<defs><pattern id="wk" width="${7 * ppd}" height="100" patternUnits="userSpaceOnUse"><rect x="${s1 * ppd}" y="0" width="${ppd}" height="100" fill="rgba(15,23,42,.035)"/><rect x="${s2 * ppd}" y="0" width="${ppd}" height="100" fill="rgba(15,23,42,.035)"/></pattern>${lines}</defs>` +
      `<rect width="${W}" height="${H}" fill="url(#wk)"/><rect width="${W}" height="${H}" fill="url(#dl)"/>`);
  }

  // ---------- bars ----------
  function makeBar(id) {
    const el = document.createElement('div');
    el.dataset.id = id;
    setHTML(el, '<div class="fill"></div><span class="label"></span><i class="h l"></i><i class="h r"></i><b class="dot s"></b><b class="dot f"></b><u class="prog"></u>');
    el._fill = el.children[0]; el._label = el.children[1]; el._prog = el.children[6];
    return el;
  }

  function renderBars() {
    const seen = new Set();
    store.rows.forEach((t, i) => {
      const f = store.info.get(t.id); let el = barEls.get(t.id);
      if (!el) { el = makeBar(t.id); barEls.set(t.id, el); barsEl.appendChild(el); }
      seen.add(t.id);
      const x1 = xOf(f.start), x2 = xOf(f.end), y = i * ROW + (ROW - BAR_H) / 2;
      const ms = t.ms && !f.summary;
      const cls = 'bar' + (f.summary ? ' summary' : '') + (ms ? ' ms' : '') + (f.critical ? ' critical' : '') + (t.id === ui.selId ? ' selected' : '') +
        (ms && t.progress >= 100 ? ' done' : '') + (drag && drag.id === t.id && drag.moved ? ' dragging' : '');
      if (el._cls !== cls) { el.className = cls; el._cls = cls; }
      let w = ms ? 18 : Math.max(6, x2 - x1 - 2);
      el.style.transform = `translate3d(${ms ? x1 : x1 + 1}px,${y}px,0)`;
      if (!ms) el.style.width = w + 'px';
      if (el._lt !== t.name) { el._label.textContent = t.name; el._lt = t.name; }
      const out = !f.summary && !ms && w < 78;
      el._label.classList.toggle('out', out);
      const p = f.progress;
      el._fill.style.width = p + '%'; el._fill.classList.toggle('full', p >= 100);
      el._prog.style.left = p + '%';
    });
    for (const [id, el] of barEls) if (!seen.has(id)) { el.remove(); barEls.delete(id); }
  }

  // ---------- links ----------
  function anchor(id, end, rowIdx) {
    const f = store.info.get(id), t = store.byId.get(id), y = rowIdx * ROW + ROW / 2;
    if (t.ms && !f.summary) return [xOf(f.start) + (end === 's' ? -12 : 12), y];
    return [end === 's' ? xOf(f.start) + 1 : xOf(f.end) - 1, y];
  }
  function renderLinks() {
    const idx = new Map(store.rows.map((t, i) => [t.id, i]));
    linksEl.setAttribute('width', W); linksEl.setAttribute('height', H);
    let h = '';
    for (const l of store.links) {
      const a = idx.get(l.from), b = idx.get(l.to); if (a == null || b == null) continue;
      const fe = l.type[0] === 'F' ? 'f' : 's', te = l.type[1] === 'F' ? 'f' : 's';
      const [ax, ay] = anchor(l.from, fe, a), [bx, by] = anchor(l.to, te, b);
      const dA = fe === 'f' ? 1 : -1, dF = te === 's' ? 1 : -1;
      const d = route(ax, ay, dA, bx, by, dF);
      const arrow = `${bx},${by} ${bx - dF * 7},${by - 4} ${bx - dF * 7},${by + 4}`;
      h += `<g class="lk${l.critical ? ' crit' : ''}${l.violated ? ' viol' : ''}${ui.linkId === l.id ? ' sel' : ''}" data-id="${esc(l.id)}"><path class="hit" d="${d}"/><path class="vis" d="${d}"/><polygon class="ah" points="${arrow}"/></g>`;
    }
    setSVG(linksEl, h);
  }

  // ---------- render ----------
  function render() {
    layout();
    root.classList.toggle('crit-on', store.critical);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const si = store.rows.findIndex((t) => t.id === ui.selId);
    rowsel.style.display = si >= 0 ? '' : 'none'; rowsel.style.top = si * ROW + 'px';
    const tx = xOf(today) + ppd / 2;
    todayline.style.display = tx > 0 && tx < W ? '' : 'none'; todayline.style.left = tx + 'px';
    renderBars(); renderLinks();
    syncHead(); updateSeg();
  }
  function syncHead() { ghdin.style.transform = `translateX(${-gb.scrollLeft}px)`; }
  function updateSeg() {
    let best = null, bd = Infinity;
    seg.querySelectorAll('button').forEach((b) => { const d = Math.abs(Math.log(+b.dataset.zoom / ppd)); if (d < bd) { bd = d; best = b; } });
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === best && bd < 0.35));
  }

  // ---------- zoom / navigation ----------
  function setPpd(np, clientX) {
    np = clamp(np, 5, 90); if (Math.abs(np - ppd) < 0.01) return;
    const rect = gb.getBoundingClientRect(), ax = clientX != null ? clientX - rect.left : rect.width / 2;
    const day = origin + (gb.scrollLeft + ax) / ppd;
    ppd = np; render();
    gb.scrollLeft = (day - origin) * ppd - ax; syncHead();
  }
  function goToday() { gb.scrollTo({ left: xOf(today) - gb.clientWidth / 2, behavior: 'smooth' }); }
  function reveal(id, horizontal) {
    const i = store.rows.findIndex((t) => t.id === id); if (i < 0) return;
    const top = i * ROW, bot = top + ROW, vh = gb.clientHeight - 12;
    if (top < gb.scrollTop) gb.scrollTop = top; else if (bot > gb.scrollTop + vh) gb.scrollTop = bot - vh;
    if (horizontal) {
      const f = store.info.get(id), x1 = xOf(f.start), x2 = xOf(f.end);
      if (x2 < gb.scrollLeft + 20 || x1 > gb.scrollLeft + gb.clientWidth - 20) gb.scrollTo({ left: x1 - gb.clientWidth / 3, behavior: 'smooth' });
    }
  }

  // ---------- link popover ----------
  function closePop() { pop.hidden = true; popLink = null; }
  function fillPop() {
    const l = store.links.find((x) => x.id === popLink); if (!l) { closePop(); return; }
    setHTML(pop, `<div class="ttl"><b>${store.rowNum(l.from)} → ${store.rowNum(l.to)}</b> · ${TYPE_NAME[l.type]}</div>` +
      `<div class="row"><div class="types">${['FS', 'SS', 'FF', 'SF'].map((t) => `<button data-t="${t}" class="${t === l.type ? 'on' : ''}">${t}</button>`).join('')}</div></div>` +
      `<div class="row"><label>Lag (days)</label><input type="number" step="1" value="${l.lag}"></div>` +
      `<div class="row"><button class="del">Remove link</button><span style="flex:1"></span><span class="ttl">${l.violated ? 'violated' : l.slack ? `slack ${l.slack}d` : 'tight'}</span></div>`);
  }
  function openPop(id, x, y) {
    popLink = id; fillPop(); pop.hidden = false;
    pop.style.left = clamp(x + 8, 8, innerWidth - 240) + 'px'; pop.style.top = clamp(y + 10, 8, innerHeight - 180) + 'px';
  }
  pop.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]'), del = e.target.closest('.del');
    if (t) { store.updateLink(popLink, { type: t.dataset.t }); fillPop(); }
    else if (del) { store.removeLink(popLink); closePop(); ui.linkId = null; ctx.requestRender(); }
  });
  pop.addEventListener('change', (e) => { if (e.target.matches('input')) { store.updateLink(popLink, { lag: parseInt(e.target.value, 10) || 0 }); fillPop(); } });
  pop.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur?.(); if (e.key === 'Escape') closePop(); });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.lk')) closePop(); }, true);

  // ---------- tooltip ----------
  function showTip(html, x, y) { setHTML(tip, html); tip.classList.add('on'); tip.style.left = Math.min(x + 14, innerWidth - 260) + 'px'; tip.style.top = Math.max(8, y - 44) + 'px'; }
  const hideTip = () => tip.classList.remove('on');
  function dragTip() {
    if (!drag || !drag.moved) return;
    const t = store.byId.get(drag.id), f = store.info.get(drag.id);
    if (drag.kind === 'prog') { showTip(`<b>${esc(t.name)}</b> <span>${Math.round(t.progress)}% complete</span>`, drag.lastX, drag.lastY); return; }
    const dur = f.end - f.start;
    showTip(`<b>${esc(t.name)}</b> <span>${fmtDate(f.start)}${t.ms ? '' : ` → ${fmtDate(f.end - 1)} · ${dur}d`}</span>`, drag.lastX, drag.lastY);
  }

  // ---------- pointer interaction ----------
  const contentX = (clientX) => clientX - gb.getBoundingClientRect().left + gb.scrollLeft;
  const contentY = (clientY) => clientY - gb.getBoundingClientRect().top + gb.scrollTop;

  gb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const dot = e.target.closest('.dot'), prog = e.target.closest('.prog'), hnd = e.target.closest('.h'), bar = e.target.closest('.bar'), lk = e.target.closest('.lk');
    if (lk) { ctx.selectLink(lk.dataset.id); openPop(lk.dataset.id, e.clientX, e.clientY); return; }
    if (!bar) {
      drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, sl: gb.scrollLeft, st: gb.scrollTop, moved: false, lastX: e.clientX, lastY: e.clientY };
      gb.setPointerCapture(e.pointerId); return;
    }
    const id = +bar.dataset.id;
    if (ui.selId !== id || ui.linkId) ctx.select(id, ui.col);
    gb.setPointerCapture(e.pointerId);
    if (dot) { drag = { kind: 'link', id, end: dot.classList.contains('f') ? 'f' : 's', moved: true, lastX: e.clientX, lastY: e.clientY, target: null }; root.classList.add('linking'); e.preventDefault(); return; }
    store.beginDrag();
    const kind = prog ? 'prog' : hnd ? (hnd.classList.contains('l') ? 'rl' : 'rr') : 'move';
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
    if (drag.kind !== 'pan' && v) { gb.scrollLeft += v; step(); raf = requestAnimationFrame(loop); }
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
      const delta = Math.round((cx - drag.cx0) / ppd);
      if (delta === drag.delta) { return; }
      drag.delta = delta;
      store.dragApply(() => { if (kind === 'move') store.dragMove(id, delta); else store.dragResize(id, kind === 'rl' ? 'l' : 'r', delta); });
      const f = store.info.get(id);
      if (f.start < origin + 2) { const s = 28; origin -= s; gb.scrollLeft += s * ppd; drag.cx0 += s * ppd; layoutKey = ''; }
    }
    dragTip();
  }

  function linkStep() {
    const cx = contentX(drag.lastX), cy = contentY(drag.lastY), rows = store.rows;
    const fi = rows.findIndex((t) => t.id === drag.id), [ax, ay] = anchor(drag.id, drag.end, fi);
    let target = null, bad = false;
    const ri = Math.floor(cy / ROW), t = rows[ri];
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
      if (commit && d.target) { const err = store.addLink(d.id, d.end, d.target.id, d.target.end); if (err) ctx.toast(err); }
      else if (commit && d.moved) { const ri = Math.floor(contentY(d.lastY) / ROW), t = store.rows[ri]; if (t && t.id !== d.id) { const err = store.canLink(d.id, t.id); if (err) ctx.toast(err); } }
    } else store.endDrag(commit && d.moved);
    ctx.requestRender();
  }
  gb.addEventListener('pointerup', () => finish(true));
  gb.addEventListener('pointercancel', () => finish(false));
  gb.addEventListener('lostpointercapture', () => { if (drag) finish(true); });

  gb.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setPpd(ppd * Math.exp(-e.deltaY * 0.0018), e.clientX); }
  }, { passive: false });
  gb.addEventListener('scroll', () => { syncHead(); ctx.syncV(gb.scrollTop); });

  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setPpd(+b.dataset.zoom); });

  return {
    render, setPpd, goToday, reveal, closePop,
    zoomStep: (dir) => setPpd(ppd * (dir > 0 ? 1.3 : 1 / 1.3)),
    cancelDrag: () => finish(false),
    isDragging: () => !!drag && drag.moved,
    setScrollTop: (v) => { if (gb.scrollTop !== v) gb.scrollTop = v; },
    popOpen: () => !pop.hidden,
  };
}
