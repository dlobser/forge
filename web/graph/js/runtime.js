// runtime.js — a small shared singleton the node definitions read from. graphApp
// populates it (engine, api, current project, gallery, shader defs, workflows, the
// frame clock) and provides the helper callbacks (toast, requestSave, evalOnce).
export const RT = {
  engine: null,
  api: null,
  project: 'Untitled',
  gallery: [],          // [{filename, kind, ...}]
  workflows: [],        // [{key, name, format}]
  shaderDefs: [],       // [{key, def, vertSrc, fragSrc}]
  mathDefs: [],         // [{key, def}] math-node manifests
  graph: null,
  graphcanvas: null,
  time: 0,
  dt: 0,
  frame: 0,
  playing: true,        // global play/pause: when false, time + feedback freeze
  advance: true,        // whether this eval should step time/feedback
  capturing: false,

  // Per-frame callbacks, run by whichever page owns the rAF loop (graphApp or
  // play). The live fullscreen overlay uses this to keep drawing while it's up —
  // it can't own a loop of its own without a second eval pass.
  hooks: new Set(),
  addHook(fn) { this.hooks.add(fn); return () => this.hooks.delete(fn); },
  runHooks() { for (const fn of this.hooks) { try { fn(); } catch (e) {} } },

  comfyOk: false,
  checkComfy() {},      // assigned by graphApp; re-checks ComfyUI reachability
  // default per-node render size (square). Per-node override lives in
  // node.properties.renderSize; this default is editable in Settings (localStorage).
  RENDER_SIZE: (() => { const v = parseInt(localStorage.getItem('forge.graph.renderSize'), 10); return v >= 64 ? v : 512; })(),

  // assigned by graphApp:
  toast(msg, kind) {},
  requestSave() {},
  refreshGallery() {},
  evalOnce(advance) {},
  redraw() { if (this.graph) this.graph.setDirtyCanvas(true, true); },

  imageURL(file) { return this.api.imageURL(this.project, file); },
  thumbURL(file) { return this.api.thumbURL(this.project, file); },
  shaderDef(key) { return this.shaderDefs.find((d) => d.key === key); },
};
