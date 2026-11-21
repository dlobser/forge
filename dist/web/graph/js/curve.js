// curve.js — the Curve oscillator: a value you draw as a spline on a timeline.
//
// Time runs 0..1 across the curve and value runs -1..1, so it drops in wherever
// the plain Oscillator does — run it through a Remap to land the value on any
// range. Each key decides how the curve travels to the NEXT key:
//
//   smooth   automatic tangents (Catmull-Rom), the curve flows through the keys
//   bezier   you drag the handles; flat handles make an ease in/out
//   linear   straight line
//   hold     stays put, then jumps — steps, square waves, sample-and-hold
//
// `period` is how many seconds one pass of 0..1 takes; `play` loops it, ping-pongs
// it, or plays it once (↺ restart replays it). The phase follows the graph clock,
// so pausing freezes it and a Sequence render steps it exactly. Connect a number to
// `phase` to scrub the curve from anything else instead (another curve, audio…).
//
// Double-click the node, or ✎ Edit curve, for the editor.
import { RT } from './runtime.js';

const LG = window.LiteGraph;
export const CURVE_TYPE = 'control/curve';

const INTERPS = ['smooth', 'bezier', 'linear', 'hold'];
const PLAY_MODES = ['loop', 'ping-pong', 'once'];
const CURVE_H = 96;   // node-face preview height

const K = (t, v, i) => ({ t, v, i });
const PRESETS = {
  // a true sine: bezier quarter-waves with the classic handle lengths
  sine: () => {
    const a = 0.0836, b = 0.5251, c = 0.0905;
    return [
      { t: 0, v: 0, i: 'bezier', ho: [a, b] },
      { t: 0.25, v: 1, i: 'bezier', hi: [-c, 0], ho: [c, 0] },
      { t: 0.5, v: 0, i: 'bezier', hi: [-a, b], ho: [a, -b] },
      { t: 0.75, v: -1, i: 'bezier', hi: [-c, 0], ho: [c, 0] },
      { t: 1, v: 0, i: 'bezier', hi: [-a, -b] },
    ];
  },
  wave: () => [K(0, 0, 'smooth'), K(0.25, 1, 'smooth'), K(0.5, 0, 'smooth'), K(0.75, -1, 'smooth'), K(1, 0, 'smooth')],
  triangle: () => [K(0, -1, 'linear'), K(0.5, 1, 'linear'), K(1, -1, 'linear')],
  saw: () => [K(0, -1, 'linear'), K(1, 1, 'linear')],
  'saw down': () => [K(0, 1, 'linear'), K(1, -1, 'linear')],
  square: () => [K(0, 1, 'hold'), K(0.5, -1, 'hold'), K(1, 1, 'hold')],
  ease: () => [K(0, -1, 'bezier'), K(0.5, 1, 'bezier'), K(1, -1, 'bezier')],
  pulse: () => [K(0, -1, 'hold'), K(0.1, 1, 'bezier'), K(0.35, -1, 'hold'), K(1, -1, 'hold')],
  'random steps': () => {
    const out = [];
    for (let i = 0; i < 8; i++) out.push(K(i / 8, Math.round((Math.random() * 2 - 1) * 100) / 100, 'hold'));
    out.push(K(1, out[0].v, 'hold'));
    return out;
  },
  'random smooth': () => {
    const out = [];
    for (let i = 0; i < 6; i++) out.push(K(i / 6, Math.round((Math.random() * 1.8 - 0.9) * 100) / 100, 'smooth'));
    out.push(K(1, out[0].v, 'smooth'));
    return out;
  },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r4 = (v) => Math.round(v * 10000) / 10000;

// ── evaluation ──────────────────────────────────────────────────────────────────
// Neighbour for tangents. When the curve's ends sit at t = 0 and t = 1 they are the
// same moment of a loop, so the wrap skips the duplicate and the seam stays smooth.
function neighbour(keys, k, dir) {
  const n = keys.length;
  const j = k + dir;
  if (j >= 0 && j < n) return keys[j];
  const closed = n > 2 && keys[0].t < 1e-4 && keys[n - 1].t > 1 - 1e-4;
  if (dir < 0) { const q = keys[closed ? n - 2 : n - 1]; return { t: q.t - 1, v: q.v }; }
  const q = keys[closed ? 1 : 0]; return { t: q.t + 1, v: q.v };
}
function tangent(keys, k) {
  const a = neighbour(keys, k, -1), b = neighbour(keys, k, 1);
  return (b.v - a.v) / Math.max(1e-6, b.t - a.t);
}
// Bezier control points for the segment a→b; handles are offsets from their key,
// clamped inside the segment so the curve can never fold back in time.
function bezierPts(keys, k) {
  const a = keys[k], b = keys[k + 1], h = b.t - a.t;
  const ho = a.ho || [h / 3, 0], hi = b.hi || [-h / 3, 0];
  return [a.t, a.v, a.t + clamp(ho[0], 0, h), a.v + ho[1], b.t + clamp(hi[0], -h, 0), b.v + hi[1], b.t, b.v];
}
const bz = (p0, p1, p2, p3, u) => { const m = 1 - u; return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3; };

export function evalCurve(keys, t) {
  const n = keys.length;
  if (!n) return 0;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;
  let k = 0;
  while (k < n - 2 && keys[k + 1].t <= t) k++;
  const a = keys[k], b = keys[k + 1], h = b.t - a.t;
  if (h <= 1e-9) return b.v;
  const u = (t - a.t) / h;
  switch (a.i) {
    case 'hold': return a.v;
    case 'linear': return a.v + (b.v - a.v) * u;
    case 'bezier': {
      const P = bezierPts(keys, k);
      let lo = 0, hi = 1, m = u;
      for (let it = 0; it < 24; it++) {           // x(u) is monotonic: bisect for it
        m = (lo + hi) / 2;
        if (bz(P[0], P[2], P[4], P[6], m) < t) lo = m; else hi = m;
      }
      return bz(P[1], P[3], P[5], P[7], m);
    }
    default: {                                     // smooth: cubic Hermite
      const ma = tangent(keys, k), mb = tangent(keys, k + 1);
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * a.v + (u3 - 2 * u2 + u) * h * ma + (-2 * u3 + 3 * u2) * b.v + (u3 - u2) * h * mb;
    }
  }
}

// draws the curve into a rect; used by the node face and the editor
function plotCurve(ctx, keys, x, y, w, h, color, lw) {
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
  const N = Math.max(32, Math.min(800, Math.round(w)));
  for (let i = 0; i <= N; i++) {
    const t = i / N, v = clamp(evalCurve(keys, t), -1, 1);
    const px = x + t * w, py = y + (1 - (v + 1) / 2) * h;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.stroke();
}

// ── the node ────────────────────────────────────────────────────────────────────
const DEFAULTS = { period: 4, offset: 0, play: 'loop' };

export function registerCurveNode() {
  function CurveNode() {
    this.addInput('phase', 'number');
    this.addOutput('value', 'number');
    this.addOutput('phase', 'number');
    this.properties = Object.assign({}, DEFAULTS, { keys: PRESETS.sine() });
    const p = this.properties;
    this.addWidget('button', '✎ Edit curve', null, () => editor.open(this));
    this.addWidget('number', 'period (s)', p.period, (v) => { p.period = Math.max(0.01, v); RT.requestSave(); }, { min: 0.01, max: 3600, step: 0.5, precision: 2 });
    this.addWidget('slider', 'offset', p.offset, (v) => { p.offset = v; RT.requestSave(); }, { min: 0, max: 1, step: 0.01 });
    this.addWidget('combo', 'play', p.play, (v) => { p.play = v; RT.requestSave(); }, { values: PLAY_MODES });
    this.addWidget('button', '↺ restart', null, () => this.resetClip(RT.time));
    this._t0 = 0; this._phase = 0; this._value = 0;
    this._resize();
  }
  CurveNode.title = 'Curve';
  const P = CurveNode.prototype;

  P._resize = function () {
    this.size = this.computeSize();
    if (this.size[0] < 220) this.size[0] = 220;
    this.size[1] += CURVE_H + 8;
  };
  P.onConfigure = function () {
    const p = this.properties;
    for (const k in DEFAULTS) if (p[k] === undefined) p[k] = DEFAULTS[k];
    if (!Array.isArray(p.keys) || p.keys.length < 2) p.keys = PRESETS.sine();
    for (const w of this.widgets || []) {
      if (w.name === 'period (s)') w.value = p.period;
      else if (w.name === 'offset') w.value = p.offset;
      else if (w.name === 'play') w.value = p.play;
    }
  };
  // Sequence → Video's "reset first" calls this before it starts the clock at 0.
  P.resetClip = function (t = 0) { this._t0 = t; RT.redraw(); };
  P.onDblClick = function () { editor.open(this); };
  P.onRemoved = function () { if (editor.node === this) editor.close(); };

  P.evaluate = function () {
    const p = this.properties;
    const ext = this.getInputData(0);
    let ph;
    if (typeof ext === 'number' && !isNaN(ext)) ph = ext - Math.floor(ext);     // driven from outside
    else {
      const x = (RT.time - this._t0) / Math.max(0.01, +p.period || 1) + (+p.offset || 0);
      if (p.play === 'once') ph = clamp(x, 0, 1);
      else if (p.play === 'ping-pong') { const f = x - 2 * Math.floor(x / 2); ph = f <= 1 ? f : 2 - f; }
      else ph = x - Math.floor(x);
    }
    const v = clamp(evalCurve(p.keys, ph), -1, 1);
    if (v !== this._value || ph !== this._phase) { this._value = v; this._phase = ph; RT.redraw(); }
    this.setOutputData(0, v);
    this.setOutputData(1, ph);
  };

  P.onDrawForeground = function (ctx) {
    if (this.flags.collapsed) return;
    const x = 8, w = this.size[0] - 16, h = CURVE_H, y = this.size[1] - h - 6;
    ctx.fillStyle = '#0a0c0f'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#1f242c'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); ctx.stroke();
    plotCurve(ctx, this.properties.keys, x, y + 4, w, h - 8, '#5b8cff', 1.5);
    const px = x + this._phase * w, py = y + 4 + (1 - (this._value + 1) / 2) * (h - 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, y + h); ctx.stroke();
    ctx.fillStyle = '#ffcc66'; ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8a929c'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(this._value.toFixed(3), x + w - 3, y + 12); ctx.textAlign = 'left';
  };

  P.getExtraMenuOptions = function () {
    const node = this;
    return [{ content: '✎ Edit curve', callback: () => editor.open(node) }, {
      content: 'Preset', has_submenu: true,
      callback: (_v, _o, e, menu) => new LG.ContextMenu(Object.keys(PRESETS), {
        event: e, parentMenu: menu, callback: (name) => node.setKeys(PRESETS[name]()),
      }),
    }];
  };
  P.setKeys = function (keys) {
    this.properties.keys = keys; RT.requestSave(); RT.redraw();
    if (editor.node === this) editor.sel = -1;
  };

  LG.registerNodeType(CURVE_TYPE, CurveNode);
}

// ── the editor pane ─────────────────────────────────────────────────────────────
// Click empty space to add a key · drag keys and bezier handles · Shift snaps to a
// grid · right-click a key for its interpolation (or delete) · Delete removes the
// selected key · S / B / L / H set the selected key's interpolation.
const PANE_KEY = 'forge.curvePane';
const editor = {
  node: null, ui: null, unhook: null, sel: -1, drag: null, hover: null,

  build() {
    if (this.ui) return this.ui;
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;z-index:60;display:none;flex-direction:column;background:#15181d;'
      + 'border:1px solid #262b33;border-radius:8px;box-shadow:0 10px 40px #000a;resize:both;overflow:hidden;'
      + 'min-width:360px;min-height:220px;font:12px -apple-system,Segoe UI,sans-serif;color:#e6e8ea;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #262b33;'
      + 'cursor:move;user-select:none;flex-wrap:wrap;';
    const title = document.createElement('span');
    title.style.cssText = 'color:#8a929c;letter-spacing:1px;text-transform:uppercase;font-size:10px;margin-right:auto;';
    title.textContent = 'Curve';
    const btn = (label, tip) => {
      const b = document.createElement('button'); b.textContent = label; b.title = tip;
      b.style.cssText = 'background:#1c2028;color:#e6e8ea;border:1px solid #262b33;border-radius:5px;padding:3px 8px;cursor:pointer;font-size:11px;';
      return b;
    };
    const preset = document.createElement('select');
    preset.style.cssText = 'background:#1c2028;color:#e6e8ea;border:1px solid #262b33;border-radius:5px;padding:2px 4px;font-size:11px;';
    preset.innerHTML = '<option value="">preset…</option>' + Object.keys(PRESETS).map((k) => `<option>${k}</option>`).join('');
    preset.onchange = () => { if (preset.value && this.node) this.node.setKeys(PRESETS[preset.value]()); preset.value = ''; };
    const interpBtns = INTERPS.map((m) => {
      const b = btn(m, 'Selected key → ' + m + ' (' + m[0].toUpperCase() + ')');
      b.onclick = () => this.setInterp(m);
      return b;
    });
    const del = btn('✕ key', 'Delete the selected key (Delete)');
    del.onclick = () => this.deleteKey(this.sel);
    const snapL = document.createElement('label');
    snapL.style.cssText = 'display:flex;align-items:center;gap:3px;color:#8a929c;font-size:10px;text-transform:uppercase;';
    const snap = document.createElement('input'); snap.type = 'checkbox';
    snapL.append(snap, 'Snap'); snapL.title = 'Snap keys to a grid (or hold Shift while dragging)';
    const close = btn('✕', 'Close (Esc)');
    close.onclick = () => this.close();
    bar.append(title, preset, ...interpBtns, del, snapL, close);
    const readout = document.createElement('div');
    readout.style.cssText = 'padding:3px 10px;color:#8a929c;font:11px ui-monospace,monospace;border-bottom:1px solid #262b33;';
    const area = document.createElement('div');
    area.style.cssText = 'flex:1;position:relative;background:#0a0c0f;min-height:0;';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none;';
    canvas.tabIndex = 0;
    area.append(canvas);
    root.append(bar, readout, area);
    document.body.appendChild(root);
    this.ui = { root, bar, title, canvas, ctx: canvas.getContext('2d'), snap, readout, interpBtns };

    // move by the title bar
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

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    const up = () => { if (this.drag) { this.drag = null; RT.requestSave(); } };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.menu(e); });
    canvas.addEventListener('dblclick', (e) => {
      const hit = this.hit(this.local(e));
      if (hit && hit.type === 'key') this.deleteKey(hit.k);
    });
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();                         // keep Delete away from litegraph
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') this.close();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel >= 0) { e.preventDefault(); this.deleteKey(this.sel); }
      else if (!e.ctrlKey && !e.metaKey && 'sblh'.includes(k) && k.length === 1) this.setInterp({ s: 'smooth', b: 'bezier', l: 'linear', h: 'hold' }[k]);
    });
    return this.ui;
  },

  saveGeom() {
    const r = this.ui.root.getBoundingClientRect();
    try { localStorage.setItem(PANE_KEY, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height })); } catch (e) {}
  },

  open(node) {
    const ui = this.build();
    this.node = node; this.sel = -1; this.drag = null;
    let g = null;
    try { g = JSON.parse(localStorage.getItem(PANE_KEY) || 'null'); } catch (e) {}
    g = g || { x: 120, y: 120, w: 640, h: 360 };
    const vw = innerWidth || 1280, vh = innerHeight || 800;
    const w = Math.min(g.w, Math.max(360, vw - 16)), h = Math.min(g.h, Math.max(220, vh - 16));
    Object.assign(ui.root.style, {
      display: 'flex', left: Math.max(0, Math.min(g.x, vw - w)) + 'px', top: Math.max(0, Math.min(g.y, vh - h)) + 'px',
      width: w + 'px', height: h + 'px',
    });
    ui.title.textContent = (node.title || 'Curve') + ' · #' + node.id;
    if (!this.unhook) this.unhook = RT.addHook(() => this.draw());
    ui.canvas.focus();
  },
  close() {
    if (this.unhook) { this.unhook(); this.unhook = null; }
    if (this.ui) this.ui.root.style.display = 'none';
    if (this.popup) { this.popup.remove(); this.popup = null; }
    this.node = null;
  },

  // geometry: plot rect inside the canvas, in CSS pixels
  rect() {
    const c = this.ui.canvas;
    return { x: 36, y: 12, w: Math.max(10, c.clientWidth - 48), h: Math.max(10, c.clientHeight - 30) };
  },
  toPx(t, v) { const r = this.rect(); return [r.x + t * r.w, r.y + (1 - (v + 1) / 2) * r.h]; },
  fromPx(x, y) { const r = this.rect(); return [(x - r.x) / r.w, (1 - (y - r.y) / r.h) * 2 - 1]; },
  local(e) { const b = this.ui.canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; },
  keys() { return this.node ? this.node.properties.keys : []; },

  // A key's out-handle exists when the segment leaving it is bezier; its in-handle
  // when the segment arriving at it is.
  handlePx(k, which) {
    const keys = this.keys();
    if (!keys[k]) return null;
    if (which === 'ho') {
      if (keys[k].i !== 'bezier' || k >= keys.length - 1) return null;
      const P = bezierPts(keys, k); return this.toPx(P[2], P[3]);
    }
    if (k <= 0 || keys[k - 1].i !== 'bezier') return null;
    const P = bezierPts(keys, k - 1); return this.toPx(P[4], P[5]);
  },

  hit(pt) {
    const keys = this.keys(), R = 7;
    const near = (q) => q && Math.hypot(q[0] - pt[0], q[1] - pt[1]) <= R;
    // handles of the selected key (and its neighbours) win over keys underneath
    for (const k of this.sel < 0 ? [] : [this.sel, this.sel - 1, this.sel + 1]) {
      if (k < 0 || k >= keys.length) continue;
      if (near(this.handlePx(k, 'ho'))) return { type: 'ho', k };
      if (near(this.handlePx(k, 'hi'))) return { type: 'hi', k };
    }
    for (let k = 0; k < keys.length; k++) if (near(this.toPx(keys[k].t, keys[k].v))) return { type: 'key', k };
    return null;
  },

  snapOn(e) { return e.shiftKey || this.ui.snap.checked; },
  snapT: (t) => Math.round(t * 16) / 16,
  snapV: (v) => Math.round(v * 8) / 8,

  down(e) {
    if (!this.node || e.button !== 0) return;
    this.ui.canvas.setPointerCapture(e.pointerId); this.ui.canvas.focus();
    const pt = this.local(e), hit = this.hit(pt);
    if (hit) { this.drag = hit; if (hit.type === 'key') this.sel = hit.k; return; }
    // add a key
    let [t, v] = this.fromPx(pt[0], pt[1]);
    if (this.snapOn(e)) { t = this.snapT(t); v = this.snapV(v); }
    t = clamp(t, 0, 1); v = clamp(v, -1, 1);
    const keys = this.keys();
    let k = keys.findIndex((q) => q.t > t);
    if (k < 0) k = keys.length;
    const left = keys[k - 1];
    keys.splice(k, 0, K(r4(t), r4(v), left ? left.i : 'smooth'));
    this.sel = k; this.drag = { type: 'key', k };
    RT.requestSave(); RT.redraw();
  },

  move(e) {
    const pt = this.local(e);
    if (!this.drag) { this.hover = this.hit(pt); this.ui.canvas.style.cursor = this.hover ? 'grab' : 'crosshair'; return; }
    const keys = this.keys(), d = this.drag, key = keys[d.k];
    if (!key) return;
    let [t, v] = this.fromPx(pt[0], pt[1]);
    const snap = this.snapOn(e);
    if (d.type === 'key') {
      if (snap) { t = this.snapT(t); v = this.snapV(v); }
      const lo = d.k > 0 ? keys[d.k - 1].t + 1e-3 : 0, hi = d.k < keys.length - 1 ? keys[d.k + 1].t - 1e-3 : 1;
      key.t = r4(clamp(t, lo, hi)); key.v = r4(clamp(v, -1, 1));
    } else {
      // a bezier handle: offset from its key. The opposite handle mirrors its angle
      // (keeping its own length) unless Alt is held, for a smooth key by default.
      const off = [t - key.t, v - key.v];
      if (d.type === 'ho') off[0] = Math.max(0, off[0]); else off[0] = Math.min(0, off[0]);
      key[d.type] = [r4(off[0]), r4(off[1])];
      if (!e.altKey) {
        const other = d.type === 'ho' ? 'hi' : 'ho';
        const nb = keys[d.k + (other === 'ho' ? 1 : -1)];
        if (nb) {
          const len0 = key[other] ? Math.hypot(key[other][0], key[other][1]) : Math.abs(nb.t - key.t) / 3;
          const L = Math.hypot(off[0], off[1]) || 1;
          key[other] = [r4(-off[0] / L * len0), r4(-off[1] / L * len0)];
        }
      }
    }
    RT.redraw();
  },

  setInterp(m) {
    const keys = this.keys(), k = this.sel;
    if (!keys[k]) return RT.toast('Select a key first');
    keys[k].i = m; RT.requestSave(); RT.redraw();
  },
  deleteKey(k) {
    const keys = this.keys();
    if (k < 0 || k >= keys.length) return;
    if (keys.length <= 2) return RT.toast('A curve needs at least two keys');
    keys.splice(k, 1); this.sel = -1; RT.requestSave(); RT.redraw();
  },

  menu(e) {
    const hit = this.hit(this.local(e));
    if (this.popup) this.popup.remove();
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;z-index:70;background:#15181d;border:1px solid #262b33;border-radius:6px;'
      + 'padding:4px;box-shadow:0 6px 20px #000a;font:12px -apple-system,Segoe UI,sans-serif;min-width:120px;';
    m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px';
    const item = (label, fn) => {
      const it = document.createElement('div'); it.textContent = label;
      it.style.cssText = 'padding:4px 10px;border-radius:4px;cursor:pointer;color:#e6e8ea;';
      it.onmouseenter = () => { it.style.background = '#262b33'; };
      it.onmouseleave = () => { it.style.background = ''; };
      it.onclick = () => { fn(); m.remove(); this.popup = null; };
      m.appendChild(it);
    };
    if (hit && hit.type === 'key') {
      this.sel = hit.k;
      const cur = this.keys()[hit.k].i;
      for (const mode of INTERPS) item((cur === mode ? '● ' : '○ ') + mode, () => this.setInterp(mode));
      item('✕ delete key', () => this.deleteKey(hit.k));
    } else {
      for (const name of Object.keys(PRESETS)) item(name, () => this.node && this.node.setKeys(PRESETS[name]()));
    }
    document.body.appendChild(m);
    this.popup = m;
    const off = (ev) => { if (!m.contains(ev.target)) { m.remove(); if (this.popup === m) this.popup = null; document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  },

  draw() {
    const n = this.node, ui = this.ui;
    if (!n || !n.graph) { this.close(); return; }
    const c = ui.canvas, ctx = ui.ctx, dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(c.clientWidth * dpr)), ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0c0f'; ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    const r = this.rect(), keys = this.keys();

    // grid: quarters of time, eighths of value, labelled
    ctx.lineWidth = 1; ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = '#5a626c';
    for (let i = 0; i <= 16; i++) {
      const x = r.x + i / 16 * r.w;
      ctx.strokeStyle = i % 4 ? '#14181e' : '#232933';
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      if (i % 4 === 0) { ctx.textAlign = 'center'; ctx.fillText(String(i / 16), x, r.y + r.h + 13); }
    }
    for (let i = -4; i <= 4; i++) {
      const y = r.y + (1 - (i / 4 + 1) / 2) * r.h;
      ctx.strokeStyle = i === 0 ? '#2e3540' : (i % 2 ? '#14181e' : '#232933');
      ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
      if (i % 2 === 0) { ctx.textAlign = 'right'; ctx.fillText((i / 4).toFixed(1), r.x - 5, y + 3); }
    }

    plotCurve(ctx, keys, r.x, r.y, r.w, r.h, '#5b8cff', 2);

    // bezier handles for the selected key and its neighbours
    for (const k of this.sel < 0 ? [] : [this.sel - 1, this.sel, this.sel + 1]) {
      if (k < 0 || k >= keys.length) continue;
      const kp = this.toPx(keys[k].t, keys[k].v);
      for (const which of ['hi', 'ho']) {
        const hp = this.handlePx(k, which); if (!hp) continue;
        ctx.strokeStyle = '#6a7380'; ctx.beginPath(); ctx.moveTo(kp[0], kp[1]); ctx.lineTo(hp[0], hp[1]); ctx.stroke();
        ctx.fillStyle = '#0a0c0f'; ctx.strokeStyle = '#cfd3d8';
        ctx.beginPath(); ctx.arc(hp[0], hp[1], 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    // keys: shape says the interpolation leaving them
    keys.forEach((q, k) => {
      const [x, y] = this.toPx(q.t, q.v);
      const on = k === this.sel;
      ctx.fillStyle = on ? '#ffcc66' : '#e6e8ea'; ctx.strokeStyle = '#0a0c0f'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (q.i === 'hold') ctx.rect(x - 4.5, y - 4.5, 9, 9);
      else if (q.i === 'linear') { ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); }
      else ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });
    // playhead
    const ph = n._phase || 0, pv = n._value || 0;
    const [hx, hy] = this.toPx(ph, pv);
    ctx.strokeStyle = 'rgba(255,204,102,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, r.y); ctx.lineTo(hx, r.y + r.h); ctx.stroke();
    ctx.fillStyle = '#ffcc66'; ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill();

    const s = keys[this.sel];
    ui.readout.textContent = (s ? `key ${this.sel + 1}/${keys.length}  t ${s.t.toFixed(3)}  v ${s.v.toFixed(3)}  ${s.i}` : `${keys.length} keys · click to add · drag to move · right-click for interpolation`)
      + `   ▸ ${pv.toFixed(3)}`;
    for (const b of ui.interpBtns) b.style.borderColor = s && b.textContent === s.i ? '#5b8cff' : '#262b33';
  },
};
