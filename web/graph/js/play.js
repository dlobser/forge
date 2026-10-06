// play.js — the published "end-user" page. Boots the same node runtime as the
// editor (engine, shader/math defs, node types) but shows NO node canvas: it loads
// the project's graph.json, reads graph.extra.endUser, and renders the tagged
// controls + previews via endui.js. The graph still evaluates every frame under the
// hood. It is read-only w.r.t. graph.json — RT.requestSave is a no-op, so an
// end-user's slider tweaks never overwrite the author's saved graph.
import { ShaderEngine } from './engine.js';
// relative specifier: resolves against THIS file's own URL, not wherever the page
// is mounted, so it works under any subfolder
import { api } from '../../js/api.js';
import { RT } from './runtime.js';
import { registerNodes, isCloudAI } from './nodes.js';
import { loadShaderDefs, normalizeDefs, loadMathDefs, evalOnce } from './boot.js';
import { buildEndUserUI } from './endui.js';
import { decodeGraph, readHash } from './share.js';
import { toast } from './ui.js';
import { cloud, openCloudDialog, onCloudChange, mountCloudIndicator } from './cloudai.js';

const LG = window.LiteGraph;
const $ = (id) => document.getElementById(id);

// An "Edit" link that carries the shared graph into the editor. Shown for shared
// links unless the creator hid it (&e=0). It sits in the viewer's action row beside
// ⬇ / ⤢ (see buildEndUserUI) — never floating over them.
function editButton(payload) {
  const a = document.createElement('a');
  a.className = 'eu-iconbtn eu-textbtn';
  a.textContent = '✎ Edit';
  a.title = 'Open this in the Forge editor and tinker';
  const url = new URL('index.html', location.href);
  url.hash = 'g=' + payload;
  a.href = url.toString();
  return a;
}

// Where a visitor picks ChatGPT or Gemini and enters their own key, so the page's
// Cloud AI nodes (Depth, Generate) can run. Only offered when the graph has one.
function aiButton() {
  const b = document.createElement('button');
  b.className = 'eu-iconbtn eu-textbtn';
  b.textContent = '✦ AI';
  const sync = () => {
    b.classList.toggle('on', cloud.ready);
    b.title = cloud.ready ? 'Cloud AI: ' + cloud.name + ' (' + cloud.model + ')'
      : 'Cloud AI — pick ChatGPT or Gemini and add your API key';
  };
  b.onclick = () => openCloudDialog();
  onCloudChange(sync); sync();
  return b;
}

(async function boot() {
  const params = new URLSearchParams(location.search);

  // runtime wiring
  RT.engine = new ShaderEngine($('glcanvas'));
  RT.api = api;
  // Errors only: they're the one thing a visitor needs to see (a bad API key, say);
  // the editor's "Saved" / "Imported" chatter means nothing on a published page.
  RT.toast = (msg, kind) => { if (kind === 'bad') toast(msg, kind); };
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

  // load the graph. A share link (#g=…) wins over stored/served project data: the
  // whole point is that the graph rides in the URL, no server needed.
  RT.graph = new window.LGraph();
  const hash = readHash();
  let data = {};
  if (hash.g) {
    try { data = await decodeGraph(hash.g); }
    catch (e) { console.error('bad share link', e); const b = $('boot'); if (b) { b.hidden = false; b.textContent = 'This share link is broken or from a newer version.'; } return; }
  } else {
    try { data = await (await fetch('/api/graph?project=' + encodeURIComponent(project))).json(); } catch (e) {}
  }
  if (data && data.nodes && data.nodes.length) { try { RT.graph.configure(data); } catch (e) { console.error('graph configure failed', e); } }

  // buttons for the viewer's action row; the creator can hide Edit per-link with &e=0
  const actions = [];
  if ((RT.graph._nodes || []).some(isCloudAI)) { actions.push(aiButton()); mountCloudIndicator({ where: 'bottom' }); }
  if (hash.g && hash.e !== '0') actions.push(editButton(hash.g));

  // build the published UI from the author's config
  const cfg = (RT.graph.extra && RT.graph.extra.endUser) || { title: '', controls: [], previews: [] };
  document.title = cfg.title || ('Forge — ' + project);
  const drawPreviews = buildEndUserUI($('app'), cfg, RT.graph, { actions });
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
    RT.runHooks();       // the fullscreen viewer draws from here
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
