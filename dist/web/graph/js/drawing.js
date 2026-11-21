// drawing.js — the Drawing node and its floating drawing pane.
//
// You draw with the mouse (or a pen) in a resizable pane; the strokes are stored in
// the node's properties, so they save with the graph and travel in a share link.
// The node renders them on the GPU into its own IMAGE output.
//
// Two modes:
//   still    every stroke, complete. Draw a line and it's there.
//   animate  strokes draw on over a clip of `length` seconds that loops (or holds).
//            `speed` scales how fast the pen moves through the clip — a pin, so it
//            can be driven — and `draw on` picks what is visible behind the pen:
//              whole line  everything drawn so far
//              segment     only the last `segment` of it: a moving comet, the thing
//                          to feed into a feedback / trails node
//            `timing` decides where each stroke sits in the clip:
//              as drawn    when you actually drew it. Play the graph and draw: the
//                          pen is recorded against the clip, and at the end of the
//                          clip everything clears and replays on the beat you drew
//                          it — overdub more strokes on every pass, like a looper.
//              together    every stroke draws on over the whole clip at once
//              one by one  strokes draw on in order, sharing the clip
//
// Rendering: each stroke is a list of capsule segments with an SDF edge (softness is
// the SDF falloff). A stroke is first rasterised into a scratch texture with MAX
// blending — so a translucent stroke doesn't darken where its own segments overlap —
// then composited over the result, premultiplied. Stroke N+1 therefore lies on top
// of stroke N the way paint does.
import { RT } from './runtime.js';

const LG = window.LiteGraph;
const IMG = 'IMAGE';

export const DRAWING_TYPE = 'input/drawing';

const DEFAULTS = {
  mode: 'still', drawOn: 'whole line', timing: 'as drawn',
  length: 4, speed: 1, segment: 0.15, loop: true, background: 'black',
  color: '#ffffff', width: 12, softness: 0.3, opacity: 1,
  // brush character — captured onto each stroke as it's drawn, like colour and width
  brush: 'line', scatter: 1.5, dotSize: 0.35, density: 2,
  hueJit: 0, satJit: 0, valJit: 0,
  speedWidth: 'off', speedAmt: 0.6,
};
const BACKGROUNDS = { black: [0, 0, 0, 1], transparent: [0, 0, 0, 0], white: [1, 1, 1, 1] };
const SPEED_MODES = ['off', 'fast = thin', 'fast = thick'];
// node widget label for each property that isn't simply its own name
const LABELS = {
  drawOn: 'draw on', length: 'length (s)', dotSize: 'dot size', hueJit: 'hue jitter',
  satJit: 'sat jitter', valJit: 'val jitter', speedWidth: 'speed → width', speedAmt: 'speed amount',
};
const label = (k) => LABELS[k] || k;
// Brush width is in pixels of a 1024px frame, so a drawing keeps its look when the
// render size changes.
const REF = 1024;

const hexRgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};
const round4 = (v) => Math.round(v * 10000) / 10000;
const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ── brush character: scatter, colour jitter, speed → width ──────────────────────
// Everything random is a hash of (stroke seed, index), not Math.random(), so a
// stroke's dots and colours are identical every frame and on every reload.
function rnd(seed, i, k) {
  let h = (seed * 374761393 + i * 668265263 + k * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
function rgb2hsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return [h, mx > 1e-6 ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
// j = [hue, sat, val] jitter amounts, 0..1 each. Hue swings up to half a turn.
function jitter(rgb, j, seed, i) {
  if (!j || !(j[0] || j[1] || j[2])) return rgb;
  const [h, s, v] = rgb2hsv(rgb);
  return hsv2rgb(
    ((h + (rnd(seed, i, 11) - 0.5) * j[0]) % 1 + 1) % 1,
    clamp01(s + (rnd(seed, i, 12) - 0.5) * 2 * j[1]),
    clamp01(v + (rnd(seed, i, 13) - 0.5) * 2 * j[2]));
}
// Width multiplier at point i from the pen speed recorded there (frame heights per
// second). st.sm > 0: faster is thinner, like ink; st.sm < 0: faster is thicker.
function speedFactor(st, i) {
  const a = +st.sm || 0;
  if (!a || !st.v || !st.v.length) return 1;
  const v = +st.v[Math.min(i, st.v.length - 1)] || 0, n = v / (v + 1.2);
  return a > 0 ? Math.max(0.06, 1 - a * n * 1.1) : 1 - a * n * 2.2;
}

// ── GPU stroke renderer ────────────────────────────────────────────────────────
// One instance per capsule: endpoints, colour + alpha, radius. A dot is a capsule
// whose ends coincide, so scatter strokes go through the same pipe.
const SEG_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aSeg;        // p0.xy, p1.xy in target pixels
layout(location = 1) in vec4 aCol;        // rgb + alpha
layout(location = 2) in float aRad;       // radius in pixels
uniform vec2 uRes;
out vec2 vP; flat out vec4 vSeg; flat out vec4 vCol; flat out float vRad;
void main(){
  vec2 C[6] = vec2[6](vec2(0,0), vec2(1,0), vec2(0,1), vec2(0,1), vec2(1,0), vec2(1,1));
  vec2 c = C[gl_VertexID];
  vec2 a = aSeg.xy, b = aSeg.zw, d = b - a;
  float L = length(d);
  vec2 t = L > 1e-5 ? d / L : vec2(1.0, 0.0), n = vec2(-t.y, t.x);
  float R = aRad + 1.5;                    // +AA fringe
  vec2 p = mix(a - t * R, b + t * R, c.x) + n * mix(-R, R, c.y);
  vP = p; vSeg = aSeg; vCol = aCol; vRad = aRad;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;
const SEG_FRAG = `#version 300 es
precision highp float;
in vec2 vP; flat in vec4 vSeg; flat in vec4 vCol; flat in float vRad; out vec4 o;
uniform float uSoft;
void main(){
  vec2 pa = vP - vSeg.xy, ba = vSeg.zw - vSeg.xy;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * h);
  float inner = min(vRad * (1.0 - uSoft), vRad - 1.0);
  float a = (1.0 - smoothstep(inner, vRad + 0.5, d)) * vCol.a;
  o = vec4(vCol.rgb * a, a);               // premultiplied
}`;
const FS_VERT = `#version 300 es
precision highp float; out vec2 vUv;
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv = p; gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;
const FS_FRAG = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uColor;
void main(){ o = texture(uColor, vUv); }`;

const STRIDE = 9;   // floats per instance: x0 y0 x1 y1 r g b a radius

let G = null;   // per-page GL objects, built on first render
function gpu() {
  const engine = RT.engine, gl = engine.gl;
  if (G && G.gl === gl) return G;
  const vao = gl.createVertexArray(), buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  for (let a = 0; a < 3; a++) { gl.enableVertexAttribArray(a); gl.vertexAttribDivisor(a, 1); }
  gl.bindVertexArray(null);
  G = { gl, vao, buf, cap: 0, fbo: gl.createFramebuffer() };
  return G;
}

// strokes: [{ soft, over, data: Float32Array (STRIDE floats per capsule) }]
//   over = false  a line: rasterised alone with MAX blending (one even opacity
//                 however its capsules overlap), then composited over the result
//   over = true   scatter dots: each dot is laid straight over what's there, so
//                 overlapping dots build up and keep their own colours
function renderStrokes(outTex, tmpTex, w, h, bg, strokes) {
  const engine = RT.engine, gl = engine.gl, g = gpu();
  const segProg = engine.ensureProgram('__drawSeg2', SEG_VERT, SEG_FRAG);
  const cpProg = engine.ensureProgram('__drawCopy', FS_VERT, FS_FRAG);
  const loc = (info, n) => engine._loc(info, n);

  // one upload for the whole frame; each stroke is drawn from its own offset
  let total = 0;
  for (const s of strokes) total += s.data.length;
  const data = new Float32Array(Math.max(STRIDE, total));
  const offs = [];
  let o = 0;
  for (const s of strokes) { offs.push(o); data.set(s.data, o); o += s.data.length; }
  gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
  if (data.byteLength > g.cap) { g.cap = data.byteLength * 2; gl.bufferData(gl.ARRAY_BUFFER, g.cap, gl.DYNAMIC_DRAW); }
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);

  gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo);
  gl.viewport(0, 0, w, h);
  const target = (tex) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  target(outTex);
  gl.clearColor(bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const drawSegs = (i, n) => {
    gl.useProgram(segProg.prog);
    gl.bindVertexArray(g.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
    const base = offs[i] * 4, bytes = STRIDE * 4;
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, bytes, base);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, bytes, base + 16);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, bytes, base + 32);
    gl.uniform2f(loc(segProg, 'uRes'), w, h);
    gl.uniform1f(loc(segProg, 'uSoft'), strokes[i].soft);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
  };

  gl.enable(gl.BLEND);
  strokes.forEach((s, i) => {
    const n = s.data.length / STRIDE;
    if (!n) return;
    if (s.over) {
      target(outTex);
      gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawSegs(i, n);
      return;
    }
    // 1. the stroke alone, MAX-blended so it has one uniform opacity
    target(tmpTex);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
    drawSegs(i, n);
    // 2. composite it over everything so far (premultiplied "over")
    target(outTex);
    gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(cpProg.prog);
    gl.bindVertexArray(engine.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tmpTex);
    gl.uniform1i(loc(cpProg, 'uColor'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
  gl.disable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ── timing ─────────────────────────────────────────────────────────────────────
// Every point gets a key on the clip's 0..1 axis; the pen ("head") sweeps that axis
// and a point is visible when its key is inside the window behind the head.
// Arc-length keys are cached per stroke and recomputed when the stroke grows.
const arcCache = new WeakMap();
function arcKeys(st) {
  const p = st.p, n = p.length / 3;
  let c = arcCache.get(st);
  if (c && c.n === n) return c;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const dx = p[i * 3] - p[i * 3 - 3], dy = p[i * 3 + 1] - p[i * 3 - 2];
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  c = { n, cum, len: n ? cum[n - 1] : 0 };
  arcCache.set(st, c);
  return c;
}

// Visible geometry for one stroke, in target pixels: x0 y0 x1 y1 i per segment,
// where i is the index of the segment's first point.
function strokeSegs(st, keyOf, lo, hi, w, h) {
  const p = st.p, n = p.length / 3, out = [];
  const X = (i) => p[i * 3] * w, Y = (i) => (1 - p[i * 3 + 1]) * h;   // stored y-down, GL is y-up
  if (n === 1) {
    const k = keyOf(0);
    if (k >= lo && k <= hi) out.push(X(0), Y(0), X(0), Y(0), 0);
    return out;
  }
  for (let i = 0; i < n - 1; i++) {
    const k0 = keyOf(i), k1 = keyOf(i + 1);
    if (k1 < k0) continue;                        // the pen wrapped round the loop here
    let f0, f1;
    if (k1 === k0) { if (k0 < lo || k0 > hi) continue; f0 = 0; f1 = 1; }
    else {
      f0 = Math.max(0, Math.min(1, (lo - k0) / (k1 - k0)));
      f1 = Math.max(0, Math.min(1, (hi - k0) / (k1 - k0)));
      if (f1 <= f0) continue;
    }
    const x0 = X(i), y0 = Y(i), x1 = X(i + 1), y1 = Y(i + 1);
    out.push(x0 + (x1 - x0) * f0, y0 + (y1 - y0) * f0, x0 + (x1 - x0) * f1, y0 + (y1 - y0) * f1, i);
  }
  return out;
}

// Scatter: dots strewn along the stroke. Where they fall, how big and what colour
// depend only on the stroke and the render size, so they're cached; animation then
// just decides which are visible. Each dot: segment i, fraction f along it, offset
// (ox, oy) inside the unit disc, size factor, rgb.
const DOT = 8, MAX_DOTS = 40000;
const dotCache = new WeakMap();
function scatterDots(st, w, h, R) {
  const p = st.p, n = p.length / 3;
  const seed = st.r | 0, dn = Math.max(0.05, +st.dn || 2), rgb = hexRgb(st.c);
  const key = [n, w, h, R, dn, st.c, (st.j || []).join(',')].join('|');
  const hit = dotCache.get(st);
  if (hit && hit.key === key) return hit.dots;
  const out = [];
  const emit = (i, f, k) => {
    const a = rnd(seed, k, 3) * Math.PI * 2, r = Math.sqrt(rnd(seed, k, 4));
    const c = jitter(rgb, st.j, seed, k);
    out.push(i, f, Math.cos(a) * r, Math.sin(a) * r, 0.5 + rnd(seed, k, 5), c[0], c[1], c[2]);
  };
  if (n === 1) {
    for (let k = 0; k < Math.max(3, Math.ceil(dn * 4)); k++) emit(0, 0, k);
  } else {
    const sp = Math.max(0.75, 2 * R / dn);        // average spacing along the stroke, px
    let acc = 0, next = sp * rnd(seed, 0, 1), k = 0;
    for (let i = 0; i < n - 1 && k < MAX_DOTS; i++) {
      const L = Math.hypot((p[i * 3 + 3] - p[i * 3]) * w, (p[i * 3 + 4] - p[i * 3 + 1]) * h);
      while (L > 0 && next <= acc + L && k < MAX_DOTS) {
        emit(i, (next - acc) / L, k); k++;
        next += sp * (0.5 + rnd(seed, k, 2));
      }
      acc += L;
    }
  }
  const dots = new Float32Array(out);
  dotCache.set(st, { key, dots });
  return dots;
}

// One stroke → GPU instances, given which part of it is visible.
//   keyOf(i)  the point's position on the clip axis; lo..hi the visible window
function strokeInstances(st, keyOf, lo, hi, w, h, scale) {
  const seed = st.r | 0;
  const R = Math.max(0.5, (st.w || 1) * 0.5 * scale);
  const alpha = clamp01(st.o ?? 1), soft = clamp01(st.s ?? 0);
  if (!st.b) {
    // a line; colour jitter, if any, tints the whole stroke once
    const rgb = jitter(hexRgb(st.c), st.j, seed, 0);
    const segs = strokeSegs(st, keyOf, lo, hi, w, h), out = new Float32Array(segs.length / 5 * STRIDE);
    for (let s = 0, o = 0; s < segs.length; s += 5, o += STRIDE) {
      const i = segs[s + 4];
      const k = (speedFactor(st, i) + speedFactor(st, i + 1)) * 0.5;
      out[o] = segs[s]; out[o + 1] = segs[s + 1]; out[o + 2] = segs[s + 2]; out[o + 3] = segs[s + 3];
      out[o + 4] = rgb[0]; out[o + 5] = rgb[1]; out[o + 6] = rgb[2]; out[o + 7] = alpha;
      out[o + 8] = Math.max(0.5, R * k);
    }
    return { soft, over: false, data: out };
  }
  // scatter
  const p = st.p, n = p.length / 3;
  const dots = scatterDots(st, w, h, R);
  const spread = Math.max(0, +st.sc || 0), size = Math.max(0.02, +st.ds || 0.35);
  const X = (i) => p[i * 3] * w, Y = (i) => (1 - p[i * 3 + 1]) * h;
  const out = new Float32Array(dots.length / DOT * STRIDE);
  let o = 0;
  for (let d = 0; d < dots.length; d += DOT) {
    const i = dots[d], f = dots[d + 1], j = Math.min(i + 1, n - 1);
    const k0 = keyOf(i), k1 = keyOf(j);
    if (k1 < k0) continue;
    const key = k0 + (k1 - k0) * f;
    if (key < lo || key > hi) continue;
    const sf = speedFactor(st, i) * (1 - f) + speedFactor(st, j) * f;
    const Re = R * sf;
    const x = X(i) + (X(j) - X(i)) * f + dots[d + 2] * Re * spread;
    const y = Y(i) + (Y(j) - Y(i)) * f + dots[d + 3] * Re * spread;
    out[o] = x; out[o + 1] = y; out[o + 2] = x; out[o + 3] = y;
    out[o + 4] = dots[d + 5]; out[o + 5] = dots[d + 6]; out[o + 6] = dots[d + 7]; out[o + 7] = alpha;
    out[o + 8] = Math.max(0.35, Re * size * dots[d + 4]);
    o += STRIDE;
  }
  return { soft, over: true, data: out.subarray(0, o) };
}

// ── the node ───────────────────────────────────────────────────────────────────
// Widgets whose value can instead come from a number pin (right-click ▸ Input Modes).
const PINNABLE = {
  speed: ['slider', { min: 0, max: 4, step: 0.01 }],
  segment: ['slider', { min: 0.01, max: 1, step: 0.01 }],
};

export function registerDrawingNode(H) {
  function DrawingNode() {
    this.addOutput('out', IMG);
    this.addOutput('progress', 'number');
    this.addOutput('loop', 'number');
    this.properties = Object.assign({}, DEFAULTS, { strokes: [], pinModes: {} });
    const set = (k, redraw = true) => (v) => {
      this.properties[k] = v; if (redraw) this._dirty = true; RT.requestSave(); RT.redraw();
      if (pane.node === this) pane.sync();
    };
    this.addWidget('button', '✎ Open drawing pane', null, () => pane.open(this));
    this.addWidget('combo', 'mode', DEFAULTS.mode, set('mode'), { values: ['still', 'animate'] });
    this.addWidget('combo', 'draw on', DEFAULTS.drawOn, set('drawOn'), { values: ['whole line', 'segment'] });
    this.addWidget('combo', 'timing', DEFAULTS.timing, set('timing'), { values: ['as drawn', 'together', 'one by one'] });
    this.addWidget('number', 'length (s)', DEFAULTS.length, (v) => set('length')(Math.max(0.1, v)), { min: 0.1, max: 600, step: 0.5, precision: 2 });
    for (const k in PINNABLE) this._addPinnableWidget(k);
    this.addWidget('toggle', 'loop', DEFAULTS.loop, set('loop'));
    this.addWidget('combo', 'background', DEFAULTS.background, set('background'), { values: Object.keys(BACKGROUNDS) });
    this.addWidget('text', 'color', DEFAULTS.color, set('color', false));
    this.addWidget('slider', 'width', DEFAULTS.width, set('width', false), { min: 1, max: 200, step: 0.5 });
    this.addWidget('slider', 'softness', DEFAULTS.softness, set('softness', false), { min: 0, max: 1, step: 0.01 });
    this.addWidget('slider', 'opacity', DEFAULTS.opacity, set('opacity', false), { min: 0.01, max: 1, step: 0.01 });
    // brush character (applies to strokes drawn from now on — or use right-click ▸
    // Apply brush to all strokes)
    this.addWidget('combo', 'brush', DEFAULTS.brush, set('brush', false), { values: ['line', 'scatter'] });
    this.addWidget('slider', 'scatter', DEFAULTS.scatter, set('scatter', false), { min: 0, max: 6, step: 0.05 });
    this.addWidget('slider', label('dotSize'), DEFAULTS.dotSize, set('dotSize', false), { min: 0.05, max: 1.5, step: 0.01 });
    this.addWidget('slider', 'density', DEFAULTS.density, set('density', false), { min: 0.2, max: 10, step: 0.1 });
    this.addWidget('slider', label('hueJit'), DEFAULTS.hueJit, set('hueJit', false), { min: 0, max: 1, step: 0.01 });
    this.addWidget('slider', label('satJit'), DEFAULTS.satJit, set('satJit', false), { min: 0, max: 1, step: 0.01 });
    this.addWidget('slider', label('valJit'), DEFAULTS.valJit, set('valJit', false), { min: 0, max: 1, step: 0.01 });
    this.addWidget('combo', label('speedWidth'), DEFAULTS.speedWidth, set('speedWidth', false), { values: SPEED_MODES });
    this.addWidget('slider', label('speedAmt'), DEFAULTS.speedAmt, set('speedAmt', false), { min: 0, max: 1, step: 0.01 });
    this.addWidget('button', '↶ undo stroke', null, () => this.undo());
    this.addWidget('button', '✕ clear all strokes', null, () => this.clearStrokes());
    this._size = { width: RT.RENDER_SIZE, height: RT.RENDER_SIZE };
    this._clock = 0; this._head = 0; this._ver = 0; this._dirty = true;
    H.attachThumb(this); H.sizeWithThumb(this);
  }
  DrawingNode.title = 'Drawing';

  const P = DrawingNode.prototype;

  P._addPinnableWidget = function (k) {
    const [kind, opts] = PINNABLE[k];
    const w = this.addWidget(kind, k, this.properties[k] ?? DEFAULTS[k], (v) => {
      this.properties[k] = v; this._dirty = true; RT.requestSave(); RT.redraw();
    }, opts);
    w._drawKey = k;
  };

  P._resize = function () {
    this.size = this.computeSize();
    if (this.size[0] < 230) this.size[0] = 230;
    this.size[1] += H.THUMB_H;
  };

  P._togglePin = function (k) {
    const modes = this.properties.pinModes = this.properties.pinModes || {};
    if (modes[k] === 'pin') {
      modes[k] = 'slider';
      const idx = (this.inputs || []).findIndex((s) => s._drawKey === k);
      if (idx >= 0) { this.disconnectInput(idx); this.removeInput(idx); }
      this._addPinnableWidget(k);
    } else {
      modes[k] = 'pin';
      const wIdx = (this.widgets || []).findIndex((w) => w._drawKey === k);
      if (wIdx >= 0) this.widgets.splice(wIdx, 1);
      this.addInput(k, 'number');
      this.inputs[this.inputs.length - 1]._drawKey = k;
    }
    this._resize(); this._dirty = true; RT.requestSave(); RT.redraw();
  };

  P._pinned = function (k) {
    if ((this.properties.pinModes || {})[k] !== 'pin') return this.properties[k];
    const idx = (this.inputs || []).findIndex((s) => s._drawKey === k);
    const v = idx >= 0 ? this.getInputData(idx) : undefined;
    return (typeof v === 'number' && !isNaN(v)) ? v : this.properties[k];
  };

  P.onConfigure = function () {
    const p = this.properties;
    for (const k in DEFAULTS) if (p[k] === undefined) p[k] = DEFAULTS[k];
    if (!Array.isArray(p.strokes)) p.strokes = [];
    for (const w of this.widgets || []) {
      const key = Object.keys(DEFAULTS).find((k) => label(k) === w.name);
      if (key) w.value = p[key];
    }
    const modes = p.pinModes = p.pinModes || {};
    for (const k in PINNABLE) {
      if (modes[k] === 'pin') {
        const wIdx = (this.widgets || []).findIndex((w) => w._drawKey === k);
        if (wIdx >= 0) this.widgets.splice(wIdx, 1);
        const inp = (this.inputs || []).find((s) => s.name === k && s.type === 'number');
        if (inp) inp._drawKey = k;
      }
    }
    this._size = H.nodeRenderSize(this);
    this._ver++; this._dirty = true;
    // drawings saved before the brush widgets existed are too short for them
    const min = this.computeSize()[1] + H.THUMB_H;
    if (this.size[1] < min) this.size[1] = min;
  };

  P.onRemoved = function () {
    if (pane.node === this) pane.close();
    const gl = RT.engine && RT.engine.gl;
    if (gl && this._tmp) gl.deleteTexture(this._tmp.tex);
  };

  P.onDblClick = function () { pane.open(this); };

  // Called by Sequence → Video before it captures, so an export starts at the top
  // of the clip no matter where the live playhead happened to be.
  P.resetClip = function () { this._clock = 0; this._head = 0; this._dirty = true; };
  P.clipLength = function () { return Math.max(0.1, +this.properties.length || DEFAULTS.length); };

  P.undo = function () {
    if (!this.properties.strokes.length) return;
    this.properties.strokes.pop(); this._ver++; this._dirty = true; RT.requestSave(); RT.redraw();
  };
  P.clearStrokes = function () {
    if (!this.properties.strokes.length) return;
    this.properties.strokes = []; this._ver++; this._dirty = true; RT.requestSave(); RT.redraw();
  };

  // Pen timing. Playing: the clip's own head, so strokes land where you drew them.
  // Paused: the head doesn't move, so the stroke gets its internal timing from the
  // wall clock instead (at the current speed) and starts wherever the head is parked.
  P._stamp = function () {
    if (RT.playing || !this._penT0) return this._head;
    const speed = Math.max(0, +this._pinned('speed') || 0);
    return this._head + (performance.now() - this._penT0) / 1000 * speed / this.clipLength();
  };
  // The node's current brush character, as the fields a stroke stores. Only what
  // differs from a plain line is written, so ordinary strokes stay small in a link.
  P._brushFields = function () {
    const p = this.properties, f = {};
    if (p.brush === 'scatter') { f.b = 1; f.sc = round3(+p.scatter || 0); f.ds = round3(+p.dotSize || 0.35); f.dn = round3(+p.density || 2); }
    const j = [+p.hueJit || 0, +p.satJit || 0, +p.valJit || 0];
    if (j[0] || j[1] || j[2]) f.j = j.map(round3);
    const amt = +p.speedAmt || 0;
    if (p.speedWidth === 'fast = thin' && amt) f.sm = round3(amt);
    else if (p.speedWidth === 'fast = thick' && amt) f.sm = -round3(amt);
    return f;
  };
  // tMs is the pointer event's timestamp — it's what pen speed is measured against
  P.beginStroke = function (x, y, tMs) {
    const p = this.properties;
    this._penT0 = performance.now();
    this._penLast = tMs || performance.now(); this._penV = 0;
    const st = Object.assign({ c: p.color, w: +p.width, s: +p.softness, o: +p.opacity,
      r: Math.floor(Math.random() * 1e6), p: [round4(x), round4(y), round4(this._head)], v: [0] }, this._brushFields());
    p.strokes.push(st);
    this._pen = st; this._ver++; this._dirty = true;
    return st;
  };
  P.extendStroke = function (x, y, tMs) {
    const st = this._pen; if (!st) return;
    const n = st.p.length;
    const dx = (x - st.p[n - 3]) * this._size.width, dy = (y - st.p[n - 2]) * this._size.height;
    if (dx * dx + dy * dy < 0.5) return;           // under half a pixel: noise
    st.p.push(round4(x), round4(y), round4(this._stamp()));
    // Pen speed in frame heights per second, smoothed so one jittery event doesn't
    // pinch the line. Recorded on every stroke, so speed → width can be applied later.
    const now = tMs || performance.now();
    const dt = Math.max(1, now - (this._penLast || now)) / 1000;
    const inst = Math.hypot(dx, dy) / Math.max(1, Math.min(this._size.width, this._size.height)) / dt;
    this._penV = this._penV ? this._penV * 0.65 + inst * 0.35 : inst;
    this._penLast = now;
    if (!Array.isArray(st.v)) st.v = [];
    while (st.v.length < n / 3) st.v.push(0);
    st.v.push(Math.round(this._penV * 100) / 100);
    this._ver++; this._dirty = true;
  };
  // Re-brush everything already drawn with the current settings — all but colour,
  // so a many-coloured drawing keeps its colours.
  P.applyBrushToAll = function () {
    const p = this.properties, f = this._brushFields();
    for (const st of p.strokes) {
      for (const k of ['b', 'sc', 'ds', 'dn', 'j', 'sm']) delete st[k];
      Object.assign(st, { w: +p.width, s: +p.softness, o: +p.opacity }, f);
      if (st.r === undefined) st.r = Math.floor(Math.random() * 1e6);
    }
    this._ver++; this._dirty = true; RT.requestSave(); RT.redraw();
  };
  P.endStroke = function () { if (!this._pen) return; this._pen = null; this._penT0 = 0; RT.requestSave(); RT.redraw(); };

  P._visibleStrokes = function (w, h) {
    const p = this.properties, strokes = p.strokes;
    const scale = Math.min(w, h) / REF;
    const out = [];
    const add = (st, keyOf, lo, hi) => {
      const s = strokeInstances(st, keyOf, lo, hi, w, h, scale);
      if (s.data.length) out.push(s);
    };
    if (p.mode !== 'animate') {
      for (const st of strokes) add(st, () => 0, -1, 1);
      return out;
    }
    const seg = Math.max(0.001, +this._pinned('segment') || 0);
    const segment = p.drawOn === 'segment';
    let head = this._head;
    // With arc-length timing the tail should also have left the frame by the end of
    // the clip, so the head runs to 1 + seg instead of 1.
    if (segment && p.timing !== 'as drawn') head *= 1 + seg;
    const lo = segment ? head - seg : -Infinity, hi = head;

    let total = 0, before = 0;
    if (p.timing === 'one by one') for (const st of strokes) total += arcKeys(st).len;
    for (const st of strokes) {
      let keyOf;
      if (p.timing === 'as drawn') keyOf = (i) => st.p[i * 3 + 2];
      else {
        const a = arcKeys(st);
        if (p.timing === 'together') keyOf = a.len > 0 ? (i) => a.cum[i] / a.len : () => 0;
        else { const b = before; keyOf = total > 0 ? (i) => (b + a.cum[i]) / total : () => 0; before += a.len; }
      }
      add(st, keyOf, lo, hi);
    }
    return out;
  };

  P.evaluate = function () {
    const p = this.properties;
    const len = this.clipLength();
    const speed = Math.max(0, +this._pinned('speed') || 0);
    // The clip clock runs in every mode (so "as drawn" strokes can be recorded while
    // still), wraps at `length` — clearing everything so it draws on again — or holds
    // at the end with loop off. The wrap is checked before stepping, so a Sequence
    // render of exactly length × fps frames ends on the finished drawing and loops.
    if (RT.advance) {
      if (this._clock >= len - 1e-6 && p.loop) { this._clock = 0; this._head = 0; }
      if (this._clock < len - 1e-6) { this._clock = Math.min(len, this._clock + (RT.dt || 0)); this._head += (RT.dt || 0) * speed / len; }
    }
    this._size = H.nodeRenderSize(this);
    const { width: w, height: h } = this._size;
    const animKey = p.mode === 'animate'
      ? [this._head.toFixed(5), p.drawOn, p.timing, this._pinned('segment')].join('|') : '';
    const key = [this._ver, w, h, p.mode, p.background, animKey].join('|');
    if (this._dirty || key !== this._key) {
      H.ensureOut(this);
      if (!this._tmp || this._tmp.w !== w || this._tmp.h !== h) {
        if (this._tmp) RT.engine.gl.deleteTexture(this._tmp.tex);
        this._tmp = { tex: RT.engine.allocTexture(w, h), w, h };
      }
      renderStrokes(this._out.tex, this._tmp.tex, w, h, BACKGROUNDS[p.background] || BACKGROUNDS.black, this._visibleStrokes(w, h));
      this._out.version++;
      this._key = key; this._dirty = false;
    }
    this.setOutputData(0, this._out);
    this.setOutputData(1, Math.min(1, this._head));
    this.setOutputData(2, this._clock / len);
  };

  P.getExtraMenuOptions = function () {
    const node = this, modes = this.properties.pinModes || {};
    const current = this._size || H.nodeRenderSize(this);
    return [{
      content: '✎ Open drawing pane', callback: () => pane.open(node),
    }, {
      content: 'Render size: ' + current.width + ' × ' + current.height,
      has_submenu: true,
      callback: function (_v, _opts, e, menu) {
        new LG.ContextMenu(['default', '512 × 512', '1024 × 1024', '1920 × 1080', '1080 × 1920', '2048 × 2048', 'custom…'], {
          event: e, parentMenu: menu, callback: function (val) {
            if (val === 'default') { delete node.properties.renderWidth; delete node.properties.renderHeight; }
            else {
              let m = String(val).match(/(\d+)\s*[×x]\s*(\d+)/i);
              if (String(val).startsWith('custom')) m = String(prompt('Render size (width x height):', current.width + 'x' + current.height) || '').match(/(\d+)\s*[×x]\s*(\d+)/i);
              if (!m || +m[1] < 64 || +m[2] < 64) return;
              node.properties.renderWidth = +m[1]; node.properties.renderHeight = +m[2];
            }
            node._dirty = true; RT.requestSave(); RT.redraw();
          },
        });
      },
    }, {
      content: 'Input Modes',
      has_submenu: true,
      callback: function (_v, _opts, e, menu) {
        const sub = Object.keys(PINNABLE).map((k) => {
          const isPin = modes[k] === 'pin';
          return { content: (isPin ? '● ' : '○ ') + k + (isPin ? '  (pin)' : '  (slider)'), callback: () => node._togglePin(k) };
        });
        new LG.ContextMenu(sub, { event: e, parentMenu: menu, title: 'Input Modes' });
      },
    }, {
      content: '↺ Restart clip', callback: () => { node.resetClip(); RT.redraw(); },
    }, {
      content: '✱ Apply brush to all strokes (keeps colours)', callback: () => node.applyBrushToAll(),
    }];
  };

  LG.registerNodeType(DRAWING_TYPE, DrawingNode);
}

// ── the drawing pane ───────────────────────────────────────────────────────────
// One floating, resizable window, attached to whichever Drawing node opened it. It
// shows that node's live output, letterboxed to its render aspect, and turns mouse /
// pen drags into strokes. Its geometry is remembered per browser.
const PANE_KEY = 'forge.drawPane';
const pane = {
  node: null, ui: null, unhook: null,

  build() {
    if (this.ui) return this.ui;
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;z-index:60;display:none;flex-direction:column;background:#15181d;'
      + 'border:1px solid #262b33;border-radius:8px;box-shadow:0 10px 40px #000a;resize:both;overflow:hidden;'
      + 'min-width:280px;min-height:220px;font:12px -apple-system,Segoe UI,sans-serif;color:#e6e8ea;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #262b33;'
      + 'cursor:move;user-select:none;flex-wrap:wrap;';
    const title = document.createElement('span');
    title.style.cssText = 'color:#8a929c;letter-spacing:1px;text-transform:uppercase;font-size:10px;margin-right:auto;';
    const mkBtn = (label, tip) => {
      const b = document.createElement('button'); b.textContent = label; b.title = tip;
      b.style.cssText = 'background:#1c2028;color:#e6e8ea;border:1px solid #262b33;border-radius:5px;padding:3px 8px;cursor:pointer;font-size:12px;';
      return b;
    };
    const mkRange = (label, min, max, step) => {
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;align-items:center;gap:4px;color:#8a929c;font-size:10px;text-transform:uppercase;';
      const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step;
      r.style.cssText = 'width:64px;';
      l.append(label, r);
      return { l, r };
    };
    const color = document.createElement('input'); color.type = 'color'; color.title = 'Brush colour';
    color.style.cssText = 'width:26px;height:22px;padding:0;border:1px solid #262b33;background:none;cursor:pointer;';
    const width = mkRange('W', 1, 200, 0.5), soft = mkRange('Soft', 0, 1, 0.01), opac = mkRange('Op', 0.01, 1, 0.01);
    const ghost = document.createElement('label');
    ghost.style.cssText = 'display:flex;align-items:center;gap:3px;color:#8a929c;font-size:10px;text-transform:uppercase;';
    const ghostBox = document.createElement('input'); ghostBox.type = 'checkbox'; ghostBox.checked = true;
    ghost.append(ghostBox, 'Ghost'); ghost.title = 'In animate mode, show every stroke faintly so you can see what you drew';
    const undo = mkBtn('↶', 'Undo stroke (Ctrl+Z)'), clear = mkBtn('Clear', 'Clear all strokes'), close = mkBtn('✕', 'Close');
    bar.append(title, color, width.l, soft.l, opac.l, ghost, undo, clear, close);
    // second row: brush character — scatter dots, colour jitter, speed → width
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid #262b33;'
      + 'user-select:none;flex-wrap:wrap;';
    const mkSelect = (opts, tip) => {
      const el = document.createElement('select'); el.title = tip;
      el.style.cssText = 'background:#1c2028;color:#e6e8ea;border:1px solid #262b33;border-radius:5px;padding:2px 4px;font-size:11px;';
      for (const o of opts) { const op = document.createElement('option'); op.value = op.textContent = o; el.appendChild(op); }
      return el;
    };
    const brushSel = mkSelect(['line', 'scatter'], 'Brush: a solid line, or a scatter of little dots');
    const spread = mkRange('Spread', 0, 6, 0.05), dot = mkRange('Dot', 0.05, 1.5, 0.01), dens = mkRange('Dens', 0.2, 10, 0.1);
    const jh = mkRange('H±', 0, 1, 0.01), js = mkRange('S±', 0, 1, 0.01), jv = mkRange('V±', 0, 1, 0.01);
    for (const r of [spread, dot, dens, jh, js, jv]) r.r.style.width = '50px';
    jh.l.title = 'Random hue shift (per dot when scattering, per stroke for a line)';
    js.l.title = 'Random saturation shift'; jv.l.title = 'Random brightness shift';
    const speedSel = mkSelect(SPEED_MODES, 'Pen speed → line width');
    const speedAmt = mkRange('Amt', 0, 1, 0.01); speedAmt.r.style.width = '50px';
    row2.append(brushSel, spread.l, dot.l, dens.l, jh.l, js.l, jv.l, speedSel, speedAmt.l);
    const area = document.createElement('div');
    area.style.cssText = 'flex:1;position:relative;background:#0a0c0f;min-height:0;';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:none;touch-action:none;';
    canvas.tabIndex = 0;
    area.append(canvas);
    root.append(bar, row2, area);
    document.body.appendChild(root);
    this.ui = { root, bar, title, color, width: width.r, soft: soft.r, opac: opac.r, ghost: ghostBox, canvas, ctx: canvas.getContext('2d'),
      brush: brushSel, scatter: spread.r, dotSize: dot.r, density: dens.r, hueJit: jh.r, satJit: js.r, valJit: jv.r,
      speedWidth: speedSel, speedAmt: speedAmt.r, scatterBits: [spread.l, dot.l, dens.l] };

    // brush controls write straight through to the node (and its widgets)
    const brush = (k, el, conv) => el.addEventListener('input', () => {
      const n = this.node; if (!n) return;
      n.properties[k] = conv(el.value);
      const w = (n.widgets || []).find((x) => x.name === label(k)); if (w) w.value = n.properties[k];
      if (k === 'brush') this.sync();
      RT.requestSave(); RT.redraw();
    });
    brush('color', color, (v) => v);
    brush('width', width.r, Number); brush('softness', soft.r, Number); brush('opacity', opac.r, Number);
    brush('brush', brushSel, (v) => v); brush('speedWidth', speedSel, (v) => v);
    for (const k of ['scatter', 'dotSize', 'density', 'hueJit', 'satJit', 'valJit', 'speedAmt']) brush(k, this.ui[k], Number);
    undo.onclick = () => this.node && this.node.undo();
    clear.onclick = () => this.node && this.node.clearStrokes();
    close.onclick = () => this.close();

    // move by the title bar (not by its controls)
    bar.addEventListener('pointerdown', (e) => {
      if (e.target !== bar && e.target !== title) return;
      const r = root.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      const move = (ev) => {
        root.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx)) + 'px';
        root.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy)) + 'px';
      };
      const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); this.saveGeom(); };
      bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up);
    });
    new ResizeObserver(() => { if (this.node) this.saveGeom(); }).observe(root);

    // drawing
    const toImage = (e) => {
      const f = this.frame; if (!f) return null;
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left - f.x) / f.w, (e.clientY - r.top - f.y) / f.h];
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.node || e.button !== 0) return;
      const pt = toImage(e); if (!pt) return;
      canvas.setPointerCapture(e.pointerId); canvas.focus();
      this.node.beginStroke(pt[0], pt[1], e.timeStamp);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      this.cursor = toImage(e);
      if (!this.node || !this.node._pen) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) { const pt = toImage(ev); if (pt) this.node.extendStroke(pt[0], pt[1], ev.timeStamp); }
    });
    const end = () => { if (this.node) this.node.endStroke(); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { this.cursor = null; });
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();                         // keep Delete/Ctrl+Z away from litegraph
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.node && this.node.undo(); }
      else if (e.key === '[' || e.key === ']') {
        const n = this.node; if (!n) return;
        n.properties.width = Math.max(1, Math.min(200, n.properties.width * (e.key === ']' ? 1.2 : 1 / 1.2)));
        this.sync(); RT.redraw();
      } else if (e.key === 'Escape') this.close();
    });
    return this.ui;
  },

  saveGeom() {
    const r = this.ui.root.getBoundingClientRect();
    try { localStorage.setItem(PANE_KEY, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height })); } catch (e) {}
  },

  open(node) {
    const ui = this.build();
    if (this.node !== node) this.close();
    this.node = node;
    let g = null;
    try { g = JSON.parse(localStorage.getItem(PANE_KEY) || 'null'); } catch (e) {}
    g = g || { x: 80, y: 90, w: 560, h: 600 };
    // keep it on screen, e.g. after the window shrank since it was last placed
    const vw = innerWidth || 1280, vh = innerHeight || 800;
    const w = Math.min(g.w, Math.max(280, vw - 16)), h = Math.min(g.h, Math.max(220, vh - 16));
    Object.assign(ui.root.style, {
      display: 'flex', left: Math.max(0, Math.min(g.x, vw - w)) + 'px', top: Math.max(0, Math.min(g.y, vh - h)) + 'px',
      width: w + 'px', height: h + 'px',
    });
    this.sync();
    if (!this.unhook) this.unhook = RT.addHook(() => this.draw());
    ui.canvas.focus();
  },

  close() {
    if (this.node) this.node.endStroke();
    if (this.unhook) { this.unhook(); this.unhook = null; }
    if (this.ui) this.ui.root.style.display = 'none';
    this.node = null;
  },

  // node → pane controls
  sync() {
    const n = this.node, ui = this.ui; if (!n || !ui) return;
    const p = n.properties;
    ui.title.textContent = (n.title || 'Drawing') + ' · ' + p.mode + (p.mode === 'animate' ? ' · ' + p.timing : '');
    ui.color.value = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#ffffff';
    ui.width.value = p.width; ui.soft.value = p.softness; ui.opac.value = p.opacity;
    const extra = ['brush', 'scatter', 'dotSize', 'density', 'hueJit', 'satJit', 'valJit', 'speedWidth', 'speedAmt'];
    for (const k of extra) ui[k].value = p[k] ?? DEFAULTS[k];
    for (const el of ui.scatterBits) el.style.opacity = p.brush === 'scatter' ? '1' : '0.35';
    ui.speedAmt.parentNode.style.opacity = p.speedWidth === 'off' ? '0.35' : '1';
    for (const k of ['width', 'softness', 'opacity', 'color'].concat(extra)) {
      const w = (n.widgets || []).find((x) => x.name === label(k)); if (w) w.value = p[k];
    }
  },

  draw() {
    const n = this.node, ui = this.ui;
    if (!n || !n.graph) { this.close(); return; }
    const c = ui.canvas, ctx = ui.ctx, dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(c.clientWidth * dpr)), ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const s = n._size || { width: 1, height: 1 };
    const k = Math.min(cw / s.width, ch / s.height), fw = s.width * k, fh = s.height * k;
    const fx = (cw - fw) / 2, fy = (ch - fh) / 2;
    this.frame = { x: fx / dpr, y: fy / dpr, w: fw / dpr, h: fh / dpr };

    ctx.fillStyle = '#0a0c0f'; ctx.fillRect(0, 0, cw, ch);
    if (n._out && n._out.tex) {
      try {
        const r = RT.engine.blitToCanvas(n._out.tex, s.width, s.height, Math.ceil(Math.max(fw, fh)));
        ctx.drawImage(RT.engine.canvas, 0, 0, r.width, r.height, fx, fy, fw, fh);
      } catch (e) {}
    }
    ctx.strokeStyle = '#262b33'; ctx.lineWidth = 1; ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);

    const p = n.properties, P = (st, i) => [fx + st.p[i * 3] * fw, fy + st.p[i * 3 + 1] * fh];
    const path = (st) => {
      ctx.beginPath();
      for (let i = 0; i < st.p.length / 3; i++) { const q = P(st, i); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }
    };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const animate = p.mode === 'animate';
    // Ghosts: in animate mode most of the drawing is off-screen at any moment.
    if (animate && ui.ghost.checked) {
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = Math.max(1, dpr);
      for (const st of p.strokes) if (st !== n._pen) { path(st); ctx.stroke(); }
    }
    // The stroke under the pen, when the output isn't already showing it live.
    const live = !animate || (p.timing === 'as drawn' && RT.playing);
    const scale = fw / s.width * Math.min(s.width, s.height) / REF;
    if (n._pen && !live) {
      ctx.globalAlpha = n._pen.o ?? 1; ctx.strokeStyle = n._pen.c;
      ctx.lineWidth = Math.max(1, (n._pen.w || 1) * scale);
      path(n._pen); ctx.stroke(); ctx.globalAlpha = 1;
    }
    // brush cursor
    if (this.cursor) {
      const x = fx + this.cursor[0] * fw, y = fy + this.cursor[1] * fh;
      const r = Math.max(1.5, (+p.width || 1) * 0.5 * scale);
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.beginPath(); ctx.arc(x, y, r + dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = p.color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    }
    // clip progress
    if (animate) {
      const t = n._clock / n.clipLength();
      ctx.fillStyle = '#262b33'; ctx.fillRect(0, ch - 3 * dpr, cw, 3 * dpr);
      ctx.fillStyle = '#5b8cff'; ctx.fillRect(0, ch - 3 * dpr, cw * t, 3 * dpr);
    }
  },
};
