// boot.js — shared loaders for booting the Forge Graph runtime. These are the same
// routines graphApp.js uses to populate RT (shader/math defs) and to evaluate the
// graph each frame. They are duplicated here (rather than imported from graphApp,
// which is an IIFE that boots the editor) so the published page can reuse them
// without dragging in the editor; a later refactor can have graphApp import these.
// relative specifier: resolves against THIS file's own URL (web/graph/js/), not
// wherever the page happens to be mounted, so it works under any subfolder
import { api } from '../../js/api.js';
import { RT } from './runtime.js';

// The API bakes/serves shader and math-node paths as root-absolute strings
// ('/shaders/blur.js') because that is what the desktop server actually mounts them
// at. A static build embedded under a subfolder (e.g. a portfolio site's /forge/)
// is NOT at domain root, so those absolute strings would 404 against the wrong
// origin path — and dynamic import()/fetch() can't be intercepted by the API shim
// the way regular /api/ calls are. Fix: resolve them ourselves, anchored to this
// module's own URL (import.meta.url), which sits at the same fixed depth under the
// site root in every deployment (desktop, static root, or static subfolder).
const SITE_ROOT = new URL('../../../', import.meta.url);
const siteURL = (absPath) => new URL(absPath.replace(/^\//, ''), SITE_ROOT);

// scan /api/shaders, import each manifest, fetch its frag/vert sources
export async function loadShaderDefs() {
  const { shaders } = await api.shaders();
  const defVert = await (await fetch(siteURL('/shaders/_fullscreen.vert'))).text();
  const defs = [];
  for (const s of shaders) {
    try {
      const mod = await import(siteURL(s.js).href + '?t=' + Date.now());
      const def = mod.default || {};
      const fragSrc = s.frag ? await (await fetch(siteURL(s.frag))).text() : '';
      const vertSrc = s.vert ? await (await fetch(siteURL(s.vert))).text() : defVert;
      defs.push({ key: s.key, def, vertSrc, fragSrc });
    } catch (e) { console.warn('shader load failed', s.key, e); }
  }
  return defs.map((d) => ({ key: d.key, vertSrc: d.vertSrc, fragSrc: d.fragSrc, ...d.def, def: d.def }));
}

// flatten so nodes read def.inputs/controls/feedback directly but keep .key/src
export function normalizeDefs(raw) {
  return raw.map((d) => ({
    key: d.key, name: d.def.name, category: d.def.category, vertSrc: d.vertSrc, fragSrc: d.fragSrc,
    inputs: d.def.inputs, inputLabels: d.def.inputLabels, inputDefaults: d.def.inputDefaults,
    controls: d.def.controls, feedback: d.def.feedback, history: d.def.history,
    animated: d.def.animated, simSize: d.def.simSize, simSizes: d.def.simSizes,
    simBuffers: d.def.simBuffers, simPasses: d.def.simPasses, outputs: d.def.outputs,
  }));
}

// scan /mathnodes and import each manifest
export async function loadMathDefs() {
  let list = [];
  try { list = (await (await fetch('/api/mathnodes')).json()).mathnodes || []; } catch (e) { return []; }
  const defs = [];
  for (const m of list) {
    try { const mod = await import(siteURL(m.js).href + '?t=' + Date.now()); defs.push({ key: m.key, def: mod.default || {} }); }
    catch (e) { console.warn('math node load failed', m.key, e); }
  }
  return defs;
}

// one topological evaluation pass over the graph
export function evalOnce() {
  const order = RT.graph.computeExecutionOrder(false, false);
  for (const n of order) {
    if (n.evaluate) { try { n.evaluate(RT); } catch (e) { console.error('node error', n.title, e); } }
    // bundled litegraph nodes use onExecute() rather than Forge's evaluate(RT)
    else if (n.onExecute) { try { n.onExecute(); } catch (e) {} }
  }
}
