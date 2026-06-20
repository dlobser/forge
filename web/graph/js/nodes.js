// nodes.js — the Forge Graph node catalog. Image data flows along IMAGE slots as a
// handle { tex, size, version }. Shader nodes render into their own texture each
// time inputs/params change (feedback nodes every frame); Source/Import/Depth/AI
// nodes expose a (cached) image texture; Viewer/Save/Sequence consume. graphApp's
// rAF loop calls node.evaluate(RT) in topological order.
import { RT } from './runtime.js';
import { loadImage } from './engine.js';
import { addShaderWidgets, addAiWidgets, syncShaderWidgets } from './widgets.js';

const LG = window.LiteGraph;
const IMG = 'IMAGE';
const THUMB_H = 116;

// copy shader for the Crop/Scale node (resamples its input into a sized texture)
const CP_VERT = `#version 300 es
precision highp float; out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
const CP_FRAG = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uColor;
void main(){ o=texture(uColor, vUv); }`;

const galleryValues = () => RT.gallery.map((i) => i.filename);
const setWidget = (node, name, value) => { const w = (node.widgets || []).find((x) => x.name === name); if (w) w.value = value; };

// ── in-node image drawing ──────────────────────────────────────────────────────
function drawImage(node, ctx, tex, a) {
  ctx.fillStyle = '#0a0c0f'; ctx.fillRect(a.x, a.y, a.w, a.h);
  if (!tex) return;
  RT.engine.blitToCanvas(tex, 256);
  const s = Math.min(a.w, a.h);
  try { ctx.drawImage(RT.engine.canvas, a.x + (a.w - s) / 2, a.y + (a.h - s) / 2, s, s); } catch (e) {}
}
function attachThumb(node) {
  node.onDrawForeground = function (ctx) {
    if (this.flags.collapsed) return;
    drawImage(this, ctx, this._out && this._out.tex, { x: 0, y: this.size[1] - THUMB_H, w: this.size[0], h: THUMB_H });
    if (this._status) {
      ctx.fillStyle = this._statusColor || '#ffcc66'; ctx.font = '10px sans-serif';
      ctx.fillText(this._status, 8, this.size[1] - THUMB_H - 5);
    }
  };
}
function sizeWithThumb(node) {
  node.size = node.computeSize();
  if (node.size[0] < 210) node.size[0] = 210;
  node.size[1] += THUMB_H;
}
function ensureOut(node) {
  if (!node._out) node._out = { tex: RT.engine.allocTexture(node._size), size: node._size, version: 0 };
  return node._out;
}
function setImageOut(node, img) {
  node._tex = RT.engine.texFor(img);
  node._out = node._out || { size: RT.RENDER_SIZE, version: 0 };
  node._out.tex = node._tex; node._out.version++;
  node._status = null; RT.redraw();
}

function openFull(tex) {
  RT.engine.captureTexture(tex, 1024).then((blob) => {
    const url = URL.createObjectURL(blob);
    const ov = document.getElementById('viewerOverlay'), img = document.getElementById('viewerImg');
    img.src = url; ov.hidden = false;
    ov.onclick = () => { ov.hidden = true; URL.revokeObjectURL(url); };
  });
}

// ── Source ──────────────────────────────────────────────────────────────────────
function SourceNode() {
  this.addOutput('out', IMG);
  this.properties = { file: '' };
  this._w = this.addWidget('combo', 'image', this.properties.file || '', (v) => { this.properties.file = v; this._load(); RT.requestSave(); }, { values: galleryValues() });
  this.addWidget('button', 'refresh list', null, () => { this._w.options.values = galleryValues(); RT.redraw(); });
  this._size = RT.RENDER_SIZE;
  attachThumb(this); sizeWithThumb(this);
}
SourceNode.title = 'Source Image';
SourceNode.prototype._load = function () {
  if (!this.properties.file) return;
  this._status = 'loading…'; RT.redraw();
  loadImage(RT.imageURL(this.properties.file)).then((img) => setImageOut(this, img))
    .catch(() => { this._status = 'load failed'; this._statusColor = '#ff6666'; });
};
SourceNode.prototype.onConfigure = function () {
  if (this._w) { this._w.options.values = galleryValues(); this._w.value = this.properties.file; }
  if (this.properties.file) this._load();
};
SourceNode.prototype.evaluate = function () { if (this._out && this._out.tex) this.setOutputData(0, this._out); };

// ── Import ────────────────────────────────────────────────────────────────────
function ImportNode() {
  this.addOutput('out', IMG);
  this.properties = { file: '', reformat: false, size: 1024 };
  this.addWidget('toggle', 'reformat → square', this.properties.reformat, (v) => { this.properties.reformat = v; RT.requestSave(); });
  this.addWidget('button', 'Upload image…', null, () => this._pick());
  this._size = RT.RENDER_SIZE;
  attachThumb(this); sizeWithThumb(this);
}
ImportNode.title = 'Import';
ImportNode.prototype._pick = function () {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    this._status = 'uploading…'; RT.redraw();
    try {
      const out = await RT.api.importImage(RT.project, f, this.properties.reformat, this.properties.size);
      this.properties.file = out.filename; RT.requestSave(); RT.refreshGallery();
      loadImage(RT.imageURL(out.filename)).then((img) => setImageOut(this, img));
      RT.toast('Imported ' + out.filename, 'good');
    } catch (e) { this._status = 'upload failed'; this._statusColor = '#ff6666'; RT.toast('Import failed: ' + e.message, 'bad'); }
  };
  inp.click();
};
ImportNode.prototype.onConfigure = function () { setWidget(this, 'reformat → square', this.properties.reformat); if (this.properties.file) loadImage(RT.imageURL(this.properties.file)).then((img) => setImageOut(this, img)); };
ImportNode.prototype.evaluate = function () { if (this._out && this._out.tex) this.setOutputData(0, this._out); };

// ── Crop / Scale (set output resolution) ───────────────────────────────────────
function CropScaleNode() {
  this.addInput('image', IMG); this.addOutput('out', IMG);
  this.properties = { size: 1024 };
  this.addWidget('combo', 'size', this.properties.size, (v) => { this.properties.size = +v; this._realloc(); RT.requestSave(); }, { values: [256, 512, 1024, 2048] });
  this._size = +this.properties.size; this._dirty = true;
  attachThumb(this); sizeWithThumb(this);
}
CropScaleNode.title = 'Crop / Scale';
CropScaleNode.prototype._realloc = function () { if (this._out && this._out.tex) RT.engine.gl.deleteTexture(this._out.tex); this._out = null; this._size = +this.properties.size; this._dirty = true; };
CropScaleNode.prototype.onConfigure = function () { this._size = +this.properties.size || 1024; this._dirty = true; setWidget(this, 'size', this.properties.size); };
CropScaleNode.prototype.evaluate = function () {
  const h = this.getInputData(0);
  const v = h && h.tex ? (h.version | 0) : -1;
  if (this._dirty || v !== this._inV) {
    this._inV = v;
    ensureOut(this);
    if (h && h.tex) {
      RT.engine.renderToTexture({ key: '__cropscale', vertSrc: CP_VERT, fragSrc: CP_FRAG, inputs: ['color'], inputTextures: { color: h.tex }, controls: [] }, this._out.tex, this._size);
      this._out.version++;
    }
    this._dirty = false;
  }
  this.setOutputData(0, this._out);
};

// ── Shader (one type per scanned shader) ───────────────────────────────────────
function makeShaderNode(def) {
  // an explicit inputs:[] means a generator (no pins); only undefined defaults to color/depth
  const inputs = Array.isArray(def.inputs) ? def.inputs : ['color', 'depth'];
  const labels = def.inputLabels || {};
  // numeric controls also get an optional float input pin (drive them with math nodes)
  const pinnable = (def.controls || []).filter((c) => c.type === 'range' || c.type === 'number' || c.type === 'bool');
  function Node() {
    for (const name of inputs) this.addInput(labels[name] || name, IMG);
    for (const c of pinnable) this.addInput(c.label, 'number');
    this.addOutput('out', IMG);
    this.properties = { params: {}, simSize: def.simSize || 256, animate: false };
    addShaderWidgets(this, def);
    if (def.feedback) {
      this.addWidget('combo', 'sim grid', this.properties.simSize, (v) => { this.properties.simSize = +v; this._seed = (this._seed || 0) + 1; RT.requestSave(); }, { values: [128, 256, 512] });
      this.addWidget('button', '↺ reset sim', null, () => { RT.engine.resetSim('n' + this.id); this._seed = (this._seed || 0) + 1; });
    } else if (def.animated) {
      // time-driven (non-feedback) shaders: an explicit animate toggle drives uTime
      this.addWidget('toggle', 'animate', !!this.properties.animate, (v) => { this.properties.animate = v; this._dirty = true; RT.requestSave(); });
    }
    this._def = def; this._size = RT.RENDER_SIZE; this._dirty = true;
    attachThumb(this); sizeWithThumb(this);
  }
  Node.title = def.name || def.key;
  Node.prototype.onConfigure = function () { this._dirty = true; syncShaderWidgets(this); };
  Node.prototype.evaluate = function () {
    const inTex = {}; const vers = [];
    inputs.forEach((name, i) => {
      const h = this.getInputData(i);
      if (h && h.tex) { inTex[name] = h.tex; vers.push(h.version | 0); } else vers.push(-1);
    });
    // resolve params: a connected float pin overrides its widget value
    const params = Object.assign({}, this.properties.params);
    pinnable.forEach((c, j) => {
      const v = this.getInputData(inputs.length + j);
      if (typeof v === 'number' && !isNaN(v)) params[c.uniform] = (c.type === 'bool') ? (v > 0.5) : v;
    });
    const feedback = !!def.feedback;
    const animate = feedback || (def.animated && this.properties.animate);   // re-render every frame
    const vkey = vers.join(',');
    const pkey = JSON.stringify(params) + '|' + this.properties.simSize + '|' + (this._seed || 0) + '|' + (this.properties.animate ? 1 : 0);
    if (this._dirty || animate || vkey !== this._vkey || pkey !== this._pkey) {
      ensureOut(this);
      const simSize = +this.properties.simSize || def.simSize || 256;
      RT.engine.renderToTexture({
        key: def.key, vertSrc: def.vertSrc, fragSrc: def.fragSrc,
        controls: def.controls || [], params,
        inputs, inputTextures: inTex,
        feedback, simSize, simKey: 'n' + this.id, advance: feedback, time: RT.time,
        resetToken: 'n' + this.id + '|' + simSize + '|' + vkey + '|' + (this._seed || 0),
      }, this._out.tex, this._size);
      this._out.version++;
      this._dirty = false; this._vkey = vkey; this._pkey = pkey;
    }
    this.setOutputData(0, this._out);
  };
  Node.prototype.onDblClick = function () { if (this._out && this._out.tex) openFull(this._out.tex); };
  LG.registerNodeType('forge/shader/' + def.key, Node);
}

// ── Depth (auto-bakes via ComfyUI on input change) ─────────────────────────────
function DepthNode() {
  this.addInput('image', IMG); this.addOutput('depth', IMG);
  this.properties = { output: '' };
  this._size = RT.RENDER_SIZE; this._status = 'connect an image';
  attachThumb(this); this.size = [210, 120 + THUMB_H];
}
DepthNode.title = 'Depth (ComfyUI)';
DepthNode.prototype.evaluate = function () {
  const h = this.getInputData(0);
  const v = h && h.tex ? (h.version | 0) : -1;
  if (v !== this._inV) { this._inV = v; if (h && h.tex) this._schedule(h); }
  if (this._out && this._out.tex) this.setOutputData(0, this._out);
};
DepthNode.prototype._schedule = function (h) {
  clearTimeout(this._t); this._status = 'depth queued…'; this._statusColor = '#ffcc66'; RT.redraw();
  this._t = setTimeout(() => this._bake(h), 600);
};
DepthNode.prototype._bake = async function (h) {
  try {
    this._status = 'depth…'; RT.redraw();
    const blob = await RT.engine.captureTexture(h.tex, h.size || RT.RENDER_SIZE);
    const saved = await RT.api.renderSave(RT.project, 'depth_in', blob, { graph: true, intermediate: true });
    const out = await RT.api.depth(RT.project, saved.filename);
    this.properties.output = out.filename; RT.requestSave(); RT.refreshGallery();
    loadImage(RT.imageURL(out.filename) + '&v=' + Date.now()).then((img) => setImageOut(this, img));
  } catch (e) { this._status = 'depth failed'; this._statusColor = '#ff6666'; RT.toast('Depth failed: ' + e.message, 'bad'); }
};

// ── AI workflow (one type per workflow; manual Generate) ───────────────────────
function makeAiNode(wf) {
  function Node() {
    this.addInput('image', IMG);
    this.addOutput('out', IMG);
    this.properties = { values: {}, output: '', randomizeSeed: true };
    this._wf = wf; this._size = RT.RENDER_SIZE;
    RT.checkComfy();   // refresh the status dot when an AI node appears
    this.addWidget('button', '⚡ Generate', null, () => this._generate());
    this._status = 'loading schema…';
    attachThumb(this); this.size = [240, 80 + THUMB_H];
    RT.api.workflowSchema(wf.key).then((schema) => {
      this._schema = schema;
      // label input pins from the schema's slots (depth/image/…); drop the default
      // pin entirely for workflows that take no image input (pure txt2img).
      const slots = schema.imageSlots || [];
      if (slots.length === 0) { if (this.inputs && this.inputs[0]) this.removeInput(0); }
      else {
        this.inputs[0].name = slots[0].label;
        slots.slice(1).forEach((s) => this.addInput(s.label || 'image', IMG));
      }
      addAiWidgets(this, schema);
      if (schema.params.some((p) => /seed/i.test(p.input || '')))
        this.addWidget('toggle', 'randomize seed', this.properties.randomizeSeed !== false, (v) => { this.properties.randomizeSeed = v; RT.requestSave(); });
      this._status = this.properties.output ? null : 'not generated';
      if (this.properties.output) loadImage(RT.imageURL(this.properties.output) + '&v=' + Date.now()).then((img) => setImageOut(this, img));
      sizeWithThumb(this); RT.redraw();
    }).catch((e) => { this._status = 'schema error'; this._statusColor = '#ff6666'; });
  }
  Node.title = 'AI: ' + (wf.name || wf.key);
  Node.prototype._generate = async function () {
    if (!this._schema) return RT.toast('Schema still loading', 'bad');
    if (!RT.comfyOk) { RT.toast('ComfyUI not reachable', 'bad'); return; }
    this._status = 'generating…'; this._statusColor = '#ffcc66'; RT.redraw();
    try {
      if (this.properties.randomizeSeed !== false) {
        for (const p of this._schema.params) if (/seed/i.test(p.input || '')) {
          const r = Math.floor(Math.random() * 1e15);
          this.properties.values[p.id] = r; setWidget(this, p.label, r);
        }
      }
      const slots = this._schema.imageSlots || [];
      const images = {};
      for (let i = 0; i < slots.length; i++) {
        const h = this.getInputData(i);
        if (h && h.tex) {
          const blob = await RT.engine.captureTexture(h.tex, h.size || RT.RENDER_SIZE);
          const saved = await RT.api.renderSave(RT.project, wf.key + '_in', blob, { graph: true, intermediate: true });
          images[slots[i].id] = saved.filename;
        }
      }
      const values = {};
      for (const p of this._schema.params) values[p.id] = this.properties.values[p.id] !== undefined ? this.properties.values[p.id] : p.value;
      const out = await RT.api.generate({ project: RT.project, key: wf.key, name: wf.name || wf.key, values, images });
      this.properties.output = out.filename; RT.requestSave(); RT.refreshGallery();
      this._status = null;
      loadImage(RT.imageURL(out.filename) + '&v=' + Date.now()).then((img) => setImageOut(this, img))
        .catch(() => { this._status = 'generated (preview failed)'; });
      RT.toast('Generated ' + out.filename, 'good');
    } catch (e) { this._status = 'generate failed'; this._statusColor = '#ff6666'; RT.toast('Generate failed: ' + e.message, 'bad'); }
  };
  Node.prototype.evaluate = function () { if (this._out && this._out.tex) this.setOutputData(0, this._out); };
  Node.prototype.onDblClick = function () { if (this._out && this._out.tex) openFull(this._out.tex); };
  LG.registerNodeType('forge/ai/' + wf.key, Node);
}

// ── Viewer ────────────────────────────────────────────────────────────────────
function ViewerNode() {
  this.addInput('image', IMG);
  this.properties = {};
  this.size = [300, 300];
  this.addWidget('button', '⤢ fullscreen', null, () => { if (this._tex) openFull(this._tex); });
  this.onDrawForeground = function (ctx) {
    if (this.flags.collapsed) return;
    drawImage(this, ctx, this._tex, { x: 0, y: 30, w: this.size[0], h: this.size[1] - 30 });
  };
}
ViewerNode.title = 'Viewer';
ViewerNode.prototype.onResize = function () { if (this.size[1] < 120) this.size[1] = 120; };
ViewerNode.prototype.evaluate = function () { const h = this.getInputData(0); this._tex = h && h.tex ? h.tex : null; };
ViewerNode.prototype.onDblClick = function () { if (this._tex) openFull(this._tex); };

// ── Save ──────────────────────────────────────────────────────────────────────
function SaveNode() {
  this.addInput('image', IMG);
  this.properties = { name: 'graph' };
  this.addWidget('text', 'name', this.properties.name, (v) => { this.properties.name = v; RT.requestSave(); });
  this.addWidget('button', 'Save → gallery', null, () => this._save());
  this.size = [220, 90];
}
SaveNode.title = 'Save';
SaveNode.prototype._save = async function () {
  const h = this.getInputData(0);
  if (!h || !h.tex) return RT.toast('Connect an image', 'bad');
  try {
    const blob = await RT.engine.captureTexture(h.tex, h.size || RT.RENDER_SIZE);
    const out = await RT.api.renderSave(RT.project, this.properties.name || 'graph', blob, { graph: true });
    RT.refreshGallery(); RT.toast('Saved ' + out.filename, 'good');
  } catch (e) { RT.toast('Save failed: ' + e.message, 'bad'); }
};
SaveNode.prototype.evaluate = function () {};
SaveNode.prototype.onConfigure = function () { setWidget(this, 'name', this.properties.name); };

// ── Sequence → Video ───────────────────────────────────────────────────────────
function SequenceNode() {
  this.addInput('image', IMG);
  this.properties = { name: 'graph_seq', fps: 24, frames: 48 };
  this.addWidget('number', 'fps', this.properties.fps, (v) => { this.properties.fps = Math.round(v); RT.requestSave(); }, { min: 1, max: 60, step: 1 });
  this.addWidget('number', 'frames', this.properties.frames, (v) => { this.properties.frames = Math.round(v); RT.requestSave(); }, { min: 1, max: 3600, step: 1 });
  this.addWidget('button', 'Render sequence', null, () => this._render());
  this.addWidget('button', 'Make video', null, () => this._video());
  this.size = [220, 140];
}
SequenceNode.title = 'Sequence → Video';
SequenceNode.prototype._render = async function () {
  const probe = this.getInputData(0);
  if (!probe || !probe.tex) return RT.toast('Connect an image', 'bad');
  const n = this.properties.frames, name = this.properties.name;
  RT.capturing = true;
  try {
    RT.engine.resetSim();                       // reseed all feedback sims
    await RT.api.seqClear(RT.project, name);
    for (let i = 0; i < n; i++) {
      RT.evalOnce(true);                        // advance one frame
      const h = this.getInputData(0);
      const blob = await RT.engine.captureTexture(h.tex, h.size || RT.RENDER_SIZE);
      await RT.api.seqFrame(RT.project, name, i, blob);
      this._status = `frame ${i + 1}/${n}`; RT.redraw();
    }
    await RT.api.videoCommand(RT.project, name, this.properties.fps);
    this._status = `rendered ${n} frames`;
    RT.toast(`Rendered ${n} frames`, 'good');
  } catch (e) { RT.toast('Sequence failed: ' + e.message, 'bad'); }
  finally { RT.capturing = false; }
};
SequenceNode.prototype._video = async function () {
  try {
    const res = await RT.api.videoMake(RT.project, this.properties.name, this.properties.fps);
    RT.toast(res.ok ? 'Video: ' + res.out : 'ffmpeg failed (see log)', res.ok ? 'good' : 'bad');
    if (!res.ok) console.warn(res.log);
  } catch (e) { RT.toast('Video failed: ' + e.message, 'bad'); }
};
SequenceNode.prototype.evaluate = function () {};
SequenceNode.prototype.onConfigure = function () { setWidget(this, 'fps', this.properties.fps); setWidget(this, 'frames', this.properties.frames); };

// ── Math node (one per file in /mathnodes; outputs floats to drive shader pins) ──
function makeMathNode(item) {
  const def = item.def;
  function Node() {
    for (const inp of def.inputs || []) this.addInput(inp.name, 'number');
    for (const o of def.outputs || []) this.addOutput(typeof o === 'string' ? o : o.name, 'number');
    this.properties = { vals: {} };
    for (const inp of def.inputs || []) {
      if (this.properties.vals[inp.name] === undefined) this.properties.vals[inp.name] = inp.value ?? 0;
      this.addWidget('number', inp.name, this.properties.vals[inp.name],
        (v) => { this.properties.vals[inp.name] = v; RT.requestSave(); }, { step: inp.step ?? 0.1 });
    }
    this.size = this.computeSize(); if (this.size[0] < 130) this.size[0] = 130;
  }
  Node.title = def.name || item.key;
  Node.prototype.onConfigure = function () { for (const inp of def.inputs || []) setWidget(this, inp.name, this.properties.vals[inp.name]); };
  Node.prototype.evaluate = function () {
    const i = {};
    (def.inputs || []).forEach((inp, idx) => {
      const v = this.getInputData(idx);
      i[inp.name] = (typeof v === 'number' && !isNaN(v)) ? v : this.properties.vals[inp.name];
    });
    let out = {};
    try { out = def.compute(i, { time: RT.time, dt: RT.dt || 0, frame: RT.frame }) || {}; } catch (e) {}
    (def.outputs || []).forEach((o, idx) => this.setOutputData(idx, out[typeof o === 'string' ? o : o.name]));
  };
  LG.registerNodeType('math/' + item.key, Node);
}

// ── registration ────────────────────────────────────────────────────────────────
export function registerNodes() {
  LG.registerNodeType('forge/source', SourceNode);
  LG.registerNodeType('forge/import', ImportNode);
  LG.registerNodeType('forge/crop_scale', CropScaleNode);
  LG.registerNodeType('forge/depth', DepthNode);
  LG.registerNodeType('forge/viewer', ViewerNode);
  LG.registerNodeType('forge/save', SaveNode);
  LG.registerNodeType('forge/sequence', SequenceNode);
  for (const def of RT.shaderDefs) makeShaderNode(def);
  for (const wf of RT.workflows) makeAiNode(wf);
  for (const m of RT.mathDefs) makeMathNode(m);
}
