// Animated topographic backdrop for dialogs and menus.
//
// A vanilla port of Motion Brew's "contour feature card" background (https://motion-brew.com/components/contour-feature-card):
// drifting value noise traced into contour lines with marching squares, every fourth line a little heavier. The pointer raises
// a soft hill so the lines crowd around it and light up near it, a press sends a wave out through the terrain, an idle surface
// raises one now and then, and the lines spread out from the centre when a surface opens. Reduced motion draws one still frame.
//
// Two places use it. Dialogs and menus get a canvas directly behind them while they are open. The main page gets one quiet corner:
// the same lines grow out of the bottom-left of the work area, full strength for the first 1% of the page width and fading to
// nothing at 60% of it, behind the grid and Gantt so they only show where those are empty. The corner hears the pointer anywhere on
// the page: the lines flow along with it and ripple out from the corner while it moves; the hill and glow stay under the pointer.
//
// The terrain and tracing maths below are pure and exported for tests. The DOM wiring is initContour(): it watches the dialogs and
// menus, puts one <canvas> directly behind each surface while it is visible, and runs a single requestAnimationFrame loop that
// stops when nothing is open and the corner is still. The canvas is a sibling, not a child, because several surfaces rebuild their own children and some
// scroll. While a canvas is active the surface carries `contour-on` (transparent background); without the engine it stays white.

export const CELL = 10; // px per marching-squares cell
export const LEVELS = 14; // contour levels traced
export const REVEAL = 1.5; // seconds for the lines to spread out from the centre
export const IDLE_WAVE = 3.6; // seconds without a pointer before a wave rises on its own
const LEVEL_BASE = 0.14; // levels spread over the band the terrain actually spans, so every line shows
const LEVEL_SPAN = 0.78;
const DRIFT = { x: 0.04, y: 0.025 };
const HILL = { amp: 0.28, sigma: 70, reach: 150 }; // the pointer's hill and how far the lines light up around it
const WAVE = { amp: 0.12, speed: 220, sigma: 22, life: 1.8 };
// [alpha, width]. Ultra-faint drafting texture so topographic lines stay barely-there behind dialog and menu content.
const LINE = { color: '#1c1a17', minor: [0.025, 1], major: [0.045, 1.35], lit: 0.09 };
const PAPER = '#ffffff'; // the surface itself is transparent while the canvas is behind it, so the canvas paints the base

export const FADE = { from: 0.01, to: 0.6 }; // the page corner: fully visible up to `from` of the page width, gone from `to`
export const AMBIENT_FPS = 30; // the corner is always on, so it is drawn at half rate
export const AMBIENT_STRENGTH = 1; // the corner's lines relative to a dialog's: 1 = the same 25% of the card's original opacity; raise it to make the corner stronger on its own
const AMBIENT_PIXELS = 1e6; // most pixels the corner canvas keeps in memory and redraws
const FOLLOW = 0.0012; // noise units the terrain moves per px of pointer travel anywhere on the page
const FLOW = 7; // how much faster the terrain drifts at full pointer energy
const RIPPLE_EVERY = 0.5; // seconds between ripples from the corner while the pointer is moving

export const hash = (x, y) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const smooth = (t) => t * t * (3 - 2 * t);
export const noise = (x, y) => {
  const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
};

export const easeOutCubic = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
/** How far the entrance has spread (0..1) `time` seconds after a surface opened. */
export const revealProgress = (time) => Math.min(1, Math.max(0, time / REVEAL));
/** Radius of the circle the lines are clipped to while they spread out from the centre. */
export const revealRadius = (w, h, progress) => revealRadiusFrom(w, h, progress, false);
/** The reveal circle is centred on the surface; for the page corner it starts at the corner and must reach the far side. */
export const revealRadiusFrom = (w, h, progress, corner) => (corner ? Math.hypot(w, h) + 40 : Math.hypot(w, h) / 2 + 40) * easeOutCubic(progress);
/** How much of the lines shows `distance` px from the page corner on a page `width` px wide: all of it, then a straight fade to none. */
export const cornerFade = (distance, width) => {
  const a = FADE.from * width, b = FADE.to * width;
  return distance <= a ? 1 : distance >= b ? 0 : (b - distance) / (b - a);
};
/** The CSS mask that applies cornerFade to the corner canvas: a radial gradient centred on its bottom-left corner. */
export const cornerMask = (width) => `radial-gradient(circle at 0 100%, #000 ${+(FADE.from * width).toFixed(1)}px, transparent ${+(FADE.to * width).toFixed(1)}px)`;
/** The terrain value a contour line sits at. */
export const levelValue = (l, lines = LEVELS) => LEVEL_BASE + l * (1 / (lines + 1)) * LEVEL_SPAN;

/**
 * Fill `field` (cols × rows, row-major) with the terrain height at each grid point: drifting noise, the pointer's hill and any
 * waves. The drift clock is `time * speed + flow`; waves are stamped on `time`.
 */
export function sampleTerrain(field, cols, rows, cell, time, { ox = 0, oy = 0, scale = 1, speed = 1, flow = 0, lift = 1, glow = null, waves = [] } = {}) {
  const t = time * speed + flow; // `flow` is extra drift the caller accumulates, so changing it never makes the terrain jump
  const z = 0.0045 / scale;
  const hill = glow && glow.a > 0.01 ? glow.a * HILL.amp * lift : 0;
  const inv = 1 / (2 * HILL.sigma * HILL.sigma);
  const live = waves.filter((w) => time - w.t < WAVE.life);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * cell, y = j * cell;
      let v = noise(x * z + t * DRIFT.x + ox, y * z - t * DRIFT.y + oy) * 0.65 + noise(x * z * 2.2 - t * 0.03 + ox, y * z * 2.2 + 3.1 + oy) * 0.35;
      if (hill) { const dx = x - glow.x, dy = y - glow.y; v += hill * Math.exp(-(dx * dx + dy * dy) * inv); }
      for (const w of live) {
        const age = time - w.t, d = Math.hypot(x - w.x, y - w.y) - age * WAVE.speed;
        v += WAVE.amp * Math.max(0, 1 - age / WAVE.life) * Math.exp(-(d * d) / (2 * WAVE.sigma * WAVE.sigma));
      }
      field[j * cols + i] = v;
    }
  }
}

// One marching-squares cell. k packs which corners are above the level: top-left 8, top-right 4, bottom-right 2, bottom-left 1.
function cellSegments(sink, k, x, y, cell, lv, a, b, c, d) {
  const top = () => x + ((lv - a) / (b - a)) * cell;
  const right = () => y + ((lv - b) / (c - b)) * cell;
  const bottom = () => x + ((lv - d) / (c - d)) * cell;
  const left = () => y + ((lv - a) / (d - a)) * cell;
  const seg = (x1, y1, x2, y2) => { sink.moveTo(x1, y1); sink.lineTo(x2, y2); };
  switch (k) {
    case 1: case 14: seg(x, left(), bottom(), y + cell); break;
    case 2: case 13: seg(bottom(), y + cell, x + cell, right()); break;
    case 3: case 12: seg(x, left(), x + cell, right()); break;
    case 4: case 11: seg(top(), y, x + cell, right()); break;
    case 5: seg(x, left(), top(), y); seg(bottom(), y + cell, x + cell, right()); break;
    case 6: case 9: seg(top(), y, bottom(), y + cell); break;
    case 7: case 8: seg(x, left(), top(), y); break;
    case 10: seg(x, left(), bottom(), y + cell); seg(top(), y, x + cell, right()); break;
  }
}

/**
 * Trace `lines` contour levels of `field` into two sinks (anything with moveTo/lineTo, such as a Path2D): every fourth level goes
 * to `major`, the rest to `minor`. Each cell only visits the levels between its lowest and highest corner.
 */
export function traceContours(field, cols, rows, cell, lines, minor, major) {
  const raw = 1 / (lines + 1);
  const stepV = raw * LEVEL_SPAN;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = field[j * cols + i], b = field[j * cols + i + 1], c = field[(j + 1) * cols + i + 1], d = field[(j + 1) * cols + i];
      const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
      const first = Math.max(1, Math.floor((lo - LEVEL_BASE) / stepV) - 1), last = Math.min(lines, Math.ceil((hi - LEVEL_BASE) / stepV) + 1);
      for (let l = first; l <= last; l++) {
        const lv = LEVEL_BASE + l * raw * LEVEL_SPAN;
        if (!(hi > lv && lo <= lv)) continue;
        const k = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
        cellSegments(l % 4 === 0 ? major : minor, k, i * cell, j * cell, cell, lv, a, b, c, d);
      }
    }
  }
}

// ---- DOM wiring ----------------------------------------------------------------------------------------------------------

const STATIC_SURFACES = '#expmenu, #tplpop, #ctxmenu, #colpop, #versionmenu';
const BODY_SURFACES = '.task-menu, .dly-pop, .pplist';
const surfaces = new Map(); // element -> state
let raf = 0;
let observers = null;
let ambient = null; // the page-corner canvas, when it is running
const reduced = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Very large surfaces trace a little coarser, and the big page corner a little more.
function cellSize(area, corner) {
  if (corner && area > 600000) return CELL + 6;
  return area > 260000 ? CELL + 2 : CELL;
}

function resize(s, w, h) {
  // The corner covers most of a wide screen, so its backing store is capped: hairlines stay clean when the browser scales it a little.
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1, s.corner ? Math.sqrt(AMBIENT_PIXELS / (w * h)) : 2);
  if (w === s.w && h === s.h && dpr === s.dpr) return;
  s.w = w; s.h = h; s.dpr = dpr;
  s.cell = cellSize(w * h, s.corner);
  s.canvas.width = Math.max(1, Math.round(w * dpr));
  s.canvas.height = Math.max(1, Math.round(h * dpr));
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  s.cols = Math.ceil(w / s.cell) + 1; s.rows = Math.ceil(h / s.cell) + 1;
  s.field = new Float32Array(s.cols * s.rows);
  s.dirty = true;
}

// Keep the canvas exactly behind its surface. offset* ignores the open animation's transform, so the two move together.
function syncRect(s) {
  const el = s.el, c = s.canvas.style;
  const w = el.offsetWidth, h = el.offsetHeight;
  c.left = `${el.offsetLeft}px`; c.top = `${el.offsetTop}px`; c.width = `${w}px`; c.height = `${h}px`;
  resize(s, w, h);
}

function draw(s, progress) {
  const { ctx, w, h } = s;
  ctx.globalAlpha = 1;
  if (s.corner) ctx.clearRect(0, 0, w, h); // the page corner is see-through: the page itself is the paper
  else { ctx.fillStyle = PAPER; ctx.fillRect(0, 0, w, h); }
  if (progress <= 0 || !s.field) return;
  sampleTerrain(s.field, s.cols, s.rows, s.cell, s.time, { ox: s.ox, oy: s.oy, flow: s.flow, glow: s.glow, waves: s.waves });
  const minor = new Path2D(), major = new Path2D();
  traceContours(s.field, s.cols, s.rows, s.cell, LEVELS, minor, major);
  ctx.save();
  if (progress < 1) {
    ctx.beginPath();
    if (s.corner) ctx.arc(0, h, Math.max(0.1, revealRadiusFrom(w, h, progress, true)), 0, Math.PI * 2); // spreads out from the corner
    else ctx.arc(w / 2, h / 2, Math.max(0.1, revealRadius(w, h, progress)), 0, Math.PI * 2);
    ctx.clip();
  }
  const k = s.corner ? AMBIENT_STRENGTH : 1;
  ctx.lineCap = 'round';
  ctx.strokeStyle = LINE.color;
  ctx.globalAlpha = LINE.minor[0] * k; ctx.lineWidth = LINE.minor[1]; ctx.stroke(minor);
  ctx.globalAlpha = LINE.major[0] * k; ctx.lineWidth = LINE.major[1]; ctx.stroke(major);
  ctx.restore();
  if (s.glow.a > 0.01) { // lines near the pointer light up. Clipped to the lit disc: the gradient is transparent beyond it, so only the cost changes.
    ctx.save();
    ctx.beginPath();
    ctx.arc(s.glow.x, s.glow.y, HILL.reach, 0, Math.PI * 2);
    ctx.clip();
    const g = ctx.createRadialGradient(s.glow.x, s.glow.y, 0, s.glow.x, s.glow.y, HILL.reach);
    g.addColorStop(0, LINE.color); g.addColorStop(1, 'transparent');
    ctx.strokeStyle = g; ctx.globalAlpha = LINE.lit * k * s.glow.a; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
    ctx.stroke(minor); ctx.stroke(major);
    ctx.restore();
  }
}

// The corner's response to a pointer that is anywhere on the page: the terrain is pulled along with the travel, drifts faster while the
// pointer is lively, and a ripple leaves the corner every RIPPLE_EVERY seconds while it moves. The energy fades out within about a second.
function follow(s, dt) {
  const take = 1 - Math.pow(0.02, dt);
  s.ox += s.fx * take; s.oy += s.fy * take; s.fx -= s.fx * take; s.fy -= s.fy * take;
  s.energy *= Math.pow(0.15, dt);
  s.flow += dt * s.energy * FLOW;
  if (s.energy > 0.12 && s.time - s.rippled > RIPPLE_EVERY) { s.rippled = s.time; s.waves.push({ x: 0, y: s.h, t: s.time }); }
}

function step(s, now) {
  const dt = Math.min(0.05, Math.max(0, (now - s.last) / 1000)); // never let the clock run backwards or leap after a pause
  s.last = now;
  if (s.still) { // reduced motion: one still frame, redrawn only when the surface changes size
    if (s.dirty) { s.time = 4; s.glow.a = 0; draw(s, 1); s.dirty = false; }
    return;
  }
  s.time += dt;
  const p = s.pointer, g = s.glow;
  if (p.on && g.a < 0.01) { g.x = p.x; g.y = p.y; } // the hill rises under the pointer instead of sliding in from a corner
  const k = 1 - Math.pow(0.002, dt);
  g.x += (p.x - g.x) * k; g.y += (p.y - g.y) * k;
  g.a += ((p.on ? 1 : 0) - g.a) * (1 - Math.pow(0.03, dt));
  if (s.corner) follow(s, dt);
  s.idle = p.on || s.energy > 0.05 ? 0 : s.idle + dt;
  if (s.idle > IDLE_WAVE) {
    s.idle = 0;
    const at = s.corner ? { x: s.w * Math.random() * 0.45, y: s.h * (0.55 + Math.random() * 0.45) } : { x: s.w * (0.15 + Math.random() * 0.7), y: s.h * (0.15 + Math.random() * 0.5) };
    s.waves.push({ ...at, t: s.time });
  }
  s.waves = s.waves.filter((w) => s.time - w.t < WAVE.life);
  draw(s, revealProgress(s.time));
}

function frame(now) {
  raf = 0;
  let live = 0;
  for (const s of surfaces.values()) {
    if (!s.el.isConnected) { drop(s); continue; }
    if (!s.canvas) continue;
    if (s.el.hidden || !s.el.getClientRects().length) { deactivate(s); continue; } // hidden by something other than the attribute
    live++;
    syncRect(s);
    step(s, now);
  }
  // The corner is quiet while anything covers the page (a dialog, a menu, the analysis view), and it is drawn at half rate.
  let corner = false;
  if (ambient && (live || document.body.classList.contains('analysis-open'))) Object.assign(ambient, { energy: 0, fx: 0, fy: 0, prev: null }); // covered: movement does not pile up for later
  if (ambient && !live && !document.body.classList.contains('analysis-open')) {
    corner = !ambient.still;
    if (syncAmbient(ambient) && (ambient.still || now - ambient.last >= 1000 / AMBIENT_FPS - 4)) step(ambient, now);
  }
  if (live || corner) raf = requestAnimationFrame(frame);
}
const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

function activate(s) {
  const el = s.el, cs = getComputedStyle(el);
  const canvas = document.createElement('canvas');
  canvas.className = 'contour-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = cs.position === 'fixed' ? 'fixed' : 'absolute';
  if (cs.zIndex !== 'auto') canvas.style.zIndex = cs.zIndex; // same layer, earlier in the document: directly behind the surface
  canvas.style.borderRadius = cs.borderRadius;
  el.before(canvas);
  Object.assign(s, {
    canvas, ctx: canvas.getContext('2d'), w: 0, h: 0, dpr: 0, time: 0, idle: 0, waves: [], dirty: true, still: reduced(),
    last: performance.now(), ox: Math.random() * 200, oy: Math.random() * 200, glow: { x: 0, y: 0, a: 0 }, pointer: { x: 0, y: 0, on: false },
  });
  el.classList.add('contour-on');
  syncRect(s);
  draw(s, 0); // the paper first, so the transparent surface is never see-through for a frame
  kick();
}

function deactivate(s) {
  if (!s.canvas) return;
  s.canvas.remove();
  s.canvas = s.ctx = s.field = null;
  s.el.classList.remove('contour-on');
}

function refresh(s) {
  const el = s.el;
  const visible = el.isConnected && !el.hidden && el.dataset.contour !== 'off' && el.getClientRects().length > 0;
  if (visible && !s.canvas) activate(s);
  else if (!visible && s.canvas) deactivate(s);
}

function drop(s) {
  deactivate(s);
  s.listeners.forEach(([type, fn]) => s.el.removeEventListener(type, fn));
  surfaces.delete(s.el);
}

function track(el) {
  if (!el || surfaces.has(el)) return;
  const s = { el, canvas: null, listeners: [] };
  const local = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  s.listeners = [
    ['pointermove', (e) => { if (s.canvas) Object.assign(s.pointer, local(e), { on: true }); }],
    ['pointerleave', () => { if (s.canvas) s.pointer.on = false; }],
    ['pointerdown', (e) => { if (s.canvas && !s.still) s.waves.push({ ...local(e), t: s.time }); }], // a press sends a wave through the terrain
  ];
  s.listeners.forEach(([type, fn]) => el.addEventListener(type, fn, { passive: true }));
  surfaces.set(el, s);
  observers.hidden.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  refresh(s);
}

function adopt(node) {
  if (node.nodeType !== 1 || node.classList.contains('contour-canvas')) return;
  if (node.matches('.modal-back')) track(node.querySelector('.modal'));
  else if (node.matches(BODY_SURFACES)) track(node);
}

// ---- the page corner ------------------------------------------------------------------------------------------------------

// Pin the corner canvas to the bottom-left of the work area (#main), sized from the page width, and keep its fade mask in step.
function syncAmbient(s) {
  const main = document.getElementById('main');
  if (!main) return false;
  const r = main.getBoundingClientRect(), page = document.documentElement.clientWidth || globalThis.innerWidth || 1;
  const w = Math.max(1, Math.round(page * FADE.to)), h = Math.max(1, Math.min(w, Math.round(r.height)));
  const c = s.canvas.style;
  c.left = `${Math.round(r.left)}px`; c.top = `${Math.round(r.bottom) - h}px`; c.width = `${w}px`; c.height = `${h}px`;
  s.rect = { left: Math.round(r.left), top: Math.round(r.bottom) - h };
  if (s.page !== page) { // the fade is measured against the page width, so it follows a resize
    s.page = page;
    c.maskImage = c.webkitMaskImage = cornerMask(page);
  }
  resize(s, w, h);
  return true;
}

function startAmbient() {
  const canvas = document.createElement('canvas');
  canvas.className = 'contour-ambient';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const s = ambient = {
    el: document.body, canvas, ctx: canvas.getContext('2d'), corner: true, w: 0, h: 0, dpr: 0, page: 0, time: 0, idle: 0, waves: [], dirty: true, still: reduced(),
    last: performance.now(), ox: Math.random() * 200, oy: Math.random() * 200, flow: 0, energy: 0, fx: 0, fy: 0, rippled: -9, prev: null, glow: { x: 0, y: 0, a: 0 }, pointer: { x: 0, y: 0, on: false }, rect: { left: 0, top: 0 }, listeners: [],
  };
  const local = (e) => ({ x: e.clientX - s.rect.left, y: e.clientY - s.rect.top });
  const inside = (p) => p.x >= 0 && p.y >= 0 && p.x <= s.w && p.y <= s.h;
  const motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const on = (target, type, fn) => { target.addEventListener(type, fn, { passive: true }); s.listeners.push([target, type, fn]); };
  const travel = (e) => { // how far the pointer went since its last event, wherever on the page it is
    if (s.still) return;
    if (s.prev) {
      const dx = e.clientX - s.prev.x, dy = e.clientY - s.prev.y, cap = (v) => Math.max(-1.5, Math.min(1.5, v));
      s.energy = Math.min(1, s.energy + Math.hypot(dx, dy) / 300);
      s.fx = cap(s.fx - dx * FOLLOW); s.fy = cap(s.fy - dy * FOLLOW);
    }
    s.prev = { x: e.clientX, y: e.clientY };
  };
  on(window, 'pointermove', (e) => { const p = local(e); Object.assign(s.pointer, p, { on: inside(p) }); travel(e); });
  on(window, 'pointerdown', (e) => { const p = local(e); if (!s.still && inside(p)) s.waves.push({ ...p, t: s.time }); });
  on(document.documentElement, 'pointerleave', () => { s.pointer.on = false; s.prev = null; });
  on(window, 'resize', () => { s.dirty = true; kick(); });
  on(window, 'blur', () => { s.pointer.on = false; s.prev = null; });
  if (motion) on(motion, 'change', () => { s.still = reduced(); s.dirty = true; kick(); });
  const main = document.getElementById('main');
  if (main && globalThis.ResizeObserver) { s.resizer = new ResizeObserver(() => { s.dirty = true; kick(); }); s.resizer.observe(main); }
  syncAmbient(s);
  draw(s, 0);
  kick();
}

function stopAmbient() {
  if (!ambient) return;
  ambient.listeners.forEach(([target, type, fn]) => target.removeEventListener(type, fn));
  ambient.resizer?.disconnect();
  ambient.canvas.remove();
  ambient = null;
}

/**
 * Start the backdrop for every dialog and menu, now and as they appear, and the quiet corner of the main page.
 * Pass `{ ambient: false }` for dialogs and menus only. Safe to call more than once.
 */
export function initContour({ ambient: corner = true } = {}) {
  if (observers) return disposeContour;
  observers = {
    hidden: new MutationObserver((records) => { for (const r of records) { const s = surfaces.get(r.target); if (s) refresh(s); } }),
    body: new MutationObserver((records) => {
      for (const r of records) { r.addedNodes.forEach(adopt); }
      for (const s of [...surfaces.values()]) if (!s.el.isConnected) drop(s);
    }),
  };
  document.querySelectorAll(STATIC_SURFACES).forEach(track);
  document.querySelectorAll(BODY_SURFACES).forEach(track);
  document.querySelectorAll('.modal-back .modal').forEach(track);
  observers.body.observe(document.body, { childList: true }); // popups are appended straight to <body>
  if (corner) startAmbient();
  return disposeContour;
}

export function disposeContour() {
  if (!observers) return;
  observers.hidden.disconnect(); observers.body.disconnect(); observers = null;
  for (const s of [...surfaces.values()]) drop(s);
  stopAmbient();
  cancelAnimationFrame(raf); raf = 0;
}
