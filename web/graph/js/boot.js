// boot.js — shared loaders for booting the Forge Graph runtime. These are the same
// routines graphApp.js uses to populate RT (shader/math defs) and to evaluate the
// graph each frame. They are duplicated here (rather than imported from graphApp,
// which is an IIFE that boots the editor) so the published page can reuse them
// without dragging in the editor; a later refactor can have graphApp import these.
import { api } from '/web/js/api.js';
import { RT } from './runtime.js';

// scan /api/shaders, import each manifest, fetch its frag/vert sources
export async function loadShaderDefs() {
  const { shaders } = await api.shaders();
  const defVert = await (await fetch('/shaders/_fullscreen.vert')).text();
  const defs = [];
  for (const s of shaders) {
    try {
      const mod = await import(s.js + '?t=' + Date.now());
      const def = mod.default || {};
      const fragSrc = s.frag ? await (await fetch(s.frag)).text() : '';
      const vertSrc = s.vert ? await (await fetch(s.vert)).text() : defVert;
      defs.push({ key: s.key, def, vertSrc, fragSrc });
    } catch (e) { console.warn('shader load failed', s.key, e); }
  }
  return defs.map((d) => ({ key: d.key, vertSrc: d.vertSrc, fragSrc: d.fragSrc, ...d.def, def: d.def }));
}

// flatten so nodes read def.inputs/controls/feedback directly but keep .key/src
export function normalizeDefs(raw) {
  return raw.map((d) => ({
    key: d.key, name: d.def.name, vertSrc: d.vertSrc, fragSrc: d.fragSrc,
    inputs: d.def.inputs, inputLabels: d.def.inputLabels, controls: d.def.controls,
    feedback: d.def.feedback, animated: d.def.animated, simSize: d.def.simSize,
  }));
}

// scan /mathnodes and import each manifest
export async function loadMathDefs() {
  let list = [];
  try { list = (await (await fetch('/api/mathnodes')).json()).mathnodes || []; } catch (e) { return []; }
  const defs = [];
  for (const m of list) {
    try { const mod = await import(m.js + '?t=' + Date.now()); defs.push({ key: m.key, def: mod.default || {} }); }
    catch (e) { console.warn('math node load failed', m.key, e); }
  }
  return defs;
}

// one topological evaluation pass over the graph
export function evalOnce() {
  const order = RT.graph.computeExecutionOrder(false, false);
  for (const n of order) {
    if (n.evaluate) { try { n.evaluate(RT); } catch (e) { console.error('node error', n.title, e); } }
  }
}
