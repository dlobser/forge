// display.js — owns the WebGL canvas and the live preview. Two modes:
//   'effect' — one shader-effect instance (Shaders tab), the existing behaviour.
//   'chain'  — a whole pipeline (Chain tab): each frame it asks chain.js for a
//              fully-resolved chainSpec (steps + preloaded image elements) and
//              renders the steps GPU→GPU. Params/selection are read live off the
//              spec function, so edits update the preview with no rebuild.
import { ShaderEngine, loadImage } from './shaderEngine.js';
import { S } from './state.js';

class Display {
  constructor() {
    this.canvas = document.getElementById('glcanvas');
    this.engine = new ShaderEngine(this.canvas);
    this.mode = 'effect';            // 'effect' | 'chain'
    this.effect = null; this.def = null;
    this.colorImg = null; this.depthImg = null;
    this.chainSpecFn = null;         // (advance) => chainSpec, supplied by chain.js
    this.playing = false; this.t0 = 0; this.time = 0;
    this._raf = null;
    this.onTime = null;              // callback(seconds) for the transport readout
  }

  _previewSize() {
    const panel = this.canvas.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = Math.min(panel.clientWidth, panel.clientHeight) || 720;
    return Math.max(256, Math.min(Math.round(s * dpr), 1280));
  }

  // ── single effect (Shaders tab) ────────────────────────────────────────────
  spec(time, advance = false) {
    const d = this.def.def, e = this.effect;
    const simSize = e.simSize || d.simSize || 256;
    return {
      key: this.def.key, vertSrc: this.def.vertSrc, fragSrc: this.def.fragSrc,
      controls: d.controls || [], params: e.params,
      colorImg: this.colorImg, depthImg: this.depthImg, time: time ?? this.time,
      feedback: !!d.feedback, simSize, advance, simKey: e.id,
      resetToken: `${e.id}|${simSize}|${e.color}|${e.depth}|${e.params.uSeedA ? 1 : 0}`,
    };
  }

  async setEffect(effect) {
    this.stop();
    this.mode = 'effect';
    this.effect = effect;
    this.def = S.shaderDef(effect.shader);
    if (!this.def) { this.clear(); return; }
    await this.reloadImages();
    if (effect.animated) this.play(); else this.renderStatic();
  }

  async reloadImages() {
    if (!this.effect) return;
    const [c, d] = await Promise.all([
      loadImage(S.imageURL(this.effect.color)).catch(() => null),
      loadImage(S.imageURL(this.effect.depth)).catch(() => null),
    ]);
    this.colorImg = c; this.depthImg = d;
    if (!this.playing) this.renderStatic();
  }

  renderStatic(advance = false) {
    if (this.mode !== 'effect' || !this.effect || !this.def) return;
    try { this.engine.renderToCanvas(this.spec(this.time, advance), this._previewSize()); }
    catch (e) { console.error(e); }
  }

  resetSim() { this.engine.resetSim(this.effect?.id); if (!this.playing) this.renderStatic(); }

  // ── chain (Chain tab) ──────────────────────────────────────────────────────
  setChain(specFn) {
    const entering = this.mode !== 'chain';
    if (entering) { this.stop(); this.mode = 'chain'; this.effect = null; this.def = null; }
    this.chainSpecFn = specFn;
    if (entering) { this.t0 = performance.now() - this.time * 1000; this.playing = true; this._loop(); }
  }

  renderChainOnce(advance = false) {
    if (this.mode !== 'chain' || !this.chainSpecFn) return;
    try {
      const cs = this.chainSpecFn(advance); cs.time = this.time;
      this.engine.renderChainToCanvas(cs, this._previewSize());
    } catch (e) { console.error(e); }
  }

  resetChainSim() { this.engine.resetSim(); if (!this.playing) this.renderChainOnce(false); }

  captureChain(size, advance = false) {
    const cs = this.chainSpecFn(advance); cs.time = this.time;
    return this.engine.renderChainToBlob(cs, size);
  }

  // capture an explicitly-built chainSpec (used to bake an AI step's input)
  captureChainSpec(cs, size) { cs.time = this.time; return this.engine.renderChainToBlob(cs, size); }

  resume() {
    if (this.playing) return;
    this.playing = true; this.t0 = performance.now() - this.time * 1000; this._loop();
  }

  // ── shared transport / loop ────────────────────────────────────────────────
  play() {
    if (this.mode !== 'effect' || !this.effect || !this.def) return;
    this.playing = true; this.t0 = performance.now() - this.time * 1000; this._loop();
  }

  _loop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    const step = () => {
      if (!this.playing) return;
      this.time = (performance.now() - this.t0) / 1000;
      if (this.mode === 'chain') this.renderChainOnce(true);
      else this.renderStatic(true);
      this.onTime && this.onTime(this.time);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  pause() { this.playing = false; if (this._raf) cancelAnimationFrame(this._raf); }
  stop() { this.pause(); this.time = 0; this.mode = 'effect'; this.chainSpecFn = null; }

  clear() {
    this.pause(); this.mode = 'effect'; this.effect = null; this.def = null; this.chainSpecFn = null;
    const gl = this.engine.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.05, 0.06, 0.07, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  capture(size, time, advance = false) { return this.engine.renderToBlob(this.spec(time, advance), size); }

  // show a still image (AI output / gallery selection) instead of the canvas
  showImage(url) {
    this.pause(); this.mode = 'effect'; this.chainSpecFn = null;
    const img = document.getElementById('displayImage');
    img.src = url; img.hidden = false;
    this.canvas.style.display = 'none';
  }
  showCanvas() {
    const img = document.getElementById('displayImage');
    if (img) img.hidden = true;
    this.canvas.style.display = '';
  }
}

export const display = new Display();
