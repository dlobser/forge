// graphApp.js — bootstrap for the Forge Graph version. Sets up the WebGL engine,
// loads the gallery / shader defs / workflows into RT, registers node types,
// creates the litegraph canvas, drives a single rAF loop (evaluate the graph in
// topological order, then redraw), and persists the graph to projects/<p>/graph.json.
import { ShaderEngine } from './engine.js';
// relative specifier: resolves against THIS file's own URL, not wherever the page
// is mounted, so it works under any subfolder
import { api } from '../../js/api.js';
import { RT } from './runtime.js';
import { registerNodes } from './nodes.js';
import { doc, initFileMenu, markDirty, updateTitle } from './filemenu.js';
import { askText } from './ui.js';

const LG = window.LiteGraph;
const $ = (id) => document.getElementById(id);
let t0 = performance.now();

// See boot.js for why this exists: the API bakes/serves shader & math-node paths
// as root-absolute strings, which break under a subfolder-mounted static build
// (and can't be fixed by the fetch shim, since dynamic import() bypasses it).
const SITE_ROOT = new URL('../../../', import.meta.url);
const siteURL = (absPath) => new URL(absPath.replace(/^\//, ''), SITE_ROOT);

// ── toast ──────────────────────────────────────────────────────────────────────
function toast(msg, kind) {
  const box = $('toast'); const el = document.createElement('div');
  el.className = 't' + (kind ? ' ' + kind : ''); el.textContent = msg;
  box.appendChild(el); setTimeout(() => el.remove(), 3000);
}

// ── shader defs (mirror of state.loadShaderDefs) ───────────────────────────────
async function loadShaderDefs() {
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
    try { const mod = await import(siteURL(m.js).href + '?t=' + Date.now()); defs.push({ key: m.key, def: mod.default || {} }); }
    catch (e) { console.warn('math node load failed', m.key, e); }
  }
  return defs;
}

// ── evaluation (one topological pass) ──────────────────────────────────────────
function evalOnce(advance) {
  const order = RT.graph.computeExecutionOrder(false, false);
  for (const n of order) {
    if (n.evaluate) { try { n.evaluate(RT); } catch (e) { console.error('node error', n.title, e); } }
    // bundled litegraph nodes use onExecute() instead of Forge's evaluate(RT);
    // running them here lets curated built-ins flow numbers into shader pins
    else if (n.onExecute) { try { n.onExecute(); } catch (e) {} }
  }
}

// ── graph persistence ───────────────────────────────────────────────────────────
// Autosave is a safety net, not the Save command: it writes the working state of
// the current document so a crash or closed tab loses nothing, but never records
// a version. Explicit Save (File ▸ Save / Ctrl+S, in filemenu.js) is what appends
// to the history — otherwise every keystroke would become a "version".
let saveTimer = null;
function requestSave() {
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fetch('/api/graph', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: RT.project, name: doc.name, graph: RT.graph.serialize() }),
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

// Whichever document the project opens on becomes the current one.
async function syncDocName() {
  try {
    const r = await fetch('/api/graphs?project=' + encodeURIComponent(RT.project));
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.current) { doc.name = d.current; updateTitle(); }
  } catch (e) { /* static build has no documents */ }
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
  await syncDocName();
  await loadGraph(name);
  doc.savedRev = doc.rev; doc.dirty = false; updateTitle();
}

// File ▸ New Project… and the post-import switch both come through here.
async function createProject(name) {
  await api.createProject(name);
  await fillProjects();
  $('projectSelect').value = name;
  await switchProject(name);
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
  $('importInput').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
    toast('Importing…');
    try { for (const f of files) await api.importImage(RT.project, f, false, 1024); await refreshGallery(); toast('Imported', 'good'); }
    catch (err) { toast('Import failed: ' + err.message, 'bad'); }
  };
  $('addNodeBtn').onclick = (e) => { if (RT.graphcanvas.showSearchBox) RT.graphcanvas.showSearchBox(e); };

  // hooks the File menu calls back into (it owns the UI, graphApp owns the state)
  RT.newProject = async () => {
    const name = await askText({ title: 'New project', sub: 'A project is a workspace with its own image gallery.', value: '', ok: 'Create' });
    if (!name) return;
    try { await createProject(name); toast('Project “' + name + '” created', 'good'); }
    catch (e2) { toast('Could not create: ' + e2.message, 'bad'); }
  };
  RT.onProjectImported = async (name) => {
    await fillProjects();
    const sel = $('projectSelect');
    if (sel) sel.value = name;
    await switchProject(name);
  };

  // global play / pause (freezes time + feedback; edits still re-render)
  const playBtn = $('playBtn');
  const updatePlay = () => { playBtn.textContent = RT.playing ? '⏸' : '▶'; playBtn.title = RT.playing ? 'Pause' : 'Play'; };
  playBtn.onclick = () => { RT.playing = !RT.playing; updatePlay(); };
  updatePlay();

  // settings: default render size (persisted in localStorage)
  const setPanel = $('settingsPanel');
  $('settingsBtn').onclick = () => { setPanel.hidden = !setPanel.hidden; };
  const rsSel = $('defaultRenderSize');
  rsSel.value = String(RT.RENDER_SIZE);
  rsSel.onchange = () => { RT.RENDER_SIZE = +rsSel.value || 512; localStorage.setItem('forge.graph.renderSize', String(RT.RENDER_SIZE)); toast('Default render size: ' + RT.RENDER_SIZE); };

  // comfy is checked once on boot (and again when an AI node is created); no polling
  pollComfy();

  // File menu last: it needs RT.graph and RT.project already in place, and it
  // probes the backend to decide which items this build can actually offer.
  await initFileMenu();

  // the single render/eval loop — time accumulates only while playing, so pause
  // freezes time-driven shaders and feedback sims (RT.advance gates the nodes).
  let lastT = performance.now();
  function frame() {
    const now = performance.now();
    RT.dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;
    if (!RT.capturing) {                 // during sequence capture the node owns time/eval
      if (RT.playing) { RT.time += RT.dt; RT.frame++; }
      RT.advance = RT.playing;
      evalOnce();
    }
    try { RT.graphcanvas.draw(true, true); } catch (e) {}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
