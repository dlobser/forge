// boot.js — shared loaders for booting the Forge Graph runtime: the shader/math
// defs that populate RT, and the per-frame evaluation pass. Both the editor
// (graphApp.js) and the published page (play.js) import these. They used to keep
// separate copies, and the published page's copy fell behind — it dropped the GPU
// pipeline fields, so GPU Particles broke there and only there.
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
export const siteURL = (absPath) => new URL(absPath.replace(/^\//, ''), SITE_ROOT);

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

// Flatten so nodes read def.inputs / def.controls / def.pipeline… directly, keeping
// .key and the loaded sources. Every manifest field comes through: a hand-kept list
// of fields is how the pipeline ones went missing, and a new manifest field
// shouldn't need a change here to reach its node.
export function normalizeDefs(raw) {
  return raw.map((d) => ({ ...d.def, key: d.key, vertSrc: d.vertSrc, fragSrc: d.fragSrc }));
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

// ── mute (bypass) ───────────────────────────────────────────────────────────────
// A muted node doesn't run at all — no render, no GPU cost — and passes its input
// straight through instead: each output takes the input of the same type in the
// same position (a Blend's `out` gets A; a muted Multiply passes its first number
// on). An output with no matching input (a source, a synth) goes empty unless the
// node offers a `mutedOutput(slot)`. The mode is litegraph's own `node.mode`, so it
// saves with the graph; 4 is the value ComfyUI uses for bypass, and litegraph's
// "Never" (2) is treated the same so its built-in Mode menu agrees.
export const MUTED = 4;
export const isMuted = (n) => !!n && (n.mode === MUTED || n.mode === 2);

function bypass(n) {
  const ins = n.inputs || [], outs = n.outputs || [];
  const seen = {};
  outs.forEach((o, i) => {
    const k = seen[o.type] = (seen[o.type] || 0) + 1;      // this is the k-th output of its type
    const same = [];
    ins.forEach((s, j) => { if (s.type === o.type) same.push(j); });
    let v;
    if (same.length) v = n.getInputData(same[Math.min(k, same.length) - 1]);
    else if (n.mutedOutput) v = n.mutedOutput(i);
    n.setOutputData(i, v);
  });
}

// one topological evaluation pass over the graph
export function evalOnce() {
  const order = RT.graph.computeExecutionOrder(false, false);
  for (const n of order) {
    const muted = isMuted(n);
    if (muted !== !!n._muted) {
      n._muted = muted;
      if (n.onMuteChange) { try { n.onMuteChange(muted); } catch (e) {} }
      if (!muted) n._dirty = true;          // re-render on the way back in
    }
    if (muted) { try { bypass(n); } catch (e) {} continue; }
    // An input that now comes from a different node — a link moved, or an upstream
    // node was muted and its input passed through — must re-render this one even if
    // the two images happen to share a version number. Nodes only compared versions,
    // so that change used to go unnoticed.
    const ins = n.inputs;
    if (ins && ins.length) {
      const seen = n._inSeen || (n._inSeen = []);
      for (let i = 0; i < ins.length; i++) {
        const d = ins[i].link != null ? n.getInputData(i) : undefined;
        const o = d && typeof d === 'object' ? d : null;
        if (seen[i] !== o) { seen[i] = o; n._dirty = true; }
      }
    }
    if (n.evaluate) { try { n.evaluate(RT); } catch (e) { console.error('node error', n.title, e); } }
    // bundled litegraph nodes use onExecute() rather than Forge's evaluate(RT)
    else if (n.onExecute) { try { n.onExecute(); } catch (e) {} }
  }
}
