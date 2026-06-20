// graphApp.js — bootstrap for the Forge Graph version. Sets up the WebGL engine,
// loads the gallery / shader defs / workflows into RT, registers node types,
// creates the litegraph canvas, drives a single rAF loop (evaluate the graph in
// topological order, then redraw), and persists the graph to projects/<p>/graph.json.
import { ShaderEngine } from './engine.js';
import { api } from '/web/js/api.js';
import { RT } from './runtime.js';
import { registerNodes } from './nodes.js';

const LG = window.LiteGraph;
const $ = (id) => document.getElementById(id);
let t0 = performance.now();

// ── toast ──────────────────────────────────────────────────────────────────────
function toast(msg, kind) {
  const box = $('toast'); const el = document.createElement('div');
  el.className = 't' + (kind ? ' ' + kind : ''); el.textContent = msg;
  box.appendChild(el); setTimeout(() => el.remove(), 3000);
}

// ── shader defs (mirror of state.loadShaderDefs) ───────────────────────────────
async function loadShaderDefs() {
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
function normalizeDefs(raw) {
  return raw.map((d) => ({
    key: d.key, name: d.def.name, vertSrc: d.vertSrc, fragSrc: d.fragSrc,
    inputs: d.def.inputs, inputLabels: d.def.inputLabels, controls: d.def.controls,
    feedback: d.def.feedback, animated: d.def.animated, simSize: d.def.simSize,
  }));
}

// scan /mathnodes and import each manifest (same pattern as shaders)
async function loadMathDefs() {
  let list = [];
  try { list = (await (await fetch('/api/mathnodes')).json()).mathnodes || []; } catch (e) { return []; }
  const defs = [];
  for (const m of list) {
    try { const mod = await import(m.js + '?t=' + Date.now()); defs.push({ key: m.key, def: mod.default || {} }); }
    catch (e) { console.warn('math node load failed', m.key, e); }
  }
  return defs;
}

// ── evaluation (one topological pass) ──────────────────────────────────────────
function evalOnce(advance) {
  const order = RT.graph.computeExecutionOrder(false, false);
  for (const n of order) {
    if (n.evaluate) { try { n.evaluate(RT); } catch (e) { console.error('node error', n.title, e); } }
  }
}

// ── graph persistence ───────────────────────────────────────────────────────────
let saveTimer = null;
function requestSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fetch('/api/graph', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: RT.project, graph: RT.graph.serialize() }),
      });
    } catch (e) { /* ignore */ }
  }, 500);
}
async function loadGraph(project) {
  let data = {};
  try { data = await (await fetch('/api/graph?project=' + encodeURIComponent(project))).json(); } catch (e) {}
  RT.graph.clear();
  if (data && data.nodes && data.nodes.length) {
    try { RT.graph.configure(data); } catch (e) { console.error('graph configure failed', e); }
  }
  RT.redraw();
}

// ── projects ─────────────────────────────────────────────────────────────────
async function fillProjects() {
  const { projects, current } = await api.listProjects();
  RT.project = current || projects[0] || 'Untitled';
  const sel = $('projectSelect'); sel.innerHTML = '';
  for (const p of projects) { const o = document.createElement('option'); o.value = o.textContent = p; if (p === RT.project) o.selected = true; sel.appendChild(o); }
}
async function refreshGallery() {
  try { RT.gallery = (await api.gallery(RT.project)).images; } catch (e) { RT.gallery = []; }
}
async function switchProject(name) {
  RT.project = name;
  await api.selectProject(name).catch(() => {});
  await refreshGallery();
  await loadGraph(name);
}

// ── comfy status ──────────────────────────────────────────────────────────────
async function pollComfy() {
  try { const s = await api.comfyStatus(); RT.comfyOk = !!s.ok; const d = $('comfyDot');
    d.classList.toggle('ok', !!s.ok); d.textContent = s.ok ? (s.depth ? 'comfy ✓' : 'comfy (no depth)') : 'comfy ✗';
  } catch (e) { RT.comfyOk = false; }
}

// ── canvas sizing ───────────────────────────────────────────────────────────────
function resizeCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(640, Math.floor(r.width));
  canvas.height = Math.max(400, Math.floor(r.height));
  if (RT.graphcanvas) RT.graphcanvas.resize(canvas.width, canvas.height);
}

// ── boot ──────────────────────────────────────────────────────────────────────
(async function boot() {
  // engine on the offscreen webgl canvas
  RT.engine = new ShaderEngine($('glcanvas'));
  RT.api = api;
  RT.toast = toast;
  RT.requestSave = requestSave;
  RT.refreshGallery = refreshGallery;
  RT.evalOnce = evalOnce;
  RT.checkComfy = pollComfy;     // re-check on demand (boot + AI-node creation)

  // data
  await fillProjects();
  await refreshGallery();
  try { RT.shaderDefs = normalizeDefs(await loadShaderDefs()); } catch (e) { RT.shaderDefs = []; console.error(e); }
  try { RT.mathDefs = await loadMathDefs(); } catch (e) { RT.mathDefs = []; }
  try { RT.workflows = (await api.workflows()).workflows; } catch (e) { RT.workflows = []; }

  // node types
  LG.clearRegisteredTypes && LG.clearRegisteredTypes();
  registerNodes();

  // litegraph
  RT.graph = new window.LGraph();
  const canvas = $('graphcanvas');
  RT.graphcanvas = new window.LGraphCanvas(canvas, RT.graph);
  RT.graphcanvas.background_image = null;
  RT.graph.onAfterChange = () => requestSave();
  RT.graph.onNodeAdded = () => requestSave();
  RT.graph.onNodeRemoved = () => requestSave();
  resizeCanvas(canvas);
  window.addEventListener('resize', () => resizeCanvas(canvas));

  await loadGraph(RT.project);

  // topbar
  $('projectSelect').onchange = (e) => switchProject(e.target.value).catch((err) => toast(err.message, 'bad'));
  $('newProjectBtn').onclick = async () => {
    const name = prompt('New project name:'); if (!name) return;
    await api.createProject(name); await fillProjects(); $('projectSelect').value = name;
    await switchProject(name); toast('Project “' + name + '” created', 'good');
  };
  $('importBtn').onclick = () => $('importInput').click();
  $('importInput').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
    toast('Importing…');
    try { for (const f of files) await api.importImage(RT.project, f, false, 1024); await refreshGallery(); toast('Imported', 'good'); }
    catch (err) { toast('Import failed: ' + err.message, 'bad'); }
  };
  $('addNodeBtn').onclick = (e) => { if (RT.graphcanvas.showSearchBox) RT.graphcanvas.showSearchBox(e); };
  $('saveGraphBtn').onclick = async () => {
    try { await fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: RT.project, graph: RT.graph.serialize() }) }); toast('Graph saved', 'good'); }
    catch (e2) { toast('Save failed', 'bad'); }
  };

  // comfy is checked once on boot (and again when an AI node is created); no polling
  pollComfy();

  // the single render/eval loop
  let lastT = performance.now();
  function frame() {
    const now = performance.now();
    RT.dt = (now - lastT) / 1000; lastT = now;
    RT.time = (now - t0) / 1000; RT.frame++;
    if (!RT.capturing) evalOnce(true);
    try { RT.graphcanvas.draw(true, true); } catch (e) {}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
