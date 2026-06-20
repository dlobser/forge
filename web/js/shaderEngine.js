// shaderEngine.js — WebGL2 fullscreen-quad renderer for Forge effects.
//
// Effects are drawn attributeless (gl_VertexID triangle) so there are no vertex
// buffers. The engine compiles+caches programs by key, caches GL textures per
// HTMLImageElement, binds each effect's declared inputs (uColor=unit0,
// uDepth=unit1, extra named inputs on units 2+) plus uResolution/uTime and the
// effect's control uniforms. Feedback effects (Kuramoto …) keep ping-pong state
// per simKey so several can run at once. A whole chain of shader steps can be
// rendered GPU→GPU through an intermediate texture pool — each step's output is
// the next step's "flow" input — and shown live or read back as a PNG.

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
    this.vao = gl.createVertexArray();         // empty VAO required for attributeless draw
    this.programs = new Map();                  // key -> {prog, locs:Map}
    this.texCache = new WeakMap();              // HTMLImageElement -> GLTexture
    this.solid = { gray: this._solid([128, 128, 128, 255]), black: this._solid([0, 0, 0, 255]) };
    this.fbo = gl.createFramebuffer();
    this.fboTex = null; this.fboSize = 0;
    // feedback (ping-pong) support — Kuramoto and friends need float render
    // targets to store continuous phase; texelFetch reads exact neighbours.
    this.floatRenderable = !!gl.getExtension('EXT_color_buffer_float');
    this.simFbo = gl.createFramebuffer();
    this.sims = new Map();   // simKey -> { size, texA, texB, token, frame }
    this.pool = null;        // intermediate chain textures { size, texA, texB, fbo }
  }

  // ── program build/cache ──────────────────────────────────────────────────
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

  // ── input binding (N named inputs; image OR raw texture; chain flow) ────────
  // color -> uColor, depth -> uDepth, anything else -> u<Capitalized>.
  _uniformForInput(name) {
    if (name === 'color') return 'uColor';
    if (name === 'depth') return 'uDepth';
    return 'u' + name.charAt(0).toUpperCase() + name.slice(1);
  }

  _inputImage(spec, name) {
    if (spec.inputImages && name in spec.inputImages) return spec.inputImages[name];
    if (name === 'color') return spec.colorImg;     // single-effect back-compat
    if (name === 'depth') return spec.depthImg;
    return null;
  }

  // Bind every declared input on its own texture unit. The input named
  // spec.flowInput is fed spec.flowTex (a chain's previous output) instead of an
  // image. Returns the unit count, so feedback can place uState just after them.
  _bindImages(info, spec) {
    const gl = this.gl;
    const names = (spec.inputs && spec.inputs.length) ? spec.inputs : ['color', 'depth'];
    names.forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      let tex;
      if (spec.flowInput === name && spec.flowTex) tex = spec.flowTex;
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
    const target = gl.getParameter(gl.FRAMEBUFFER_BINDING);   // restore after sim passes
    const info = this.ensureProgram(spec.key, spec.vertSrc, spec.fragSrc);
    gl.useProgram(info.prog);
    gl.bindVertexArray(this.vao);
    const stateUnit = this._bindImages(info, spec);   // uState goes on the unit after the inputs
    this._setControls(info, spec);
    gl.uniform2f(this._loc(info, 'uSimRes'), size, size);
    gl.uniform1f(this._loc(info, 'uTime'), spec.time || 0);

    // (re)seed when the effect, its inputs, or the grid size changed
    if (sim.token !== spec.resetToken) {
      this._simPass(info, sim.texA, sim.texB, 2.0, size, stateUnit);   // seed → texA
      sim.token = spec.resetToken; sim.frame = 0;
    }
    // advance one step: read texA → write texB, then swap
    if (spec.advance) {
      this._simPass(info, sim.texB, sim.texA, 0.0, size, stateUnit);
      const t = sim.texA; sim.texA = sim.texB; sim.texB = t; sim.frame++;
    }
    // display the current field to the real target (canvas / pool / capture FBO)
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

  // render one sim/seed pass into dstTex; srcTex is bound as uState (stateUnit)
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

  // ── chaining shader steps GPU→GPU through an intermediate texture pool ──────
  _ensurePool(size) {
    const gl = this.gl;
    if (this.pool && this.pool.size === size) return this.pool;
    if (this.pool) { gl.deleteTexture(this.pool.texA); gl.deleteTexture(this.pool.texB); }
    const mk = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const fbo = (this.pool && this.pool.fbo) || gl.createFramebuffer();
    this.pool = { size, texA: mk(), texB: mk(), fbo };
    return this.pool;
  }

  // draw a texture straight onto a target (used to present AI/cached stills)
  _blit(tex, targetFbo, size) {
    const gl = this.gl;
    const info = this.ensureProgram('__copy', COPY_VERT, COPY_FRAG);
    gl.useProgram(info.prog); gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, size, size);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this._loc(info, 'uColor'), 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // Render a list of steps; the final step lands on finalFbo (null = canvas).
  // Each step's color flow is the previous step's output texture; shader steps
  // declare which input that is via flowInput. AI steps contribute a cached
  // still (cachedTex/cachedImg); an un-generated AI step stops the chain early.
  _renderChain(chainSpec, size, finalFbo) {
    const gl = this.gl;
    const steps = chainSpec.steps || [];
    const pool = this._ensurePool(size);
    if (!steps.length) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, finalFbo);
      gl.viewport(0, 0, size, size); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    let inputTex = chainSpec.sourceTex || this.texFor(chainSpec.sourceImg, 'black');
    let useA = true;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const last = i === steps.length - 1;

      if (step.bypass) {                          // muted step → input flows straight through
        if (last) this._blit(inputTex, finalFbo, size);
        continue;
      }

      if (step.cached || step.kind === 'ai') {
        const ctex = step.cachedTex || (step.cachedImg ? this.texFor(step.cachedImg, 'black') : null);
        if (!ctex) { this._blit(inputTex, finalFbo, size); return; }   // not generated yet → stop
        inputTex = ctex;
        if (last) this._blit(inputTex, finalFbo, size);
        continue;
      }

      const outTex = useA ? pool.texA : pool.texB;
      if (last) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, finalFbo);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pool.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
      }
      this._draw(Object.assign({}, step, { flowTex: inputTex, time: chainSpec.time, advance: chainSpec.advance }), size, size);
      if (!last) { inputTex = outTex; useA = !useA; }
    }
  }

  // ── public render entry points ──────────────────────────────────────────────
  renderToCanvas(spec, size) {
    if (this.canvas.width !== size) { this.canvas.width = size; this.canvas.height = size; }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this._draw(spec, size, size);
  }

  renderChainToCanvas(chainSpec, size) {
    if (this.canvas.width !== size) { this.canvas.width = size; this.canvas.height = size; }
    this._renderChain(chainSpec, size, null);
  }

  async renderToBlob(spec, size) {
    this._ensureCaptureFbo(size);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this._draw(spec, size, size);
    return this._readBlob(size);
  }

  async renderChainToBlob(chainSpec, size) {
    this._ensureCaptureFbo(size);
    this._renderChain(chainSpec, size, this.fbo);
    return this._readBlob(size);
  }

  _ensureCaptureFbo(size) {
    const gl = this.gl;
    if (this.fboSize === size) return;
    if (this.fboTex) gl.deleteTexture(this.fboTex);
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    this.fboSize = size;
  }

  // read this.fbo back into a top-left-origin PNG blob (GL is bottom-left)
  _readBlob(size) {
    const gl = this.gl;
    const px = new Uint8Array(size * size * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(size, size);
    const row = size * 4;
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * row, (size - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }
}

// Load an image element from a URL (cached by URL so the same source reuses it).
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
