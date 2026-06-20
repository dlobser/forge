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
  comfyOk: false,
  checkComfy() {},      // assigned by graphApp; re-checks ComfyUI reachability
  RENDER_SIZE: 512,     // per-node output texture size (square)

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
