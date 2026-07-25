// engine.js — WebGL2 renderer for the Forge Graph (node) version.
//
// This is a COPY of ../../js/shaderEngine.js so the tab/chain version's file
// stays untouched. It adds what the node graph needs (additive, non-breaking):
//   - _bindImages honours spec.inputTextures (a raw GL texture per named input),
//     so every node input can be fed by an upstream node's output texture.
//   - renderToTexture(spec, targetTex, width, height) renders one node into its own texture.
//   - allocTexture / blitToCanvas / captureTexture for per-node textures, in-node
//     previews (ctx.drawImage of the gl canvas), and PNG capture (save/sequence).
// Feedback (ping-pong) state is kept per simKey = node id, so many feedback nodes
// can run at once.

const COPY_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv = p; gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;
const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uColor;
void main(){ o = texture(uColor, vUv); }`;

export class ShaderEngine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 not available in this browser');
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.programs = new Map();
    this.texCache = new WeakMap();
    this.solid = { gray: this._solid([128, 128, 128, 255]), black: this._solid([0, 0, 0, 255]) };
    this.fbo = gl.createFramebuffer();
    this.fboTex = null; this.fboSize = '';
    this.floatRenderable = !!gl.getExtension('EXT_color_buffer_float');
    this.simFbo = gl.createFramebuffer();
    this.nodeFbo = gl.createFramebuffer();   // for renderToTexture
    this.sims = new Map();
  }

  ensureProgram(key, vertSrc, fragSrc) {
    if (this.programs.has(key)) return this.programs.get(key);
    const gl = this.gl;
    const vs = this._shader(gl.VERTEX_SHADER, vertSrc);
    const fs = this._shader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('Link error: ' + gl.getProgramInfoLog(prog));
    gl.deleteShader(vs); gl.deleteShader(fs);
    const info = { prog, locs: new Map() };
    this.programs.set(key, info);
    return info;
  }

  invalidate(key) { this.programs.delete(key); }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error((type === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment') + ' shader error: ' + log);
    }
    return s;
  }

  _loc(info, name) {
    if (!info.locs.has(name)) info.locs.set(name, this.gl.getUniformLocation(info.prog, name));
    return info.locs.get(name);
  }

  // ── textures ─────────────────────────────────────────────────────────────
  _solid(rgba) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return t;
  }

  texFor(img, fallback = 'gray') {
    if (!img) return this.solid[fallback];
    if (this.texCache.has(img)) return this.texCache.get(img);
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texCache.set(img, t);
    return t;
  }

  // allocate a node's own RGBA8 output texture
  // A node's own output texture. RGBA16F (half-float) so gradients keep their
  // precision through a chain of shaders instead of re-quantising to 8 bit at every
  // pass (and it can hold values <0 / >1, e.g. Sine Wave). Falls back to RGBA8 if
  // float render targets aren't supported. RGBA16F is linearly filterable in WebGL2.
  allocTexture(width, height = width) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (this.floatRenderable)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // ── input binding (N named inputs; raw texture > flow texture > image) ──────
  _uniformForInput(name) {
    if (name === 'color') return 'uColor';
    if (name === 'depth') return 'uDepth';
    return 'u' + name.charAt(0).toUpperCase() + name.slice(1);
  }

  _inputImage(spec, name) {
    if (spec.inputImages && name in spec.inputImages) return spec.inputImages[name];
    if (name === 'color') return spec.colorImg;
    if (name === 'depth') return spec.depthImg;
    return null;
  }

  _bindImages(info, spec) {
    const gl = this.gl;
    // an explicit [] means no inputs (a generator); only undefined defaults to color/depth
    const names = Array.isArray(spec.inputs) ? spec.inputs : ['color', 'depth'];
    names.forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      let tex;
      if (spec.inputTextures && spec.inputTextures[name]) tex = spec.inputTextures[name];   // graph: upstream node texture
      else if (spec.flowInput === name && spec.flowTex) tex = spec.flowTex;
      else tex = this.texFor(this._inputImage(spec, name), name === 'color' ? 'black' : 'gray');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const loc = this._loc(info, this._uniformForInput(name));
      if (loc !== null) gl.uniform1i(loc, unit);
    });
    return names.length;
  }

  _setControls(info, spec) {
    const gl = this.gl;
    for (const c of spec.controls || []) {
      const v = (spec.params && spec.params[c.uniform] !== undefined) ? spec.params[c.uniform] : c.value;
      const loc = this._loc(info, c.uniform);
      if (loc === null) continue;
      if (c.type === 'color') {
        const a = Array.isArray(v) ? v : [1, 1, 1];
        gl.uniform3f(loc, a[0], a[1], a[2]);
      } else if (c.type === 'bool') {
        gl.uniform1f(loc, v ? 1 : 0);
      } else {
        gl.uniform1f(loc, Number(v) || 0);
      }
    }
  }

  // ── single-pass draw (draws to whatever framebuffer is currently bound) ─────
  _draw(spec, w, h) {
    if (spec.feedback) return this._drawFeedback(spec, w, h);
    const gl = this.gl;
    const info = this.ensureProgram(spec.key, spec.vertSrc, spec.fragSrc);
    gl.useProgram(info.prog);
    gl.bindVertexArray(this.vao);
    this._bindImages(info, spec);
    gl.uniform2f(this._loc(info, 'uResolution'), w, h);
    gl.uniform1f(this._loc(info, 'uTime'), spec.time || 0);
    this._setControls(info, spec);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // ── feedback / ping-pong simulations, one state per simKey ──────────────────
  resetSim(key) {
    if (key === undefined) { for (const s of this.sims.values()) s.token = null; }
    else { const s = this.sims.get(key); if (s) s.token = null; }
  }

  _ensureSim(key, size) {
    const gl = this.gl;
    let sim = this.sims.get(key);
    if (sim && sim.size === size) return sim;
    if (sim) { gl.deleteTexture(sim.texA); gl.deleteTexture(sim.texB); }
    const mk = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    sim = { size, texA: mk(), texB: mk(), token: null, frame: 0 };
    this.sims.set(key, sim);
    return sim;
  }

  _drawFeedback(spec, w, h) {
    const gl = this.gl;
    if (!this.floatRenderable)
      throw new Error('Feedback shaders need WebGL2 float render targets (EXT_color_buffer_float), unavailable here.');
    const size = Math.max(8, spec.simSize || 256);
    const sim = this._ensureSim(spec.simKey || spec.key, size);
    const target = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const info = this.ensureProgram(spec.key, spec.vertSrc, spec.fragSrc);
    gl.useProgram(info.prog);
    gl.bindVertexArray(this.vao);
    const stateUnit = this._bindImages(info, spec);
    this._setControls(info, spec);
    gl.uniform2f(this._loc(info, 'uSimRes'), size, size);
    gl.uniform1f(this._loc(info, 'uTime'), spec.time || 0);

    if (sim.token !== spec.resetToken) {
      this._simPass(info, sim.texA, sim.texB, 2.0, size, stateUnit);
      sim.token = spec.resetToken; sim.frame = 0;
    }
    if (spec.advance) {
      this._simPass(info, sim.texB, sim.texA, 0.0, size, stateUnit);
      const t = sim.texA; sim.texA = sim.texB; sim.texB = t; sim.frame++;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0 + stateUnit);
    gl.bindTexture(gl.TEXTURE_2D, sim.texA);
    gl.uniform1i(this._loc(info, 'uState'), stateUnit);
    gl.uniform2f(this._loc(info, 'uResolution'), w, h);
    gl.uniform1f(this._loc(info, 'uPass'), 1.0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _simPass(info, dstTex, srcTex, pass, size, stateUnit) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);
    gl.viewport(0, 0, size, size);
    gl.activeTexture(gl.TEXTURE0 + stateUnit);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this._loc(info, 'uState'), stateUnit);
    gl.uniform2f(this._loc(info, 'uResolution'), size, size);
    gl.uniform1f(this._loc(info, 'uPass'), pass);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ── node-graph render entry points ──────────────────────────────────────────
  // render one node's shader into targetTex (its own output texture)
  renderToTexture(spec, targetTex, width, height = width) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.nodeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTex, 0);
    this._draw(spec, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // draw a texture into the visible gl canvas (so a node can ctx.drawImage it)
  blitToCanvas(tex, width, height = width) {
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    this._blit(tex, null, width, height);
  }

  // draw a texture into a target framebuffer (null = canvas)
  _blit(tex, targetFbo, width, height = width) {
    const gl = this.gl;
    const info = this.ensureProgram('__copy', COPY_VERT, COPY_FRAG);
    gl.useProgram(info.prog); gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this._loc(info, 'uColor'), 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // read a node texture back to a PNG blob (Save / Sequence nodes)
  async captureTexture(tex, width, height = width) {
    this._ensureCaptureFbo(width, height);
    this._blit(tex, this.fbo, width, height);
    return this._readBlob(width, height);
  }

  _ensureCaptureFbo(width, height = width) {
    const gl = this.gl, key = width + 'x' + height;
    if (this.fboSize === key) return;
    if (this.fboTex) gl.deleteTexture(this.fboTex);
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    this.fboSize = key;
  }

  _readBlob(width, height = width) {
    const gl = this.gl;
    const px = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) img.data.set(px.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }
}

const _imgCache = new Map();
export function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (_imgCache.has(url)) return _imgCache.get(url);
  const p = new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('image load failed: ' + url));
    im.src = url;
  });
  _imgCache.set(url, p);
  return p;
}