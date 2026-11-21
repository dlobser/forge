// graphview.js — the Graph View node: a picture of the graph itself.
//
// Every node as a light outline box, every connection as a thin curve, on a
// transparent background — an image you can lay over your output so an audience
// sees the patch you're building while it runs. Connect a picture to `image` and
// the schematic is drawn straight onto it (no Blend needed); leave it empty for a
// transparent overlay at the node's render size.
//
//   frame       whole graph — fit everything; editor view — follow what's on screen
//               in the editor, so the overlay pans and zooms as you do
//   labels      node titles inside the boxes
//   thumbnails  each node's own preview, faintly, inside its box
//   selected    the node(s) you're working on drawn brighter
//
// It's redrawn only when something it shows changes (a node moves, a link is
// made, the selection changes), so leaving it running costs next to nothing.
import { RT } from './runtime.js';
import { isMuted } from './boot.js';

const LG = window.LiteGraph;
const IMG = 'IMAGE';
export const GRAPH_VIEW_TYPE = 'input/graph_view';

const DEFAULTS = {
  color: '#ffffff', opacity: 0.55, line: 1.5, labels: true, links: true,
  frame: 'whole graph', padding: 0.06, selected: true, thumbs: false,
};

const COMP_VERT = `#version 300 es
precision highp float; out vec2 vUv;
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv = p; gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;
// schematic (straight alpha) over the picture (straight alpha)
const COMP_FRAG = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uColor; uniform sampler2D uOverlay;
void main(){
  vec4 b = texture(uColor, vUv), s = texture(uOverlay, vUv);
  float a = s.a + b.a * (1.0 - s.a);
  vec3 c = s.rgb * s.a + b.rgb * b.a * (1.0 - s.a);
  o = a > 1e-5 ? vec4(c / a, a) : vec4(0.0);
}`;

const rgba = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
};

// the region of graph space to show: [x, y, w, h]
function frameBox(node, p) {
  const gc = RT.graphcanvas;
  if (p.frame === 'editor view' && gc && gc.ds && gc.canvas) {
    const ds = gc.ds;
    return [-ds.offset[0], -ds.offset[1], gc.canvas.width / ds.scale, gc.canvas.height / ds.scale];
  }
  const th = LG.NODE_TITLE_HEIGHT;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of node.graph._nodes || []) {
    const [w, h] = boxSize(n);
    x0 = Math.min(x0, n.pos[0]); y0 = Math.min(y0, n.pos[1] - th);
    x1 = Math.max(x1, n.pos[0] + w); y1 = Math.max(y1, n.pos[1] + h - th);
  }
  if (!isFinite(x0)) return [0, 0, 100, 100];
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
}
// full outer size of a node, title included
function boxSize(n) {
  const th = LG.NODE_TITLE_HEIGHT;
  if (n.flags && n.flags.collapsed) return [n._collapsed_width || LG.NODE_COLLAPSED_WIDTH || 80, th];
  return [n.size[0], n.size[1] + th];
}

function draw(node, cvs, w, h) {
  const p = node.properties, ctx = cvs.getContext('2d');
  if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
  ctx.clearRect(0, 0, w, h);
  const g = node.graph;
  const box = frameBox(node, p);
  const pad = p.frame === 'editor view' ? 0 : Math.max(0, +p.padding || 0) * Math.min(w, h);
  const s = Math.min((w - 2 * pad) / box[2], (h - 2 * pad) / box[3]);
  const ox = (w - box[2] * s) / 2 - box[0] * s, oy = (h - box[3] * s) / 2 - box[1] * s;
  const X = (x) => x * s + ox, Y = (y) => y * s + oy;
  const px = Math.max(1, Math.min(w, h) / 1024);           // line widths in 1024-frame pixels
  const lw = Math.max(0.5, (+p.line || 1) * px);
  const op = Math.max(0, Math.min(1, +p.opacity || 0));
  const sel = (RT.graphcanvas && RT.graphcanvas.selected_nodes) || {};
  const th = LG.NODE_TITLE_HEIGHT;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // connections, behind the boxes
  if (p.links) {
    ctx.strokeStyle = rgba(p.color, op * 0.7); ctx.lineWidth = lw;
    const a = [0, 0], b = [0, 0];
    for (const id in g.links || {}) {
      const L = g.links[id]; if (!L) continue;
      const on = g.getNodeById(L.origin_id), tn = g.getNodeById(L.target_id);
      if (!on || !tn) continue;
      on.getConnectionPos(false, L.origin_slot, a); tn.getConnectionPos(true, L.target_slot, b);
      const x0 = X(a[0]), y0 = Y(a[1]), x1 = X(b[0]), y1 = Y(b[1]);
      const d = Math.max(20 * s, Math.abs(x1 - x0) * 0.5);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.bezierCurveTo(x0 + d, y0, x1 - d, y1, x1, y1); ctx.stroke();
      ctx.fillStyle = rgba(p.color, op);
      ctx.beginPath(); ctx.arc(x1, y1, lw * 1.6, 0, Math.PI * 2); ctx.fill();
    }
  }

  // nodes
  const fontPx = Math.min(48 * px, 12 * s);
  for (const n of g._nodes || []) {
    const [bw, bh] = boxSize(n);
    const x = X(n.pos[0]), y = Y(n.pos[1] - th), ww = bw * s, hh = bh * s;
    const isSel = p.selected && sel[n.id];
    const muted = isMuted(n);
    // a node's own preview, faintly, where it shows it on the canvas
    if (p.thumbs && n._pvCanvas && n._pvCanvas.width && !(n.flags && n.flags.collapsed)) {
      const c = n._pvCanvas, aw = ww - 4 * px, ah = Math.min(hh - th * s, 116 * s);
      if (aw > 4 && ah > 4) {
        const k = Math.min(aw / c.width, ah / c.height), dw = c.width * k, dh = c.height * k;
        ctx.globalAlpha = op * 0.8;
        try { ctx.drawImage(c, x + (ww - dw) / 2, y + hh - ah - 2 * px + (ah - dh) / 2, dw, dh); } catch (e) {}
        ctx.globalAlpha = 1;
      }
    }
    ctx.strokeStyle = rgba(p.color, isSel ? Math.min(1, op * 1.8) : op);
    ctx.lineWidth = isSel ? lw * 2 : lw;
    if (muted) ctx.setLineDash([5 * px, 4 * px]);
    ctx.strokeRect(x, y, ww, hh);
    if (!(n.flags && n.flags.collapsed)) {            // title bar rule
      ctx.beginPath(); ctx.moveTo(x, y + th * s); ctx.lineTo(x + ww, y + th * s); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (p.labels && fontPx >= 6) {
      ctx.fillStyle = rgba(p.color, isSel ? Math.min(1, op * 1.8) : op);
      ctx.font = `${fontPx.toFixed(1)}px -apple-system,Segoe UI,sans-serif`;
      ctx.textBaseline = 'middle';
      const t = (n.getTitle ? n.getTitle() : n.title) || n.type;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, ww, th * s); ctx.clip();
      ctx.fillText(t + (muted ? '  (muted)' : ''), x + 8 * s, y + th * s / 2);
      ctx.restore();
    }
  }
}

// what the picture depends on; unchanged → no redraw, no upload
function signature(node, w, h) {
  const p = node.properties, parts = [w, h, JSON.stringify(p)];
  const sel = (RT.graphcanvas && RT.graphcanvas.selected_nodes) || {};
  for (const n of node.graph._nodes || []) {
    parts.push(n.id, n.pos[0] | 0, n.pos[1] | 0, n.size[0] | 0, n.size[1] | 0, n.flags && n.flags.collapsed ? 1 : 0,
      n.mode | 0, sel[n.id] ? 1 : 0, p.labels ? n.title : '', p.thumbs && n._out ? n._out.version | 0 : '');
  }
  parts.push(Object.keys(node.graph.links || {}).join(','));
  if (p.frame === 'editor view' && RT.graphcanvas && RT.graphcanvas.ds) {
    const ds = RT.graphcanvas.ds; parts.push(ds.offset[0] | 0, ds.offset[1] | 0, ds.scale.toFixed(4));
  }
  return parts.join('|');
}

export function registerGraphViewNode(H) {
  function GraphViewNode() {
    this.addInput('image', IMG);
    this.addOutput('out', IMG);
    this.properties = Object.assign({}, DEFAULTS);
    const p = this.properties;
    const set = (k) => (v) => { p[k] = v; RT.requestSave(); RT.redraw(); };
    this.addWidget('combo', 'frame', p.frame, set('frame'), { values: ['whole graph', 'editor view'] });
    this.addWidget('text', 'color', p.color, set('color'));
    this.addWidget('slider', 'opacity', p.opacity, set('opacity'), { min: 0.05, max: 1, step: 0.01 });
    this.addWidget('slider', 'line', p.line, set('line'), { min: 0.5, max: 8, step: 0.1 });
    this.addWidget('slider', 'padding', p.padding, set('padding'), { min: 0, max: 0.3, step: 0.01 });
    this.addWidget('toggle', 'labels', p.labels, set('labels'));
    this.addWidget('toggle', 'links', p.links, set('links'));
    this.addWidget('toggle', 'selected', p.selected, set('selected'));
    this.addWidget('toggle', 'thumbnails', p.thumbs, set('thumbs'));
    this._cvs = document.createElement('canvas');
    this._size = { width: RT.RENDER_SIZE, height: RT.RENDER_SIZE };
    this._dirty = true;
    H.attachThumb(this); H.sizeWithThumb(this);
  }
  GraphViewNode.title = 'Graph View';
  const P = GraphViewNode.prototype;

  P.onConfigure = function () {
    const p = this.properties;
    for (const k in DEFAULTS) if (p[k] === undefined) p[k] = DEFAULTS[k];
    const names = { thumbs: 'thumbnails' };
    for (const w of this.widgets || []) {
      const k = Object.keys(DEFAULTS).find((q) => (names[q] || q) === w.name);
      if (k) w.value = p[k];
    }
    this._dirty = true;
  };

  P.evaluate = function () {
    if (!this.graph) return;
    const inH = this.getInputData(0);
    this._size = H.nodeRenderSize(this, inH && inH.tex ? inH : null);
    const { width: w, height: h } = this._size;
    const sig = signature(this, w, h) + '|' + (inH && inH.tex ? (inH.version | 0) : -1);
    if (this._dirty || sig !== this._sig) {
      draw(this, this._cvs, w, h);
      const overlay = RT.engine.texFromCanvas(this._cvs);
      H.ensureOut(this);
      RT.engine.renderToTexture({
        key: '__graphview', vertSrc: COMP_VERT, fragSrc: COMP_FRAG, controls: [], params: {},
        inputs: ['color', 'overlay'], inputTextures: { color: inH && inH.tex, overlay },
        inputDefaults: { color: 'transparent' },
      }, this._out.tex, w, h);
      this._out.version++;
      this._sig = sig; this._dirty = false;
    }
    this.setOutputData(0, this._out);
  };
  P.onDblClick = function () { if (this._out && this._out.tex) H.openFull(this); };
  P.getExtraMenuOptions = function () { return H.renderSizeMenu(this); };

  LG.registerNodeType(GRAPH_VIEW_TYPE, GraphViewNode);
}
