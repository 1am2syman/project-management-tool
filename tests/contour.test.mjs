import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL, LEVELS, REVEAL, FADE, AMBIENT_STRENGTH, hash, noise, easeOutCubic, revealProgress, revealRadius, revealRadiusFrom, cornerFade, cornerMask, levelValue, sampleTerrain, traceContours } from '../src/project_management_tool/web/js/contour.js';

// A sink that records segments the way a Path2D would receive them.
const sink = () => { const segs = []; let at = null; return { segs, moveTo: (x, y) => { at = [x, y]; }, lineTo: (x, y) => { segs.push([...at, x, y]); } }; };
const grid = (cols, rows, fn) => { const f = new Float32Array(cols * rows); for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) f[j * cols + i] = fn(i, j); return f; };

test('hash and noise are deterministic and stay in 0..1', () => {
  assert.equal(hash(3, 7), hash(3, 7));
  assert.notEqual(hash(3, 7), hash(7, 3));
  for (let i = 0; i < 400; i++) {
    const x = (i * 0.37) - 40, y = (i * 0.91) % 53 - 20;
    const n = noise(x, y);
    assert.ok(n >= 0 && n <= 1, `noise(${x}, ${y}) = ${n}`);
    assert.equal(n, noise(x, y));
  }
});

test('noise is continuous: nearby points give nearby values and lattice points equal the hash', () => {
  assert.equal(noise(5, -3), hash(5, -3));
  for (let i = 0; i < 200; i++) {
    const x = i * 0.173, y = i * 0.311;
    assert.ok(Math.abs(noise(x, y) - noise(x + 1e-4, y + 1e-4)) < 5e-3);
  }
});

test('the entrance spreads from the centre: easing, clamping and radius', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(-4), 0);
  assert.equal(easeOutCubic(9), 1);
  assert.ok(easeOutCubic(0.5) > 0.5, 'ease-out is front-loaded');
  assert.equal(revealProgress(0), 0);
  assert.equal(revealProgress(REVEAL / 2), 0.5);
  assert.equal(revealProgress(REVEAL * 3), 1);
  assert.equal(revealProgress(-1), 0);
  assert.equal(revealRadius(400, 300, 0), 0);
  assert.ok(revealRadius(400, 300, 1) > Math.hypot(400, 300) / 2, 'fully revealed covers the corners');
  assert.ok(revealRadius(400, 300, 0.3) < revealRadius(400, 300, 0.6));
});

test('contour levels are increasing and sit inside the band the terrain spans', () => {
  let last = -Infinity;
  for (let l = 1; l <= LEVELS; l++) { const v = levelValue(l); assert.ok(v > last); assert.ok(v > 0 && v < 1); last = v; }
});

test('terrain is deterministic, drifts with time and honours the pointer hill and waves', () => {
  const cols = 30, rows = 20, a = new Float32Array(cols * rows), b = new Float32Array(cols * rows), c = new Float32Array(cols * rows);
  sampleTerrain(a, cols, rows, CELL, 1.5, { ox: 4, oy: 9 });
  sampleTerrain(b, cols, rows, CELL, 1.5, { ox: 4, oy: 9 });
  assert.deepEqual(a, b);
  sampleTerrain(c, cols, rows, CELL, 6, { ox: 4, oy: 9 });
  assert.notDeepEqual(a, c, 'the terrain drifts');
  for (const v of a) assert.ok(v >= 0 && v <= 1.01, `a quiet field stays in range: ${v}`);

  const hill = new Float32Array(cols * rows);
  sampleTerrain(hill, cols, rows, CELL, 1.5, { ox: 4, oy: 9, glow: { x: 150, y: 100, a: 1 } });
  const at = (f, i, j) => f[j * cols + i];
  assert.ok(at(hill, 15, 10) > at(a, 15, 10) + 0.2, 'the hill rises under the pointer');
  assert.ok(Math.abs(at(hill, 0, 0) - at(a, 0, 0)) < 0.02, 'and fades far away (a Gaussian, so a trace remains at 180px)');
  const off = new Float32Array(cols * rows);
  sampleTerrain(off, cols, rows, CELL, 1.5, { ox: 4, oy: 9, glow: { x: 150, y: 100, a: 0 } });
  assert.deepEqual(off, a, 'an invisible pointer changes nothing');

  const wave = new Float32Array(cols * rows);
  sampleTerrain(wave, cols, rows, CELL, 1.5, { ox: 4, oy: 9, waves: [{ x: 150, y: 100, t: 1.0 }] });
  assert.notDeepEqual(wave, a, 'a fresh wave bends the terrain');
  const spent = new Float32Array(cols * rows);
  sampleTerrain(spent, cols, rows, CELL, 5, { ox: 4, oy: 9, waves: [{ x: 150, y: 100, t: 1.0 }] });
  const quiet = new Float32Array(cols * rows);
  sampleTerrain(quiet, cols, rows, CELL, 5, { ox: 4, oy: 9 });
  assert.deepEqual(spent, quiet, 'a wave older than its life no longer counts');
});

test('a flat field outside every level traces nothing', () => {
  const low = grid(8, 8, () => 0), high = grid(8, 8, () => 1), minor = sink(), major = sink();
  traceContours(low, 8, 8, CELL, LEVELS, minor, major);
  traceContours(high, 8, 8, CELL, LEVELS, minor, major);
  assert.equal(minor.segs.length + major.segs.length, 0);
});

test('a ramp crossing one level draws one straight line at the interpolated position', () => {
  const cols = 6, rows = 4, lv = levelValue(2); // level 2 is a minor line (only every 4th is major)
  // Rises left to right so the line is vertical; put the level exactly a quarter of the way through column 2.
  const f = grid(cols, rows, (i) => (i < 2 ? lv - 0.05 : i === 2 ? lv - 0.01 : lv + 0.03));
  const minor = sink(), major = sink();
  traceContours(f, cols, rows, CELL, LEVELS, minor, major);
  assert.equal(major.segs.length, 0, 'a minor level never lands in the major sink');
  assert.equal(minor.segs.length, rows - 1, 'one segment per row of cells');
  for (const [x1, , x2] of minor.segs) { assert.ok(x1 > 2 * CELL && x1 < 3 * CELL, `x ${x1} lies in the crossing cell`); assert.ok(Math.abs(x1 - x2) < 1e-6, 'and the line is vertical'); }
  const expected = 2 * CELL + ((lv - (lv - 0.01)) / (lv + 0.03 - (lv - 0.01))) * CELL;
  assert.ok(Math.abs(minor.segs[0][0] - expected) < 1e-3, `interpolated to ${expected}, got ${minor.segs[0][0]}`);
});

test('every fourth level is heavier', () => {
  for (const [l, heavy] of [[1, false], [2, false], [3, false], [4, true], [8, true], [12, true], [5, false]]) {
    const lv = levelValue(l), f = grid(4, 3, (i) => (i < 2 ? lv - 0.02 : lv + 0.02)), minor = sink(), major = sink();
    traceContours(f, 4, 3, CELL, LEVELS, minor, major);
    assert.equal(major.segs.length > 0, heavy, `level ${l}`);
    assert.equal(minor.segs.length > 0, !heavy, `level ${l}`);
  }
});

test('saddle cells draw two segments and closed shapes stay inside their grid', () => {
  const lv = levelValue(3), hi = lv + 0.05, lo = lv - 0.05;
  const saddle = new Float32Array([hi, lo, lo, hi]); // top-left and bottom-right above the level
  const minor = sink(), major = sink();
  traceContours(saddle, 2, 2, CELL, LEVELS, minor, major);
  assert.equal(minor.segs.length, 2);

  const cols = 24, rows = 18, peak = grid(cols, rows, (i, j) => 0.9 - Math.hypot(i - 12, j - 9) * 0.06), m2 = sink(), M2 = sink();
  traceContours(peak, cols, rows, CELL, LEVELS, m2, M2);
  assert.ok(m2.segs.length + M2.segs.length > 20, 'a hill draws several rings');
  for (const [x1, y1, x2, y2] of [...m2.segs, ...M2.segs]) {
    for (const v of [x1, x2]) assert.ok(v >= 0 && v <= (cols - 1) * CELL + 1e-6);
    for (const v of [y1, y2]) assert.ok(v >= 0 && v <= (rows - 1) * CELL + 1e-6);
  }
});

test('tracing a drifting terrain at dialog size stays cheap and finite', () => {
  const w = 520, h = 560, cols = Math.ceil(w / CELL) + 1, rows = Math.ceil(h / CELL) + 1, f = new Float32Array(cols * rows), minor = sink(), major = sink();
  sampleTerrain(f, cols, rows, CELL, 2, { ox: 10, oy: 20, glow: { x: 200, y: 200, a: 1 } });
  traceContours(f, cols, rows, CELL, LEVELS, minor, major);
  const all = [...minor.segs, ...major.segs];
  assert.ok(all.length > 200, `plenty of lines: ${all.length}`);
  assert.ok(all.length < cols * rows * 3, 'and bounded by the grid');
  assert.ok(all.every((s) => s.every(Number.isFinite)));
});

test('the page corner fades from 1% to 60% of the page width and is gone beyond', () => {
  const width = 1600, near = FADE.from * width, far = FADE.to * width;
  assert.equal(FADE.from, 0.01); assert.equal(FADE.to, 0.6);
  assert.equal(cornerFade(0, width), 1, 'full strength in the corner itself');
  assert.equal(cornerFade(near, width), 1, 'and up to 1% of the width');
  assert.equal(cornerFade(far, width), 0, 'nothing at 60% of the width');
  assert.equal(cornerFade(far + 1, width), 0); assert.equal(cornerFade(width * 2, width), 0, 'and nothing past it');
  assert.ok(Math.abs(cornerFade((near + far) / 2, width) - 0.5) < 1e-9, 'halfway between the two is half strength');
  let last = 1;
  for (let d = near; d <= far; d += 5) { const f = cornerFade(d, width); assert.ok(f <= last + 1e-12 && f >= 0 && f <= 1, `fade never rises: ${d}px -> ${f}`); last = f; }
  assert.ok(Math.abs(cornerFade(0.18 * 800, 800) - cornerFade(0.18 * 1600, 1600)) < 1e-9, 'the fade scales with the page');
  assert.equal(cornerFade(0.6 * 800, 800), 0, 'the same fractions apply on a narrower page');
});

test('the corner mask is a radial gradient from the bottom-left with the same two radii', () => {
  const mask = cornerMask(1600);
  assert.match(mask, /^radial-gradient\(circle at 0 100%, #000 16px, transparent 960px\)$/);
  assert.match(cornerMask(1366), /#000 13\.7px, transparent 819\.6px/, 'radii follow the page width');
});

test('the corner entrance starts at the corner and has to reach the far side', () => {
  const w = 560, h = 400;
  assert.equal(revealRadiusFrom(w, h, 0, true), 0); assert.equal(revealRadius(w, h, 0), 0);
  assert.ok(revealRadiusFrom(w, h, 1, true) >= Math.hypot(w, h), 'a circle at the corner covers the opposite corner');
  assert.ok(revealRadiusFrom(w, h, 1, true) > revealRadiusFrom(w, h, 1, false), 'more than the centred circle');
  assert.equal(revealRadius(w, h, 0.5), revealRadiusFrom(w, h, 0.5, false), 'the centred reveal is unchanged');
});

test('extra flow shifts the drift without a jump, and the corner is as strong as a dialog', () => {
  const a = new Float32Array(30 * 20), b = new Float32Array(30 * 20), c = new Float32Array(30 * 20);
  sampleTerrain(a, 30, 20, CELL, 5); sampleTerrain(b, 30, 20, CELL, 0, { flow: 5 }); sampleTerrain(c, 30, 20, CELL, 0);
  assert.deepEqual([...b], [...a], 'flow adds to the drift clock exactly like elapsed time');
  assert.notDeepEqual([...c], [...a], 'and the drift really does move the terrain');
  const d = new Float32Array(30 * 20); sampleTerrain(d, 30, 20, CELL, 2.5, { flow: 0 });
  const e = new Float32Array(30 * 20); sampleTerrain(e, 30, 20, CELL, 2.5, { flow: 0.001 });
  assert.ok([...d].every((v, i) => Math.abs(v - e[i]) < 0.01), 'a small change of flow moves the terrain a little, never in a jump');
  assert.equal(AMBIENT_STRENGTH, 1, 'the corner is as strong as a dialog: 25% of the card');
});
