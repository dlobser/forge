// nodes.js — the Forge Graph node catalog. Image data flows along IMAGE slots as a
// handle { tex, width, height, version }. Shader nodes render into their own texture each
// time inputs/params change (feedback nodes every frame); Source/Import/Depth/AI
// nodes expose a (cached) image texture; Viewer/Save/Sequence consume. graphApp's
// rAF loop calls node.evaluate(RT) in topological order.
import { RT } from './runtime.js';
import { loadImage } from './engine.js';
import { downloadTexture, openLiveView } from './liveview.js';
import { addShaderWidgets, addSingleShaderWidget, addAiWidgets, syncShaderWidgets, markDirty } from './widgets.js';

const LG = window.LiteGraph;
const IMG = 'IMAGE';
const THUMB_H = 116;

// ── node type names ─────────────────────────────────────────────────────────────
// Types are "category/name", and litegraph builds its Add-node menu straight from
// the category half. Everything used to live under one flat `forge/` category, which
// told you nothing you didn't already know — you are in Forge. Now the category says
// what the node is FOR (input, image, effect, generate, cellular, feedback, depth,
// control, output, ai, utility), and shader nodes get theirs from `category` in
// their own manifest, so adding a shader files it correctly with no changes here.
export const T = {
  SOURCE: 'input/source',
  IMPORT: 'input/import',
  URL_IMAGE: 'input/url_image',
  WEBCAM: 'input/webcam',
  AUDIO: 'input/audio_reactive',
  CROP: 'image/crop_scale',
  SLIDER: 'control/slider',
  NUMBER: 'control/number',
  TOGGLE: 'control/toggle',
  DEPTH: 'ai/depth',
  VIEWER: 'output/viewer',
  VIEWER_WINDOW: 'output/viewer_window',
  SAVE: 'output/save',
  SEQUENCE: 'output/sequence',
  PASS_THROUGH: 'utility/pass_through',
};

// Graphs saved before the reshuffle name the old types. Rather than migrate files
// (share links and exported bundles are out there too, and can't be migrated at
// all), resolve old names to new ones when a node is created — see
// installTypeAliases. Re-saving a graph then quietly writes the new names.
const LEGACY = {
  'forge/source': T.SOURCE,
  'forge/import': T.IMPORT,
  'forge/url_image': T.URL_IMAGE,
  'forge/crop_scale': T.CROP,
  'forge/control/slider': T.SLIDER,
  'forge/control/number': T.NUMBER,
  'forge/control/toggle': T.TOGGLE,
  'forge/depth': T.DEPTH,
  'forge/viewer': T.VIEWER,
  'forge/viewer_window': T.VIEWER_WINDOW,
  'forge/save': T.SAVE,
  'forge/sequence': T.SEQUENCE,
  'forge/pass_through': T.PASS_THROUGH,
};

// Type tests that accept both spellings, for the few places outside this file that
// care what a node is (the Author-UI panel, the published page).
export const isViewer = (n) => !!n && (n.type === T.VIEWER || n.type === 'forge/viewer');
export const isSource = (n) => !!n && (n.type === T.SOURCE || n.type === 'forge/source');

const resolveType = (type) => (!LG.registered_node_types[type] && LEGACY[type]) ? LEGACY[type] : type;

let aliasesInstalled = false;
function installTypeAliases() {
  if (aliasesInstalled) return;
  aliasesInstalled = true;

  // Creating a node by an old name gives you the new one…
  const origCreate = LG.createNode;
  LG.createNode = function (type, title, options) {
    return origCreate.call(this, resolveType(type), title, options);
  };

  // …and loading one does too. This second hook is the one that matters: litegraph
  // creates the node from the saved type (so the alias above picks the right class)
  // and then copies the whole saved record onto it — including `type`, which would
  // put the old string straight back and leave every `node.type` check looking at a
  // name that is no longer registered. Rewriting it here means a loaded graph is
  // fully migrated in memory, and the next save writes the new names. Paste comes
  // through the same path, so old clipboard payloads work too.
  const proto = window.LGraphNode && window.LGraphNode.prototype;
  if (proto && proto.configure) {
    const origConfigure = proto.configure;
    proto.configure = function (info) {
      if (info && info.type && resolveType(info.type) !== info.type) {
        info = Object.assign({}, info, { type: resolveType(info.type) });
      }
      return origConfigure.call(this, info);
    };
  }
}

// Snapshot litegraph's bundled node types NOW, at module load — before graphApp/play
// call clearRegisteredTypes(). registerBuiltins() re-registers a curated few after
// the Forge catalog, so the useful bundled nodes survive the clear. (litegraph.js is
// a classic script and has already registered its built-ins by the time this module
// evaluates.)
const LG_BUILTINS = Object.assign({}, LG.registered_node_types || {});

// Bundled nodes worth surfacing. The bar: each must output a NUMBER (so it can drive
// a shader/math pin), ADD something Forge's own math nodes lack, and be safe in a
// graph a stranger might share. Deliberately excluded after testing:
//   • math/formula   — runs new Function(authorString); arbitrary JS from a shared
//                      link is an XSS vector, so never in a share-by-link tool
//   • logic/*        — output `boolean`, which won't connect to a number pin
//   • basic/const, math/trigonometry — duplicate Forge's float / sine+cosine nodes
// What's left are stateful helpers Forge's stateless math model can't easily do:
const BUILTIN_ALLOW = [
  'math/rand',          // random value (Forge has no randomness node)
  'math/tendTo',        // eases toward its input — smooths a jumpy slider
  'math/accumulate',    // running sum / integrator (needs per-frame state)
  'basic/watch',        // shows a value on the node face (debug readout)
];

function registerBuiltins() {
  for (const type of BUILTIN_ALLOW) {
    const ctor = LG_BUILTINS[type];
    if (ctor) LG.registerNodeType(type, ctor);
    else console.warn('Forge: bundled node not found:', type);
  }
}

// Copy shader for the Crop/Scale node: resamples its input into a sized texture,
// with a pan and a zoom on top so you can choose WHICH part of the image survives
// the crop instead of always getting the centre.
//   uMode 0 = stretch (fill, ignore aspect) · 1 = crop (cover) · 2 = letterbox (contain)
//   uZoom  scales the source about the pan point; >1 moves in closer
//   uOffX/uOffY  pan, in fractions of the output frame (0 = centred)
//   uEdgeMode  what to show outside the image: 0 black · 1 clamp/smear · 2 wrap · 3 mirror
const CP_VERT = `#version 300 es
precision highp float; out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
const CP_FRAG = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uColor; uniform vec2 uResolution;
uniform float uInW, uInH, uMode, uZoom, uOffX, uOffY, uRotate, uEdgeMode, uFlipX, uFlipY;

// Map a uv that may sit outside 0..1 into the image, per the edge rule. Returns
// false when the sample should read as empty (black).
bool edge(inout vec2 uv){
  if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) return true;
  if (uEdgeMode < 0.5) return false;
  if (uEdgeMode < 1.5) { uv = clamp(uv, 0.0, 1.0); return true; }
  if (uEdgeMode < 2.5) { uv = fract(uv); return true; }
  uv = abs(fract(uv * 0.5 + 0.5) * 2.0 - 1.0); return true;
}

void main(){
  float inW = max(uInW, 1.0), inH = max(uInH, 1.0);
  // 'frac' is the slice of the source that the output frame covers, in source uv.
  vec2 frac = vec2(1.0);
  if (uMode > 0.5) {
    float scale = (uMode < 1.5) ? max(uResolution.x / inW, uResolution.y / inH)
                                : min(uResolution.x / inW, uResolution.y / inH);
    frac = uResolution / (vec2(inW, inH) * scale);
  }
  vec2 p = vUv - 0.5;
  float a = uRotate * 3.14159265359 / 180.0;
  float ca = cos(a), sa = sin(a);
  float aspect = max(uResolution.x, 1.0) / max(uResolution.y, 1.0);
  p.x *= aspect;
  p = mat2(ca, -sa, sa, ca) * p;
  p.x /= aspect;
  vec2 uv = 0.5 + (p / max(uZoom, 1e-4) - vec2(uOffX, uOffY)) * frac;
  if (uFlipX > 0.5) uv.x = 1.0 - uv.x;
  if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
  if (!edge(uv)) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  o = texture(uColor, uv);
}`;
const CP_CONTROLS = [
  { uniform: 'uInW', value: 1024 }, { uniform: 'uInH', value: 1024 }, { uniform: 'uMode', value: 0 },
  { uniform: 'uZoom', value: 1 }, { uniform: 'uOffX', value: 0 }, { uniform: 'uOffY', value: 0 },
  { uniform: 'uRotate', value: 0 }, { uniform: 'uEdgeMode', value: 0 },
  { uniform: 'uFlipX', value: 0 }, { uniform: 'uFlipY', value: 0 },
];
const FIT_MODES = { stretch: 0, crop: 1, letterbox: 2 };
const EDGE_MODES = { black: 0, clamp: 1, wrap: 2, mirror: 3 };

const galleryValues = () => RT.gallery.map((i) => i.filename);
const setWidget = (node, name, value) => { const w = (node.widgets || []).find((x) => x.name === name); if (w) w.value = value; };

// ── in-node image drawing ──────────────────────────────────────────────────────
// Node previews used to blit the output texture at its FULL size into the shared GL
// canvas on every litegraph repaint — so a graph rendering at 2048² paid for a
// 2048² blit per node per frame just to fill a 116px thumbnail, and paying it even
// while paused is what made a paused 2K graph crawl. Two fixes: blit no larger than
// the thumbnail actually needs, and keep the result in a per-node canvas that is
// only refreshed when the output changes. A paused graph then costs nothing but the
// drawImage of a cached bitmap.
function previewCanvas(node, tex, w, h, maxDim) {
  const version = (node._out && node._out.version) | 0;
  const key = version + '|' + w + 'x' + h + '|' + maxDim + '|' + (tex ? 1 : 0);
  let c = node._pvCanvas;
  if (!c) { c = node._pvCanvas = document.createElement('canvas'); node._pvKey = null; }
  if (node._pvKey === key) return c;
  let r;
  try { r = RT.engine.blitToCanvas(tex, w, h, maxDim); } catch (e) { return c; }
  if (c.width !== r.width || c.height !== r.height) { c.width = r.width; c.height = r.height; }
  const cx = c.getContext('2d');
  cx.clearRect(0, 0, r.width, r.height);
  try { cx.drawImage(RT.engine.canvas, 0, 0); } catch (e) { return c; }
  node._pvKey = key;
  return c;
}

// Quantised so dragging a Viewer's corner doesn't invalidate the cache on every
// pixel of the drag (and doesn't reallocate the GL canvas 60 times a second).
const quantize = (v, step) => Math.max(step, Math.ceil(v / step) * step);

function drawImage(node, ctx, tex, a) {
  ctx.fillStyle = '#0a0c0f'; ctx.fillRect(a.x, a.y, a.w, a.h);
  if (!tex) return;
  const out = node._out || {}, w = out.width || RT.RENDER_SIZE, h = out.height || RT.RENDER_SIZE;
  const maxDim = Math.min(2048, quantize(Math.max(a.w, a.h) * 1.5, 128));
  const c = previewCanvas(node, tex, w, h, maxDim);
  if (!c.width) return;
  const s = Math.min(a.w / w, a.h / h), dw = w * s, dh = h * s;
  try { ctx.drawImage(c, a.x + (a.w - dw) / 2, a.y + (a.h - dh) / 2, dw, dh); } catch (e) {}
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
const imageSize = (h) => ({ width: (h && h.width) || RT.RENDER_SIZE, height: (h && h.height) || RT.RENDER_SIZE });
const nodeRenderSize = (node, input) => {
  const fallback = imageSize(input);
  return {
    width: (node.properties && (+node.properties.renderWidth || +node.properties.renderSize)) || fallback.width,
    height: (node.properties && (+node.properties.renderHeight || +node.properties.renderSize)) || fallback.height,
  };
};
function ensureOut(node) {
  // node._size is the desired render resolution; realloc the texture if it changed
  if (node._out && (node._out.width !== node._size.width || node._out.height !== node._size.height)) { RT.engine.gl.deleteTexture(node._out.tex); node._out = null; }
  if (!node._out) node._out = { tex: RT.engine.allocTexture(node._size.width, node._size.height), width: node._size.width, height: node._size.height, version: 0 };
  return node._out;
}
// Same, for a shader whose manifest declares several `outputs`: one texture per
// output slot, all at the node's render size. _out stays the first one, so the
// thumbnail, fullscreen and download paths keep working unchanged.
function ensureOuts(node, count) {
  const w = node._size.width, h = node._size.height;
  if (node._outs && (node._outs.length !== count || node._outs[0].width !== w || node._outs[0].height !== h)) {
    for (const o of node._outs) RT.engine.gl.deleteTexture(o.tex);
    node._outs = null;
  }
  if (!node._outs) {
    node._outs = [];
    for (let i = 0; i < count; i++)
      node._outs.push({ tex: RT.engine.allocTexture(w, h), width: w, height: h, version: 0 });
  }
  node._out = node._outs[0];
  return node._outs;
}
function setImageOut(node, img) {
  node._tex = RT.engine.texFor(img);
  const width = img.naturalWidth || img.width || RT.RENDER_SIZE, height = img.naturalHeight || img.height || RT.RENDER_SIZE;
  node._out = node._out || { version: 0 };
  node._out.tex = node._tex; node._out.width = width; node._out.height = height; node._out.version++;
  node._status = null; RT.redraw();
}

// Fullscreen a node's output. Polls the node every frame rather than snapshotting
// it, so an animating graph keeps animating in fullscreen — see liveview.js.
function openFull(node) {
  openLiveView(() => {
    const tex = node._tex || (node._out && node._out.tex);
    if (!tex) return null;
    const s = imageSize(node._out);
    return { tex, width: s.width, height: s.height };
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

// ── URL Image ───────────────────────────────────────────────────────────────────
// Loads an image straight from a remote URL. Unlike Import (which stores bytes in
// the browser), this node keeps only the URL string — so a graph that uses it stays
// tiny and travels in a share link. The catch is CORS: WebGL will not texture a
// cross-origin image unless the host sends Access-Control-Allow-Origin. Hosts that
// do: GitHub (raw/Pages), imgur, Wikimedia, Cloudflare, most CDNs, S3 (one setting).
//
// `loadImage` (engine.js) handles the awkward cases: it sends no referer, so
// hotlink-protected hosts like imgur don't refuse a localhost page, and when a host
// genuinely sends no CORS header it retries through the desktop backend's image
// proxy. What's left — a host that is down, or a static deployment with no backend
// to proxy through — reports a clear message instead of a silent black square.
function UrlImageNode() {
  this.addOutput('out', IMG);
  this.properties = { url: '' };
  this.addWidget('text', 'image url', this.properties.url, (v) => {
    this.properties.url = (v || '').trim(); this._load(); RT.requestSave();
  });
  this.addWidget('button', 'reload', null, () => this._load());
  this._size = RT.RENDER_SIZE;
  attachThumb(this); sizeWithThumb(this);
  if (!this.properties.url) this._status = 'paste an image URL';
}
UrlImageNode.title = 'URL Image';
UrlImageNode.prototype._load = function () {
  const url = this.properties.url;
  if (!url) { this._out = null; this._tex = null; this._status = 'paste an image URL'; RT.redraw(); return; }
  if (!/^https?:\/\//i.test(url)) { this._status = 'url must start with http(s)://'; this._statusColor = '#ff6666'; RT.redraw(); return; }
  this._status = 'loading…'; this._statusColor = '#ffcc66'; RT.redraw();
  loadImage(url)
    .then((img) => { setImageOut(this, img); this._status = null; })
    .catch(() => {
      // Either the host is unreachable or it sent no CORS header. We can't tell
      // which from the browser, so name the likely cause and the fix.
      this._status = "can't embed — host must allow CORS (try GitHub / imgur)";
      this._statusColor = '#ff6666'; this._out = null; this._tex = null; RT.redraw();
    });
};
UrlImageNode.prototype.onConfigure = function () {
  setWidget(this, 'image url', this.properties.url);
  if (this.properties.url) this._load();
};
UrlImageNode.prototype.evaluate = function () { if (this._out && this._out.tex) this.setOutputData(0, this._out); };

// ── Webcam ──────────────────────────────────────────────────────────────────────
// A live camera as an image source. The browser only hands over a stream after the
// user grants permission, and only on a secure origin — https, or localhost, which
// the desktop server is, so this works there without a certificate.
//
// The frame goes through the same crop/fit shader the Crop node uses, so a 16:9
// camera can fill a square render without being squashed, and Mirror is on by
// default because an un-mirrored camera feels wrong to anyone looking at themselves.
//
// Nothing about the stream is saved in the graph except the settings — no frames, no
// device permission. A shared link opens with the camera stopped.
function WebcamNode() {
  this.addOutput('out', IMG);
  this.properties = { playing: false, mirror: true, fit: 'crop', width: 0, height: 0, deviceLabel: '' };
  const p = this.properties;
  this._playBtn = this.addWidget('button', '▶ Start camera', null, () => this._toggle());
  this.addWidget('toggle', 'mirror', p.mirror, (v) => { p.mirror = v; this._dirty = true; RT.requestSave(); });
  this.addWidget('combo', 'fit', p.fit, (v) => { p.fit = v; this._dirty = true; RT.requestSave(); }, { values: ['stretch', 'crop', 'letterbox'] });
  this._camWidget = this.addWidget('combo', 'camera', p.deviceLabel || 'default', (v) => {
    p.deviceLabel = v === 'default' ? '' : v;
    if (this._stream) { this._stop(); this._start(); }
    RT.requestSave();
  }, { values: ['default'] });
  this._size = { width: RT.RENDER_SIZE, height: RT.RENDER_SIZE };
  this._status = 'camera off'; this._statusColor = '#8a929c';
  attachThumb(this); sizeWithThumb(this);
}
WebcamNode.title = 'Webcam';
WebcamNode.prototype._toggle = function () { if (this._stream) this._stop(); else this._start(); };
WebcamNode.prototype._start = async function () {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    this._status = 'no camera API (needs https or localhost)'; this._statusColor = '#ff6666'; RT.redraw(); return;
  }
  this._status = 'asking for camera…'; this._statusColor = '#ffcc66'; RT.redraw();
  try {
    const want = this.properties.deviceLabel;
    let constraint = { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    if (want) {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const hit = devs.find((d) => d.label === want);
      if (hit) constraint = { video: { deviceId: { exact: hit.deviceId } }, audio: false };
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraint);
    this._stream = stream;
    const v = this._video || (this._video = document.createElement('video'));
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.srcObject = stream;
    await v.play().catch(() => {});
    this.properties.playing = true;
    this._playBtn.name = '⏸ Pause camera';
    this._status = '● live'; this._statusColor = '#37d0a0';
    // Device labels are blank until permission is granted, so fill the list now.
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.label);
      this._camWidget.options.values = ['default'].concat(devs.map((d) => d.label));
    } catch (e) { /* not fatal */ }
    RT.redraw();
  } catch (e) {
    this._status = 'camera blocked or busy'; this._statusColor = '#ff6666';
    RT.toast('Camera: ' + (e.message || e.name), 'bad'); RT.redraw();
  }
};
WebcamNode.prototype._stop = function () {
  if (this._stream) { for (const t of this._stream.getTracks()) t.stop(); this._stream = null; }
  if (this._video) this._video.srcObject = null;
  this.properties.playing = false;
  this._playBtn.name = '▶ Start camera';
  this._status = 'camera off'; this._statusColor = '#8a929c'; RT.redraw();
};
WebcamNode.prototype.onRemoved = function () { this._stop(); };
WebcamNode.prototype.onConfigure = function () {
  setWidget(this, 'mirror', this.properties.mirror);
  setWidget(this, 'fit', this.properties.fit || 'crop');
  setWidget(this, 'camera', this.properties.deviceLabel || 'default');
  // A saved graph never auto-opens the camera: a page that grabs your webcam the
  // moment it loads is not a page anyone should have to trust.
  this.properties.playing = false;
};
WebcamNode.prototype.evaluate = function () {
  const v = this._video;
  const live = this._stream && v && v.readyState >= 2 && v.videoWidth > 0;
  // Frozen transport freezes the camera too, so pause really does mean "stop
  // working" — otherwise a live feed would keep every downstream node re-rendering.
  const advance = live && (RT.playing || RT.capturing);
  if (live) {
    this._size = nodeRenderSize(this, { width: v.videoWidth, height: v.videoHeight });
    ensureOut(this);
    if (advance || this._dirty) {
      const tex = RT.engine.texFromVideo(v);
      RT.engine.renderToTexture({
        key: '__cropscale', vertSrc: CP_VERT, fragSrc: CP_FRAG, inputs: ['color'], inputTextures: { color: tex },
        controls: CP_CONTROLS,
        params: {
          uInW: v.videoWidth, uInH: v.videoHeight, uMode: FIT_MODES[this.properties.fit] || 1,
          uZoom: 1, uOffX: 0, uOffY: 0, uRotate: 0, uEdgeMode: 0,
          uFlipX: this.properties.mirror ? 1 : 0, uFlipY: 0,
        },
      }, this._out.tex, this._size.width, this._size.height);
      this._out.version++;
      this._dirty = false;
    }
  }
  if (this._out && this._out.tex) this.setOutputData(0, this._out);
};
WebcamNode.prototype.onDblClick = function () { if (this._out && this._out.tex) openFull(this); };

// ── Audio Reactive ──────────────────────────────────────────────────────────────
// Microphone level → a number, for driving anything that takes a float pin. The
// analyser gives a spectrum; `band` picks which slice of it to listen to (bass for
// kick drums, treble for hats, all for overall loudness), and the level is then
// mapped into your own min..max range so it lands wherever the target control wants
// it — no separate Remap node needed.
//
// Smoothing is a one-pole filter: 0 is raw and jumpy, 0.9 is slow and syrupy. The
// meter on the node face shows the mapped output so you can dial gain by eye.
const BANDS = { all: [20, 16000], bass: [20, 200], low: [80, 500], mid: [500, 2000], high: [2000, 8000], treble: [6000, 16000] };
function AudioReactiveNode() {
  this.addOutput('value', 'number');
  this.addOutput('raw 0-1', 'number');
  this.properties = { min: 0, max: 1, band: 'all', gain: 1, smooth: 0.6, floor: 0.02, playing: false };
  const p = this.properties;
  this._playBtn = this.addWidget('button', '▶ Start mic', null, () => this._toggle());
  this.addWidget('combo', 'band', p.band, (v) => { p.band = v; RT.requestSave(); }, { values: Object.keys(BANDS) });
  this.addWidget('slider', 'gain', p.gain, (v) => { p.gain = v; RT.requestSave(); }, { min: 0.1, max: 20, step: 0.1 });
  this.addWidget('slider', 'smooth', p.smooth, (v) => { p.smooth = v; RT.requestSave(); }, { min: 0, max: 0.98, step: 0.01 });
  this.addWidget('slider', 'noise floor', p.floor, (v) => { p.floor = v; RT.requestSave(); }, { min: 0, max: 0.5, step: 0.005 });
  this.addWidget('number', 'min', p.min, (v) => { p.min = v; RT.requestSave(); }, { step: 0.1 });
  this.addWidget('number', 'max', p.max, (v) => { p.max = v; RT.requestSave(); }, { step: 0.1 });
  this._level = 0; this._out01 = 0;
  this._status = 'mic off'; this._statusColor = '#8a929c';
  this.size = this.computeSize(); if (this.size[0] < 210) this.size[0] = 210;
  this.size[1] += 22;   // room for the meter
}
AudioReactiveNode.title = 'Audio Reactive';
AudioReactiveNode.prototype._toggle = function () { if (this._ctx) this._stop(); else this._start(); };
AudioReactiveNode.prototype._start = async function () {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    this._status = 'no audio API (needs https or localhost)'; this._statusColor = '#ff6666'; RT.redraw(); return;
  }
  this._status = 'asking for mic…'; this._statusColor = '#ffcc66'; RT.redraw();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.4;
    src.connect(analyser);            // deliberately NOT connected to the output: no feedback howl
    this._stream = stream; this._ctx = ctx; this._analyser = analyser;
    this._bins = new Uint8Array(analyser.frequencyBinCount);
    this.properties.playing = true;
    this._playBtn.name = '⏸ Pause mic';
    this._status = '● listening'; this._statusColor = '#37d0a0'; RT.redraw();
  } catch (e) {
    this._status = 'mic blocked or busy'; this._statusColor = '#ff6666';
    RT.toast('Microphone: ' + (e.message || e.name), 'bad'); RT.redraw();
  }
};
AudioReactiveNode.prototype._stop = function () {
  if (this._stream) { for (const t of this._stream.getTracks()) t.stop(); this._stream = null; }
  if (this._ctx) { this._ctx.close().catch(() => {}); this._ctx = null; }
  this._analyser = null;
  this.properties.playing = false;
  this._playBtn.name = '▶ Start mic';
  this._status = 'mic off'; this._statusColor = '#8a929c'; RT.redraw();
};
AudioReactiveNode.prototype.onRemoved = function () { this._stop(); };
AudioReactiveNode.prototype.onConfigure = function () {
  const p = this.properties;
  if (p.floor === undefined) p.floor = 0.02;
  for (const k of ['band', 'gain', 'smooth', 'min', 'max']) setWidget(this, k, p[k]);
  setWidget(this, 'noise floor', p.floor);
  p.playing = false;    // same reasoning as the camera: never auto-open the mic
};
AudioReactiveNode.prototype.evaluate = function () {
  const p = this.properties;
  if (this._analyser && (RT.playing || RT.capturing)) {
    this._analyser.getByteFrequencyData(this._bins);
    const rate = this._ctx.sampleRate, n = this._bins.length;
    const [lo, hi] = BANDS[p.band] || BANDS.all;
    const i0 = Math.max(0, Math.floor(lo / (rate / 2) * n));
    const i1 = Math.min(n - 1, Math.ceil(hi / (rate / 2) * n));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += this._bins[i];
    const mean = sum / Math.max(1, i1 - i0 + 1) / 255;
    const floor = p.floor === undefined ? 0.02 : p.floor;
    const raw = Math.max(0, Math.min(1, (mean - floor) / Math.max(1e-4, 1 - floor) * (p.gain || 1)));
    const k = Math.max(0, Math.min(0.98, p.smooth || 0));
    this._out01 = this._out01 * k + raw * (1 - k);
    RT.redraw();     // keep the meter live
  }
  this._level = p.min + this._out01 * (p.max - p.min);
  this.setOutputData(0, this._level);
  this.setOutputData(1, this._out01);
};
AudioReactiveNode.prototype.onDrawForeground = function (ctx) {
  if (this.flags.collapsed) return;
  const y = this.size[1] - 18, w = this.size[0] - 20;
  ctx.fillStyle = '#0a0c0f'; ctx.fillRect(10, y, w, 10);
  ctx.fillStyle = this._analyser ? '#37d0a0' : '#3a4048';
  ctx.fillRect(10, y, w * Math.max(0, Math.min(1, this._out01)), 10);
  ctx.fillStyle = '#8a929c'; ctx.font = '10px sans-serif';
  ctx.fillText((this._status || '') + '   ' + this._level.toFixed(3), 10, y - 4);
};

// ── Crop / Scale (set output resolution) ───────────────────────────────────────
const ASPECT_SIZES = { '1:1': [1024, 1024], '16:9': [1920, 1080], '9:16': [1080, 1920], '4:3': [1024, 768], '3:4': [768, 1024] };
const CROP_DEFAULTS = { aspect: 'custom', width: 1024, height: 1024, fit: 'stretch', zoom: 1, offX: 0, offY: 0, rotate: 0, edge: 'black' };
function CropScaleNode() {
  this.addInput('image', IMG); this.addOutput('out', IMG);
  this.properties = Object.assign({}, CROP_DEFAULTS);
  const p = this.properties;
  const mark = () => { this._dirty = true; RT.requestSave(); };
  this.addWidget('combo', 'aspect', p.aspect, (v) => {
    p.aspect = v;
    const preset = ASPECT_SIZES[v];
    if (preset) [p.width, p.height] = preset;
    setWidget(this, 'width', p.width); setWidget(this, 'height', p.height);
    this._realloc(); RT.requestSave();
  }, { values: ['1:1', '16:9', '9:16', '4:3', '3:4', 'custom'] });
  this.addWidget('number', 'width', p.width, (v) => { p.width = Math.max(64, Math.round(v)); p.aspect = 'custom'; setWidget(this, 'aspect', 'custom'); this._realloc(); RT.requestSave(); }, { min: 64, max: 8192, step: 1 });
  this.addWidget('number', 'height', p.height, (v) => { p.height = Math.max(64, Math.round(v)); p.aspect = 'custom'; setWidget(this, 'aspect', 'custom'); this._realloc(); RT.requestSave(); }, { min: 64, max: 8192, step: 1 });
  this.addWidget('combo', 'fit', p.fit, (v) => { p.fit = v; mark(); }, { values: ['stretch', 'crop', 'letterbox'] });
  // Pan / zoom / rotate: which part of the source ends up in the frame. Sliders so
  // they can be exposed in an authored UI (and pinned to a math node) like any
  // other continuous control.
  this.addWidget('slider', 'zoom', p.zoom, (v) => { p.zoom = v; mark(); }, { min: 0.1, max: 8, step: 0.01 });
  this.addWidget('slider', 'offset x', p.offX, (v) => { p.offX = v; mark(); }, { min: -1, max: 1, step: 0.002 });
  this.addWidget('slider', 'offset y', p.offY, (v) => { p.offY = v; mark(); }, { min: -1, max: 1, step: 0.002 });
  this.addWidget('slider', 'rotate', p.rotate, (v) => { p.rotate = v; mark(); }, { min: -180, max: 180, step: 0.5 });
  this.addWidget('combo', 'edges', p.edge, (v) => { p.edge = v; mark(); }, { values: ['black', 'clamp', 'wrap', 'mirror'] });
  this.addWidget('button', 'reset framing', null, () => {
    p.zoom = 1; p.offX = 0; p.offY = 0; p.rotate = 0;
    setWidget(this, 'zoom', 1); setWidget(this, 'offset x', 0);
    setWidget(this, 'offset y', 0); setWidget(this, 'rotate', 0);
    mark(); RT.redraw();
  });
  this._size = { width: p.width, height: p.height }; this._dirty = true;
  attachThumb(this); sizeWithThumb(this);
}
CropScaleNode.title = 'Crop / Scale';
CropScaleNode.prototype._realloc = function () { if (this._out && this._out.tex) RT.engine.gl.deleteTexture(this._out.tex); this._out = null; this._size = { width: +this.properties.width || 1024, height: +this.properties.height || 1024 }; this._dirty = true; };
CropScaleNode.prototype.onConfigure = function () {
  // Older saves have no pan/zoom keys at all; fill them in rather than rendering
  // with undefined uniforms (which would come out as a black frame).
  for (const k in CROP_DEFAULTS) if (this.properties[k] === undefined) this.properties[k] = CROP_DEFAULTS[k];
  const p = this.properties;
  this._size = { width: +p.width || 1024, height: +p.height || 1024 }; this._dirty = true;
  setWidget(this, 'aspect', p.aspect); setWidget(this, 'width', this._size.width); setWidget(this, 'height', this._size.height);
  setWidget(this, 'fit', p.fit); setWidget(this, 'zoom', p.zoom); setWidget(this, 'offset x', p.offX);
  setWidget(this, 'offset y', p.offY); setWidget(this, 'rotate', p.rotate); setWidget(this, 'edges', p.edge);
};
// Drag inside the thumbnail to pan, wheel to zoom — much faster than nudging two
// sliders when you're framing by eye.
CropScaleNode.prototype.onMouseDown = function (e, pos) {
  if (this.flags.collapsed) return;
  const thumbY = this.size[1] - THUMB_H;
  if (pos[1] < thumbY || pos[1] > this.size[1]) return;
  this._drag = { x: pos[0], y: pos[1], offX: this.properties.offX, offY: this.properties.offY };
  return true;
};
CropScaleNode.prototype.onMouseMove = function (e, pos) {
  if (!this._drag) return;
  const p = this.properties;
  p.offX = this._drag.offX + (pos[0] - this._drag.x) / this.size[0];
  p.offY = this._drag.offY - (pos[1] - this._drag.y) / THUMB_H;
  setWidget(this, 'offset x', +p.offX.toFixed(3)); setWidget(this, 'offset y', +p.offY.toFixed(3));
  markDirty(this);
  return true;
};
CropScaleNode.prototype.onMouseUp = function () { if (!this._drag) return; this._drag = null; RT.requestSave(); return true; };
CropScaleNode.prototype.evaluate = function () {
  const h = this.getInputData(0);
  const p = this.properties;
  const v = h && h.tex ? (h.version | 0) : -1;
  const pkey = [p.fit, p.zoom, p.offX, p.offY, p.rotate, p.edge].join('|');
  if (this._dirty || v !== this._inV || pkey !== this._pkey) {
    this._inV = v; this._pkey = pkey;
    ensureOut(this);
    if (h && h.tex) {
      RT.engine.renderToTexture({
        key: '__cropscale', vertSrc: CP_VERT, fragSrc: CP_FRAG, inputs: ['color'], inputTextures: { color: h.tex },
        controls: CP_CONTROLS,
        params: {
          uInW: h.width || this._size.width, uInH: h.height || this._size.height,
          uMode: FIT_MODES[p.fit] || 0, uZoom: +p.zoom || 1,
          uOffX: +p.offX || 0, uOffY: +p.offY || 0, uRotate: +p.rotate || 0,
          uEdgeMode: EDGE_MODES[p.edge] || 0,
        },
      }, this._out.tex, this._size.width, this._size.height);
      this._out.version++;
    }
    this._dirty = false;
  }
  this.setOutputData(0, this._out);
};
CropScaleNode.prototype.onDblClick = function () { if (this._out && this._out.tex) openFull(this); };

// ── Shader (one type per scanned shader) ───────────────────────────────────────
function makeShaderNode(def) {
  // an explicit inputs:[] means a generator (no pins); only undefined defaults to color/depth
  const inputs = Array.isArray(def.inputs) ? def.inputs : ['color', 'depth'];
  const labels = def.inputLabels || {};
  // numeric controls also get an optional float input pin (drive them with math nodes)
  const pinnable = (def.controls || []).filter((c) => c.type === 'range' || c.type === 'number' || c.type === 'bool');
  // A manifest may declare several `outputs` (e.g. Split Channels' R/G/B/A). The
  // node then renders the same program once per slot with uOutput set to its index.
  // Not for stateful shaders: those step their simulation inside the draw, so one
  // draw per slot would run the sim N times a frame.
  const outputs = (!def.feedback && !def.history && Array.isArray(def.outputs) && def.outputs.length)
    ? def.outputs : ['out'];
  function Node() {
    for (const name of inputs) this.addInput(labels[name] || name, IMG);
    // pinnable controls default to slider mode (no input pin); toggle via right-click
    for (const o of outputs) this.addOutput(o, IMG);
    this.properties = { params: {}, pinModes: {}, simSize: def.simSize || 256, animate: false };
    addShaderWidgets(this, def);
    if (def.feedback) {
      this.addWidget('combo', 'sim grid', this.properties.simSize, (v) => { this.properties.simSize = +v; this._seed = (this._seed || 0) + 1; RT.requestSave(); }, { values: def.simSizes || [128, 256, 512] });
      this.addWidget('button', '↺ reset sim', null, () => { RT.engine.resetSim('n' + this.id); this._seed = (this._seed || 0) + 1; });
    } else if (def.history) {
      // history shaders run at full output resolution, so there is no sim grid to
      // choose — just a way to wipe the accumulated frame and start over.
      this.addWidget('button', '↺ clear feedback', null, () => { RT.engine.resetHistory('n' + this.id); this._dirty = true; });
    } else if (def.animated) {
      // time-driven (non-feedback) shaders: an explicit animate toggle drives uTime
      this.addWidget('toggle', 'animate', !!this.properties.animate, (v) => { this.properties.animate = v; this._dirty = true; RT.requestSave(); });
    }
    this._def = def; this._size = { width: RT.RENDER_SIZE, height: RT.RENDER_SIZE }; this._dirty = true;
    attachThumb(this); sizeWithThumb(this);
  }
  Node.title = def.name || def.key;

  Node.prototype.onConfigure = function () {
    this._dirty = true;
    syncShaderWidgets(this);
    const modes = this.properties.pinModes = this.properties.pinModes || {};
    for (const c of pinnable) {
      if (modes[c.uniform] === 'pin') {
        // Remove widget (slider) for this control
        const wIdx = (this.widgets || []).findIndex((w) => w._uniform === c.uniform);
        if (wIdx >= 0) this.widgets.splice(wIdx, 1);
        // Tag the restored input so evaluate() can find it
        const inpIdx = (this.inputs || []).findIndex((s) => s.name === c.label && s.type === 'number');
        if (inpIdx >= 0) this.inputs[inpIdx]._ctrlUniform = c.uniform;
      } else {
        // Slider mode: remove any leftover pin (backward compat with old saves)
        const inpIdx = (this.inputs || []).findIndex((s) => s.name === c.label && s.type === 'number');
        if (inpIdx >= 0) { this.disconnectInput(inpIdx); this.removeInput(inpIdx); }
      }
    }
  };

  Node.prototype.evaluate = function () {
    const inTex = {}; const vers = [];
    inputs.forEach((name, i) => {
      const h = this.getInputData(i);
      if (h && h.tex) { inTex[name] = h.tex; vers.push(h.version | 0); } else vers.push(-1);
    });
    // resolve params: a pin-mode control reads from its input; slider-mode uses the widget value
    const params = Object.assign({}, this.properties.params);
    const modes = this.properties.pinModes || {};
    pinnable.forEach((c) => {
      if (modes[c.uniform] === 'pin') {
        const pinIdx = (this.inputs || []).findIndex((s) => s._ctrlUniform === c.uniform);
        if (pinIdx >= 0) {
          const v = this.getInputData(pinIdx);
          if (typeof v === 'number' && !isNaN(v)) params[c.uniform] = (c.type === 'bool') ? (v > 0.5) : v;
        }
      }
    });
    const feedback = !!def.feedback;
    const history = !!def.history;
    // A stateful shader (feedback sim or history buffer) is running a simulation, so
    // it steps whenever the transport plays regardless of the `animate` toggle.
    // animate only while playing (RT.advance); edits still re-render via _dirty/pkey
    const animate = RT.advance && (feedback || history || (def.animated && this.properties.animate));
    const firstInput = inputs.map((_name, i) => this.getInputData(i)).find((h) => h && h.tex);
    this._size = nodeRenderSize(this, firstInput);
    const vkey = vers.join(',');
    const pkey = JSON.stringify(params) + '|' + this.properties.simSize + '|' + (this._seed || 0) + '|' + (this.properties.animate ? 1 : 0) + '|' + this._size.width + 'x' + this._size.height;
    if (this._dirty || animate || vkey !== this._vkey || pkey !== this._pkey) {
      const outs = ensureOuts(this, outputs.length);
      const simSize = +this.properties.simSize || def.simSize || 256;
      const spec = {
        key: def.key, vertSrc: def.vertSrc, fragSrc: def.fragSrc,
        controls: def.controls || [], params,
        inputs, inputTextures: inTex, inputDefaults: def.inputDefaults,
        feedback, history, simSize, simBuffers: def.simBuffers, simPasses: def.simPasses,
        simKey: 'n' + this.id, histKey: 'n' + this.id,
        advance: (feedback || history) && RT.advance, time: RT.time, frame: RT.frame,
        // A simulation's reset token deliberately does NOT include the input image
        // versions. It used to, which meant swapping or re-rendering an upstream
        // image tore down a Kuramoto field that had been settling for a minute and
        // reseeded it from scratch — the exact opposite of what you want when the
        // images are supposed to be steering a running simulation. Only an explicit
        // reset, a sim-grid change, or a resolution change starts it over now.
        resetToken: 'n' + this.id + '|' + simSize + '|' + (this._seed || 0)
          + (history ? '|' + this._size.width + 'x' + this._size.height : ''),
      };
      // One draw per output slot. A stateful shader has exactly one output (a sim
      // would otherwise step once per slot), so this loop runs once for those.
      for (let i = 0; i < outs.length; i++) {
        spec.output = i;
        RT.engine.renderToTexture(spec, outs[i].tex, this._size.width, this._size.height);
        outs[i].version++;
      }
      this._dirty = false; this._vkey = vkey; this._pkey = pkey;
    }
    if (this._outs) for (let i = 0; i < outputs.length; i++) this.setOutputData(i, this._outs[i]);
  };
  Node.prototype.onDblClick = function () { if (this._out && this._out.tex) openFull(this); };
  if ((def.controls || []).some((c) => c.uniform === 'uPickX')) {
    Node.prototype.onMouseDown = function (_e, pos) {
      if (this.flags.collapsed) return;
      const thumbY = this.size[1] - THUMB_H;
      if (pos[1] >= thumbY && pos[1] <= this.size[1] && pos[0] >= 0 && pos[0] <= this.size[0]) {
        const normX = Math.max(0, Math.min(1, pos[0] / this.size[0]));
        const normY = Math.max(0, Math.min(1, 1.0 - (pos[1] - thumbY) / THUMB_H));
        this.properties.params.uPickX = Math.round(normX * 1000) / 1000;
        this.properties.params.uPickY = Math.round(normY * 1000) / 1000;
        this.properties.params.uUsePickPos = true;
        syncShaderWidgets(this);
        markDirty(this);
        return true;
      }
    };
  }

  // ── right-click menu: render size, plus pin ↔ slider per control ──
  Node.prototype.getExtraMenuOptions = function () {
    const node = this;
    const modes = this.properties.pinModes || {};
    const current = this._size || nodeRenderSize(this);
    const items = [{
      content: 'Render size: ' + current.width + ' × ' + current.height,
      has_submenu: true,
      callback: function (_v, _opts, e, menu) {
        new LG.ContextMenu(['follow input', '512 × 512', '1024 × 1024', '1920 × 1080', '1080 × 1920', '2048 × 1024', '1024 × 2048', 'custom…'], {
          event: e, parentMenu: menu, callback: function (val) {
            if (val === 'follow input') { delete node.properties.renderWidth; delete node.properties.renderHeight; }
            else {
              let m = String(val).match(/(\d+)\s*[×x]\s*(\d+)/i);
              if (String(val).startsWith('custom')) m = String(prompt('Render size (width x height):', current.width + 'x' + current.height) || '').match(/(\d+)\s*[×x]\s*(\d+)/i);
              if (!m || +m[1] < 64 || +m[2] < 64) return;
              node.properties.renderWidth = +m[1]; node.properties.renderHeight = +m[2];
            }
            delete node.properties.renderSize; node._dirty = true; RT.requestSave(); RT.redraw();
          }
        });
      }
    }];
    if (pinnable.length) items.push({
      content: 'Input Modes',
      has_submenu: true,
      callback: function (_v, _opts, e, menu) {
        const sub = pinnable.map((c, j) => {
          const isPin = modes[c.uniform] === 'pin';
          return { content: (isPin ? '● ' : '○ ') + c.label + (isPin ? '  (pin)' : '  (slider)'), callback: function () { node._togglePinMode(j); } };
        });
        new LG.ContextMenu(sub, { event: e, parentMenu: menu, title: 'Input Modes' });
      }
    });
    return items;
  };

  if (pinnable.length) {
    Node.prototype._togglePinMode = function (ctrlIdx) {
      const c = pinnable[ctrlIdx];
      const modes = this.properties.pinModes = this.properties.pinModes || {};
      const isPin = modes[c.uniform] === 'pin';
      if (isPin) {
        // Pin → Slider: remove pin, add widget
        modes[c.uniform] = 'slider';
        const inpIdx = (this.inputs || []).findIndex((s) => s._ctrlUniform === c.uniform);
        if (inpIdx >= 0) { this.disconnectInput(inpIdx); this.removeInput(inpIdx); }
        addSingleShaderWidget(this, c);
      } else {
        // Slider → Pin: remove widget, add pin
        modes[c.uniform] = 'pin';
        const wIdx = (this.widgets || []).findIndex((w) => w._uniform === c.uniform);
        if (wIdx >= 0) this.widgets.splice(wIdx, 1);
        this.addInput(c.label, 'number');
        this.inputs[this.inputs.length - 1]._ctrlUniform = c.uniform;
      }
      // recalculate size
      this.size = this.computeSize();
      if (this.size[0] < 210) this.size[0] = 210;
      this.size[1] += THUMB_H;
      markDirty(this);
    };
  }

  // Category comes from the shader's own manifest, so a new shader files itself.
  const type = (def.category || 'effect') + '/' + def.key;
  LEGACY['forge/shader/' + def.key] = type;
  LG.registerNodeType(type, Node);
}


// ── Declarative GPU pipeline nodes ─────────────────────────────────────────────
// A pipeline node owns a ping-pong RGBA32F state texture and renders that state
// with a declared primitive. The node layer handles UI/lifecycle; the engine stays
// generic and only provides state-pass and draw-pass operations.
const pipelineSourceCache = new Map();
// The manifest uses flat fields because Forge's shader scanner currently preserves
// top-level values, but does not reliably preserve nested pipeline objects.
function pipelineFromDef(def) {
    return {
        stateSize: def.simSize,
        stateSizes: def.simSizes,
        stateBuffers: def.stateBuffers || 1,
        sizeLabel: def.sizeLabel,
        resetLabel: def.resetLabel,
        update: {
            vert: def.updateVert,
            frag: def.updateFrag,
        },
        render: {
            vert: def.renderVert,
            frag: def.renderFrag,
            blend: def.blend,
            blendControl: def.blendControl,
        },
    };
}

function loadPipelineSources(def) {
    if (pipelineSourceCache.has(def.key)) return pipelineSourceCache.get(def.key);

    const stages = pipelineFromDef(def);
    const files = [
        stages.update && stages.update.vert,
        stages.update && stages.update.frag,
        stages.render && stages.render.vert,
        stages.render && stages.render.frag,
    ];

    const promise = Promise.all(files.map(async (file) => {
        if (!file) throw new Error('Incomplete pipeline declaration for ' + def.key);
        const res = await fetch('/shaders/' + file);
        if (!res.ok) throw new Error('Could not load pipeline shader: ' + file);
        return res.text();
    })).then(([updateVertSrc, updateFragSrc, renderVertSrc, renderFragSrc]) => ({
        updateVertSrc,
        updateFragSrc,
        renderVertSrc,
        renderFragSrc,
    }));

    pipelineSourceCache.set(def.key, promise);
    return promise;
}

function makePipelineNode(def) {
    const pipeline = pipelineFromDef(def);
    const controls = def.controls || [];
    const inputs = Array.isArray(def.inputs) ? def.inputs : [];
    const labels = def.inputLabels || {};
    const controlValue = (params, uniform) => {
        if (params[uniform] !== undefined) return params[uniform];
        const control = controls.find((item) => item.uniform === uniform);
        return control ? control.value : 0;
    };
    const colorArray = (value, fallback = [1, 1, 1]) => {
        if (Array.isArray(value) || ArrayBuffer.isView(value)) return value;
        if (typeof value === 'string') {
            const hex = value.trim().replace(/^#/, '');
            if (/^[0-9a-fA-F]{6}$/.test(hex)) {
                return [
                    parseInt(hex.slice(0, 2), 16) / 255,
                    parseInt(hex.slice(2, 4), 16) / 255,
                    parseInt(hex.slice(4, 6), 16) / 255,
                ];
            }
        }
        return fallback;
    };
    const controlUniforms = (params) => {
        const out = {};
        for (const control of controls) {
            const value = controlValue(params, control.uniform);
            out[control.uniform] = control.type === 'color' ? colorArray(value, control.value) : value;
        }
        return out;
    };

    function Node() {
        for (const name of inputs) this.addInput(labels[name] || name, IMG);
        this.addOutput('out', IMG);
        this.properties = {
            params: {},
            simSize: pipeline.stateSize || 64,
        };

        addShaderWidgets(this, def);

        this._pipelineSources = null;
        this._status = 'loading pipeline shaders…';
        this._statusColor = '#ffcc66';

        loadPipelineSources(def)
            .then((sources) => {
                this._pipelineSources = sources;
                this._status = null;
                this._dirty = true;
                RT.redraw();
            })
            .catch((e) => {
                this._status = 'pipeline shader load failed';
                this._statusColor = '#ff6666';
                console.error(e);
                RT.redraw();
            });

        this.addWidget('combo', pipeline.sizeLabel || 'state grid', this.properties.simSize, (v) => {
            this.properties.simSize = +v;
            this._resetPipeline();
            RT.requestSave();
        }, { values: pipeline.stateSizes || [32, 64, 128, 256] });

        this.addWidget('button', pipeline.resetLabel || '↺ reset state', null, () => {
            this._resetPipeline();
            RT.redraw();
        });

        this._def = def;
        this._size = { width: RT.RENDER_SIZE, height: RT.RENDER_SIZE };
        this._dirty = true;

        attachThumb(this);
        sizeWithThumb(this);
    }

    Node.title = def.name || def.key;

    Node.prototype._stateKey = function () {
        return 'n' + this.id;
    };

    Node.prototype._resetPipeline = function () {
        this._seed = (this._seed || 0) + 1;
        RT.engine.resetStateBuffer(this._stateKey());
    };

    Node.prototype.onConfigure = function () {
        if (this.properties.simSize === undefined)
            this.properties.simSize = pipeline.stateSize || 64;

        this.properties.params = this.properties.params || {};
        setWidget(this, pipeline.sizeLabel || 'state grid', this.properties.simSize);
        syncShaderWidgets(this);
        this._dirty = true;
    };

    Node.prototype.evaluate = function () {
        const sources = this._pipelineSources;
        if (!sources) return;

        const params = Object.assign({}, this.properties.params);
        const inTex = {};
        const versions = [];
        inputs.forEach((name, i) => {
            const h = this.getInputData(i);
            if (h && h.tex) {
                inTex[name] = h.tex;
                versions.push(h.version | 0);
            } else {
                versions.push(-1);
            }
        });

        const simSize = Math.max(8, +this.properties.simSize || pipeline.stateSize || 64);
        const stateKey = this._stateKey();
        const firstInput = inputs.map((_name, i) => this.getInputData(i)).find((h) => h && h.tex);

        this._size = nodeRenderSize(this, firstInput);
        ensureOut(this);

        const state = RT.engine.ensureStateBuffer(stateKey, simSize, pipeline.stateBuffers || 1);
        const resetToken = stateKey + '|' + simSize + '|' + (this._seed || 0);

        const runUpdate = (reset) => {
            const uniforms = controlUniforms(params);
            uniforms.uReset = reset ? 1 : 0;
            uniforms.uDeltaTime = reset ? 0 : Math.min(0.05, Math.max(0, RT.dt || 1 / 60));
            uniforms.uSeed = (this._seed || 0) + (reset ? 0 : state.frame * 0.001);

            RT.engine.runStatePass({
                key: def.key + ':update',
                vertSrc: sources.updateVertSrc,
                fragSrc: sources.updateFragSrc,
                srcTextures: state.a,
                dstTextures: state.b,
                size: simSize,
                inputs,
                inputTextures: inTex,
                inputDefaults: def.inputDefaults,
                uniforms,
            });

            const textures = state.a;
            state.a = state.b;
            state.b = textures;
        };

        if (state.token !== resetToken) {
            runUpdate(true);
            state.token = resetToken;
            state.frame = 0;
            this._dirty = true;
        }

        if (RT.advance) {
            runUpdate(false);
            state.frame++;
        }

        const blendControl = pipeline.render.blendControl;
        const blendEnabled = blendControl
            ? controlValue(params, blendControl) !== false
            : true;

        const pkey = JSON.stringify(params)
            + '|' + versions.join(',')
            + '|' + simSize
            + '|' + this._size.width + 'x' + this._size.height
            + '|' + (this._seed || 0);

        if (this._dirty || RT.advance || pkey !== this._pkey) {
            const renderUniforms = controlUniforms(params);
            renderUniforms.uSimRes = [simSize, simSize];
            renderUniforms.uResolution = [this._size.width, this._size.height];

            RT.engine.renderPointsToTexture({
                key: def.key + ':render',
                vertSrc: sources.renderVertSrc,
                fragSrc: sources.renderFragSrc,
                stateTextures: state.a,
                targetTex: this._out.tex,
                width: this._size.width,
                height: this._size.height,
                count: simSize * simSize,
                blend: blendEnabled ? (pipeline.render.blend || 'additive') : 'alpha',
                uniforms: renderUniforms,
            });

            this._out.version++;
            this._dirty = false;
            this._pkey = pkey;
        }

        this.setOutputData(0, this._out);
    };

    Node.prototype.onRemoved = function () {
        RT.engine.deleteStateBuffer(this._stateKey());
    };

    Node.prototype.onDblClick = function () {
        if (this._out && this._out.tex) openFull(this);
    };

    Node.prototype.getExtraMenuOptions = function () {
        const node = this;
        const current = this._size || nodeRenderSize(this);

        return [{
            content: 'Render size: ' + current.width + ' × ' + current.height,
            has_submenu: true,
            callback: function (_v, _opts, e, menu) {
                new LG.ContextMenu([
                    'default',
                    '512 × 512',
                    '1024 × 1024',
                    '1920 × 1080',
                    '1080 × 1920',
                    '2048 × 1024',
                    '1024 × 2048',
                    'custom…',
                ], {
                    event: e,
                    parentMenu: menu,
                    callback: function (val) {
                        if (val === 'default') {
                            delete node.properties.renderWidth;
                            delete node.properties.renderHeight;
                        } else {
                            let m = String(val).match(/(\d+)\s*[×x]\s*(\d+)/i);
                            if (String(val).startsWith('custom'))
                                m = String(prompt('Render size (width x height):', current.width + 'x' + current.height) || '').match(/(\d+)\s*[×x]\s*(\d+)/i);

                            if (!m || +m[1] < 64 || +m[2] < 64) return;
                            node.properties.renderWidth = +m[1];
                            node.properties.renderHeight = +m[2];
                        }

                        delete node.properties.renderSize;
                        node._dirty = true;
                        RT.requestSave();
                        RT.redraw();
                    },
                });
            },
        }];
    };

    const type = (def.category || 'generate') + '/' + def.key;
    LEGACY['forge/shader/' + def.key] = type;
    LG.registerNodeType(type, Node);
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
    const s = imageSize(h); const blob = await RT.engine.captureTexture(h.tex, s.width, s.height);
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
          const s = imageSize(h); const blob = await RT.engine.captureTexture(h.tex, s.width, s.height);
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
  Node.prototype.onDblClick = function () { if (this._out && this._out.tex) openFull(this); };
  LEGACY['forge/ai/' + wf.key] = 'ai/' + wf.key;
  LG.registerNodeType('ai/' + wf.key, Node);
}

// ── Viewer ────────────────────────────────────────────────────────────────────
// Drag the bottom-right corner to resize (litegraph's own resize handle — the node
// just has to not fight it, which is what onResize is for). Fullscreen shows a LIVE
// canvas, not a snapshot, so an animating graph keeps animating; see liveview.js.
function ViewerNode() {
  this.addInput('image', IMG);
  this.properties = {};
  this.size = [300, 300];
  this.resizable = true;
  this.addWidget('button', '⤢ fullscreen', null, () => openFull(this));
  this.onDrawForeground = function (ctx) {
    if (this.flags.collapsed) return;
    drawImage(this, ctx, this._tex, { x: 0, y: 30, w: this.size[0], h: this.size[1] - 30 });
  };
}
ViewerNode.title = 'Viewer';
// Keep it big enough to still show a picture and hit the resize corner.
ViewerNode.prototype.onResize = function (size) {
  const s = size || this.size;
  if (s[0] < 140) s[0] = 140;
  if (s[1] < 120) s[1] = 120;
};
ViewerNode.prototype.evaluate = function () { const h = this.getInputData(0); this._out = h || null; this._tex = h && h.tex ? h.tex : null; };
ViewerNode.prototype.onDblClick = function () { openFull(this); };
// Handy sizes, since dragging to an exact aspect by hand is fiddly.
ViewerNode.prototype.getExtraMenuOptions = function () {
  const node = this;
  return [{
    content: 'Viewer size',
    has_submenu: true,
    callback: function (_v, _opts, e, menu) {
      const opts = { 'Small (240)': 240, 'Medium (360)': 360, 'Large (520)': 520, 'Huge (760)': 760 };
      new LG.ContextMenu(Object.keys(opts).concat(['Match image aspect']), {
        event: e, parentMenu: menu, callback: function (val) {
          if (val === 'Match image aspect') {
            const s = imageSize(node._out);
            node.size[1] = Math.round(node.size[0] * (s.height / s.width)) + 30;
          } else {
            const w = opts[val];
            const s = imageSize(node._out);
            node.size[0] = w; node.size[1] = Math.round(w * (s.height / s.width)) + 30;
          }
          node.onResize(node.size);
          RT.requestSave(); RT.redraw();
        },
      });
    },
  }, {
    content: '⤢ Fullscreen (live)',
    callback: function () { openFull(node); },
  }, {
    content: '⬇ Download PNG',
    callback: function () {
      if (!node._tex) return RT.toast('Connect an image', 'bad');
      const s = imageSize(node._out);
      downloadTexture(node._tex, s.width, s.height, 'forge_' + (RT.project || 'view') + '.png')
        .then(() => RT.toast('Downloaded', 'good'))
        .catch((err) => RT.toast('Download failed: ' + err.message, 'bad'));
    },
  }].concat(getOutputNodeMenuOptions.call(node));
};

// ── Viewer Window (live output in a separate, fullscreen-able window) ───────────
// Opens a same-origin popup with its own 2D canvas. Each frame we blit this node's
// texture into the shared gl canvas and drawImage() it into the popup — so the
// window shows a live feed you can drag to a second display and take fullscreen.
const VIEWER_WIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Forge Viewer</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none;}
  body.ui{cursor:default;}
  #v{display:block;width:100vw;height:100vh;}
  #bar{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:10px;
    align-items:center;padding:6px 10px;background:#000b;border:1px solid #333;border-radius:8px;
    font:12px -apple-system,Segoe UI,sans-serif;color:#cfd3d8;opacity:0;transition:opacity .2s;pointer-events:none;}
  body.ui #bar{opacity:1;pointer-events:auto;}
  #bar button{background:#1c2028;color:#eee;border:1px solid #333;border-radius:6px;padding:5px 11px;cursor:pointer;}
  #bar .hint{color:#8a929c;}
</style></head><body>
<canvas id="v"></canvas>
<div id="bar"><button id="fs">⤢ Fullscreen</button><span class="hint">double-click or press F · drag to another display first</span></div>
<script>
  var body=document.body;
  function fs(){ if(document.fullscreenElement){document.exitFullscreen();} else {document.documentElement.requestFullscreen().catch(function(){});} }
  document.getElementById('fs').onclick=fs;
  document.addEventListener('dblclick',fs);
  document.addEventListener('keydown',function(e){ if(e.key==='f'||e.key==='F'){fs();} });
  var t; function ui(){ body.classList.add('ui'); clearTimeout(t); t=setTimeout(function(){body.classList.remove('ui');},2000); }
  document.addEventListener('mousemove',ui); ui();
</script>
</body></html>`;

function ViewerWindowNode() {
  this.addInput('image', IMG);
  this.properties = {};
  this.addWidget('button', '⧉ Open window', null, () => this._open());
  attachThumb(this); this.size = [220, 70 + THUMB_H];
}
ViewerWindowNode.title = 'Viewer Window';
ViewerWindowNode.prototype._open = function () {
  if (this._win && !this._win.closed) { this._win.focus(); return; }
  const w = window.open('', 'forge-viewer-' + this.id, 'width=960,height=960');
  if (!w) { RT.toast('Popup blocked — allow popups for Forge', 'bad'); return; }
  w.document.open(); w.document.write(VIEWER_WIN_HTML); w.document.close();
  this._win = w;
  this._canvas = w.document.getElementById('v');
  this._ctx = this._canvas && this._canvas.getContext('2d');
  this._status = '● window open'; this._statusColor = '#37d0a0'; RT.redraw();
  w.addEventListener('beforeunload', () => { if (this._win === w) { this._win = null; this._canvas = null; this._ctx = null; this._status = 'window closed'; this._statusColor = '#8a929c'; RT.redraw(); } });
};
ViewerWindowNode.prototype._push = function () {
  const w = this._win; if (!w || w.closed || !this._ctx) return;
  const cvs = this._canvas, ctx = this._ctx;
  const dw = w.innerWidth | 0, dh = w.innerHeight | 0;
  if (!dw || !dh) return;
  // Nothing new to show and the window hasn't been resized? Then don't spend a
  // full-resolution blit on redrawing the identical frame — that cost is what made
  // a paused high-res graph feel like it was still working.
  const stamp = ((this._out && this._out.version) | 0) + '|' + dw + 'x' + dh + '|' + (this._tex ? 1 : 0);
  if (stamp === this._pushStamp) return;
  this._pushStamp = stamp;
  if (cvs.width !== dw || cvs.height !== dh) { cvs.width = dw; cvs.height = dh; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, dw, dh);
  if (!this._tex) return;
  const t = imageSize(this._texSize);
  const s = Math.min(dw / t.width, dh / t.height);   // letterbox, preserving the texture's aspect
  const iw = t.width * s, ih = t.height * s;
  try {
    const r = RT.engine.blitToCanvas(this._tex, t.width, t.height, Math.max(dw, dh));
    ctx.drawImage(RT.engine.canvas, 0, 0, r.width, r.height, (dw - iw) / 2, (dh - ih) / 2, iw, ih);
  } catch (e) {}
};
ViewerWindowNode.prototype.evaluate = function () {
  const h = this.getInputData(0);
  this._out = h || null;
  this._tex = h && h.tex ? h.tex : null;
  this._texSize = h && h.tex ? imageSize(h) : this._texSize;
  if (this._win) this._push();
};
ViewerWindowNode.prototype.onRemoved = function () { if (this._win && !this._win.closed) this._win.close(); this._win = null; };
ViewerWindowNode.prototype.onDblClick = function () { this._open(); };

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
    const s = imageSize(h); const blob = await RT.engine.captureTexture(h.tex, s.width, s.height);
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
  const fps = this.properties.fps || 24;
  const savedTime = RT.time;
  RT.capturing = true;          // the rAF loop yields; we own time + eval here
  RT.advance = true;            // force feedback + animated shaders to step
  try {
    RT.engine.resetSim();                       // reseed all feedback sims
    RT.engine.resetStateBuffer();
    await RT.api.seqClear(RT.project, name);
    for (let i = 0; i < n; i++) {
      RT.time = i / fps;                        // advance time so animated shaders move
      RT.dt = 1 / fps;
      RT.evalOnce();                            // re-render every node at this time (one feedback step)
      const h = this.getInputData(0);
      const s = imageSize(h); const blob = await RT.engine.captureTexture(h.tex, s.width, s.height);
      await RT.api.seqFrame(RT.project, name, i, blob);
      this._status = `frame ${i + 1}/${n}`; RT.redraw();
    }
    await RT.api.videoCommand(RT.project, name, this.properties.fps);
    this._status = `rendered ${n} frames`;
    RT.toast(`Rendered ${n} frames`, 'good');
  } catch (e) { RT.toast('Sequence failed: ' + e.message, 'bad'); }
  finally { RT.capturing = false; RT.time = savedTime; }
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
  const mathInputs = def.inputs || [];
  function Node() {
    // inputs default to slider mode (no pin); toggle via right-click
    for (const o of def.outputs || []) this.addOutput(typeof o === 'string' ? o : o.name, 'number');
    this.properties = { vals: {}, pinModes: {} };
    for (const inp of mathInputs) {
      if (this.properties.vals[inp.name] === undefined) this.properties.vals[inp.name] = inp.value ?? 0;
      this.addWidget('number', inp.name, this.properties.vals[inp.name],
        (v) => { this.properties.vals[inp.name] = v; RT.requestSave(); }, { step: inp.step ?? 0.1 });
    }
    // honour defaultPin: start marked inputs in pin mode
    for (const inp of mathInputs) {
      if (inp.defaultPin) {
        this.properties.pinModes[inp.name] = 'pin';
        const wIdx = (this.widgets || []).findIndex((w) => w.name === inp.name);
        if (wIdx >= 0) this.widgets.splice(wIdx, 1);
        this.addInput(inp.name, 'number');
        this.inputs[this.inputs.length - 1]._ctrlName = inp.name;
      }
    }
    this.size = this.computeSize(); if (this.size[0] < 130) this.size[0] = 130;
  }
  Node.title = def.name || item.key;

  Node.prototype.onConfigure = function () {
    for (const inp of mathInputs) setWidget(this, inp.name, this.properties.vals[inp.name]);
    const modes = this.properties.pinModes = this.properties.pinModes || {};
    for (const inp of mathInputs) {
      if (modes[inp.name] === 'pin') {
        const wIdx = (this.widgets || []).findIndex((w) => w.name === inp.name);
        if (wIdx >= 0) this.widgets.splice(wIdx, 1);
        const inpIdx = (this.inputs || []).findIndex((s) => s.name === inp.name && s.type === 'number');
        if (inpIdx >= 0) this.inputs[inpIdx]._ctrlName = inp.name;
      } else {
        // Slider mode: remove any leftover pin (backward compat)
        const inpIdx = (this.inputs || []).findIndex((s) => s.name === inp.name && s.type === 'number');
        if (inpIdx >= 0) { this.disconnectInput(inpIdx); this.removeInput(inpIdx); }
      }
    }
  };

  Node.prototype.evaluate = function () {
    const i = {};
    const modes = this.properties.pinModes || {};
    mathInputs.forEach((inp) => {
      let v;
      if (modes[inp.name] === 'pin') {
        const pinIdx = (this.inputs || []).findIndex((s) => s._ctrlName === inp.name);
        if (pinIdx >= 0) v = this.getInputData(pinIdx);
      }
      i[inp.name] = (typeof v === 'number' && !isNaN(v)) ? v : this.properties.vals[inp.name];
    });
    let out = {};
    try { out = def.compute(i, { time: RT.time, dt: RT.dt || 0, frame: RT.frame }) || {}; } catch (e) {}
    (def.outputs || []).forEach((o, idx) => this.setOutputData(idx, out[typeof o === 'string' ? o : o.name]));
  };

  // ── right-click toggle: pin ↔ slider for each math input ──
  if (mathInputs.length) {
    Node.prototype.getExtraMenuOptions = function () {
      const node = this;
      const modes = this.properties.pinModes || {};
      return [{
        content: 'Input Modes',
        has_submenu: true,
        callback: function (_v, _opts, e, menu) {
          const items = mathInputs.map((inp, j) => {
            const isPin = modes[inp.name] === 'pin';
            return {
              content: (isPin ? '● ' : '○ ') + inp.name + (isPin ? '  (pin)' : '  (slider)'),
              callback: function () { node._togglePinMode(j); }
            };
          });
          new LG.ContextMenu(items, { event: e, parentMenu: menu, title: 'Input Modes' });
        }
      }];
    };

    Node.prototype._togglePinMode = function (inputIdx) {
      const inp = mathInputs[inputIdx];
      const modes = this.properties.pinModes = this.properties.pinModes || {};
      const isPin = modes[inp.name] === 'pin';
      if (isPin) {
        // Pin → Slider: remove pin, add widget
        modes[inp.name] = 'slider';
        const idx = (this.inputs || []).findIndex((s) => s._ctrlName === inp.name);
        if (idx >= 0) { this.disconnectInput(idx); this.removeInput(idx); }
        this.addWidget('number', inp.name, this.properties.vals[inp.name] ?? inp.value ?? 0,
          (v) => { this.properties.vals[inp.name] = v; RT.requestSave(); }, { step: inp.step ?? 0.1 });
      } else {
        // Slider → Pin: remove widget, add pin
        modes[inp.name] = 'pin';
        const wIdx = (this.widgets || []).findIndex((w) => w.name === inp.name);
        if (wIdx >= 0) this.widgets.splice(wIdx, 1);
        this.addInput(inp.name, 'number');
        this.inputs[this.inputs.length - 1]._ctrlName = inp.name;
      }
      // recalculate size
      this.size = this.computeSize();
      if (this.size[0] < 130) this.size[0] = 130;
      markDirty(this);
    };
  }

  LG.registerNodeType('math/' + item.key, Node);
}

// ── Pass Through (a node that does nothing, passing the IMAGE texture directly) ──
function PassThroughNode() {
  this.addInput('image', IMG);
  this.addOutput('out', IMG);
  this.size = [140, 40];
}
PassThroughNode.title = 'Pass Through';
PassThroughNode.prototype.evaluate = function () {
  this.setOutputData(0, this.getInputData(0));
};

function insertPassThrough(node) {
  const graph = node.graph;
  if (!graph) return;

  const ptNode = LG.createNode(T.PASS_THROUGH);
  if (!ptNode) return;

  // Position it slightly to the left of the target node
  ptNode.pos = [node.pos[0] - 180, node.pos[1]];
  graph.add(ptNode);

  // If the target node has an input connected, splice the pass-through in
  const linkId = node.inputs[0].link;
  if (linkId !== null && linkId !== undefined) {
    const link = graph.links[linkId];
    if (link) {
      const originNodeId = link.origin_id;
      const originSlot = link.origin_slot;

      // Disconnect target node's input
      node.disconnectInput(0);

      // Connect origin node to pass-through's input
      const originNode = graph.getNodeById(originNodeId);
      if (originNode) {
        originNode.connect(originSlot, ptNode, 0);
      }
    }
  }

  // Connect pass-through's output to target node's input
  ptNode.connect(0, node, 0);

  // Request save and redraw
  RT.requestSave();
  RT.redraw();
}

function getOutputNodeMenuOptions() {
  const node = this;
  return [{
    content: 'Insert Pass Through',
    callback: function () {
      insertPassThrough(node);
    }
  }];
}

// (ViewerNode builds its own menu, which ends with these same options.)
ViewerWindowNode.prototype.getExtraMenuOptions = getOutputNodeMenuOptions;
SaveNode.prototype.getExtraMenuOptions = getOutputNodeMenuOptions;
SequenceNode.prototype.getExtraMenuOptions = getOutputNodeMenuOptions;

// ── registration ────────────────────────────────────────────────────────────────
// ── Control nodes ────────────────────────────────────────────────────────────
// Input widgets that output a number to drive shader/math pins. Unlike litegraph's
// bundled widget/* nodes (which draw custom UI with no `widgets` array), these use
// addWidget, so the Author-UI layer (endui.js) can expose them as real sliders /
// checkboxes / fields on the published page. That is the whole point: they are the
// controls a published front-end is built from.

// Slider — a continuous value with an adjustable range. The value widget is named
// 'value' and never renamed, so an Author-UI binding to it survives save/reload;
// the display label is set in Author UI, not here. min/max are plain widgets the
// author simply doesn't expose.
function SliderNode() {
  this.addOutput('value', 'number');
  this.properties = { value: 0.5, min: 0, max: 1 };
  const p = this.properties;
  this._slider = this.addWidget('slider', 'value', p.value,
    (v) => { p.value = v; RT.requestSave(); }, { min: p.min, max: p.max });
  this.addWidget('number', 'min', p.min, (v) => { p.min = v; this._sync(); RT.requestSave(); }, { step: 0.1 });
  this.addWidget('number', 'max', p.max, (v) => { p.max = v; this._sync(); RT.requestSave(); }, { step: 0.1 });
  this.size = [220, 96];
}
SliderNode.title = 'Slider';
SliderNode.prototype._sync = function () {
  const p = this.properties;
  if (!this._slider) return;
  this._slider.options.min = p.min; this._slider.options.max = p.max;
  p.value = Math.min(p.max, Math.max(p.min, p.value)); this._slider.value = p.value;
  RT.redraw();
};
SliderNode.prototype.evaluate = function () { this.setOutputData(0, this.properties.value); };
SliderNode.prototype.onConfigure = function () {
  const p = this.properties;
  if (this._slider) { this._slider.value = p.value; this._slider.options.min = p.min; this._slider.options.max = p.max; }
  setWidget(this, 'min', p.min); setWidget(this, 'max', p.max);
};

// Number — precise scalar entry (drag or type), no range.
function NumberNode() {
  this.addOutput('value', 'number');
  this.properties = { value: 0 };
  this.addWidget('number', 'value', this.properties.value,
    (v) => { this.properties.value = v; RT.requestSave(); }, { step: 0.1 });
  this.size = [180, 60];
}
NumberNode.title = 'Number';
NumberNode.prototype.evaluate = function () { this.setOutputData(0, this.properties.value); };
NumberNode.prototype.onConfigure = function () { setWidget(this, 'value', this.properties.value); };

// Toggle — outputs 1 or 0, so it can gate a shader float/bool pin.
function ToggleNode() {
  this.addOutput('value', 'number');
  this.properties = { value: false };
  this.addWidget('toggle', 'value', this.properties.value,
    (v) => { this.properties.value = v; RT.requestSave(); });
  this.size = [180, 60];
}
ToggleNode.title = 'Toggle';
ToggleNode.prototype.evaluate = function () { this.setOutputData(0, this.properties.value ? 1 : 0); };
ToggleNode.prototype.onConfigure = function () { setWidget(this, 'value', this.properties.value); };

export function registerNodes() {
  installTypeAliases();
  LG.registerNodeType(T.SOURCE, SourceNode);
  LG.registerNodeType(T.IMPORT, ImportNode);
  LG.registerNodeType(T.URL_IMAGE, UrlImageNode);
  LG.registerNodeType(T.WEBCAM, WebcamNode);
  LG.registerNodeType(T.AUDIO, AudioReactiveNode);
  LG.registerNodeType(T.CROP, CropScaleNode);
  LG.registerNodeType(T.SLIDER, SliderNode);
  LG.registerNodeType(T.NUMBER, NumberNode);
  LG.registerNodeType(T.TOGGLE, ToggleNode);
  LG.registerNodeType(T.DEPTH, DepthNode);
  LG.registerNodeType(T.VIEWER, ViewerNode);
  LG.registerNodeType(T.VIEWER_WINDOW, ViewerWindowNode);
  LG.registerNodeType(T.SAVE, SaveNode);
  LG.registerNodeType(T.SEQUENCE, SequenceNode);
  LG.registerNodeType(T.PASS_THROUGH, PassThroughNode);
  for (const def of RT.shaderDefs) {
      const isParticleSystem =
          def.particleSystem === true ||
          def.key === 'gpuParticles' ||
            (
                !!def.updateVert &&
                !!def.updateFrag &&
                !!def.renderVert &&
                !!def.renderFrag
            );

        if (isParticleSystem) {
            makePipelineNode(def);
        } else {
            makeShaderNode(def);
        }
  }
  for (const wf of RT.workflows) makeAiNode(wf);
  for (const m of RT.mathDefs) makeMathNode(m);
  registerBuiltins();
}