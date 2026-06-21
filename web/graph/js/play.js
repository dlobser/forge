// play.js — the published "end-user" page. Boots the same node runtime as the
// editor (engine, shader/math defs, node types) but shows NO node canvas: it loads
// the project's graph.json, reads graph.extra.endUser, and renders the tagged
// controls + previews via endui.js. The graph still evaluates every frame under the
// hood. It is read-only w.r.t. graph.json — RT.requestSave is a no-op, so an
// end-user's slider tweaks never overwrite the author's saved graph.
import { ShaderEngine } from './engine.js';
import { api } from '/web/js/api.js';
import { RT } from './runtime.js';
import { registerNodes } from './nodes.js';
import { loadShaderDefs, normalizeDefs, loadMathDefs, evalOnce } from './boot.js';
import { buildEndUserUI } from './endui.js';

const LG = window.LiteGraph;
const $ = (id) => document.getElementById(id);

(async function boot() {
  const params = new URLSearchParams(location.search);

  // runtime wiring
  RT.engine = new ShaderEngine($('glcanvas'));
  RT.api = api;
  RT.toast = () => {};
  RT.requestSave = () => {};                 // published page never writes graph.json
  RT.refreshGallery = async () => { try { RT.gallery = (await api.gallery(RT.project)).images; } catch (e) { RT.gallery = []; } };
  RT.evalOnce = () => evalOnce();
  RT.checkComfy = async () => { try { const s = await api.comfyStatus(); RT.comfyOk = !!s.ok; } catch (e) { RT.comfyOk = false; } };
  RT.redraw = () => {};                       // no node canvas to invalidate

  // pick project (?project=… or the current one)
  let project = params.get('project');
  if (!project) { try { const { current, projects } = await api.listProjects(); project = current || projects[0] || 'Untitled'; } catch (e) { project = 'Untitled'; } }
  RT.project = project;
  await RT.refreshGallery();

  // defs + node types
  try { RT.shaderDefs = normalizeDefs(await loadShaderDefs()); } catch (e) { RT.shaderDefs = []; console.error(e); }
  try { RT.mathDefs = await loadMathDefs(); } catch (e) { RT.mathDefs = []; }
  try { RT.workflows = (await api.workflows()).workflows; } catch (e) { RT.workflows = []; }
  LG.clearRegisteredTypes && LG.clearRegisteredTypes();
  registerNodes();

  // load the graph (no LGraphCanvas — evaluation only needs the LGraph)
  RT.graph = new window.LGraph();
  let data = {};
  try { data = await (await fetch('/api/graph?project=' + encodeURIComponent(project))).json(); } catch (e) {}
  if (data && data.nodes && data.nodes.length) { try { RT.graph.configure(data); } catch (e) { console.error('graph configure failed', e); } }

  // build the published UI from the author's config
  const cfg = (RT.graph.extra && RT.graph.extra.endUser) || { title: '', controls: [], previews: [] };
  document.title = cfg.title || ('Forge — ' + project);
  const drawPreviews = buildEndUserUI($('app'), cfg, RT.graph);
  const bootEl = $('boot'); if (bootEl) bootEl.hidden = true;

  RT.checkComfy();

  // eval + preview loop (always playing on the published page)
  let lastT = performance.now();
  function frame() {
    const now = performance.now();
    RT.dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;
    RT.time += RT.dt; RT.frame++;
    RT.advance = true;
    if (!RT.capturing) evalOnce();
    drawPreviews();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
