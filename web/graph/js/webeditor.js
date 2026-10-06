// webeditor.js — web-only additions to the node editor. Injected by export_static.py
// ONLY into the editor web build, so the desktop app (which serves the same source
// files) never sees any of this. Two jobs:
//
//   1. a Help popup — what works on the web vs. what needs the desktop app
//   2. forking — opening an index.html#g=… link drops that graph into a fresh
//      workspace so the visitor can tinker without a server
//
// Share / Export / Import used to live here too, which is why they appeared only
// in the web build. They are now in the File menu (filemenu.js), which both builds
// load; filemenu probes the backend and routes through ForgeStore here and through
// /api/* on the desktop. Keeping them here as well would have produced two "Import"
// buttons meaning different things — one for images, one for .forge.json files.
//
// It is a module, loaded after graphApp.js, so RT and window.ForgeStore already
// exist by the time it runs (it still waits for RT.graph to be built).
import { RT } from './runtime.js';
import { decodeGraph, readHash } from './share.js';
import { BTN_PRIMARY, h, modal, title, toast } from './ui.js';

const $ = (id) => document.getElementById(id);

function waitFor(test, ms = 8000) {
  return new Promise((res) => {
    const t0 = Date.now();
    (function poll() {
      if (test()) return res(true);
      if (Date.now() - t0 > ms) return res(false);
      setTimeout(poll, 60);
    })();
  });
}

// ── Help ─────────────────────────────────────────────────────────────────────
function openHelp() {
  modal((card, close) => {
    title(card, 'Welcome to Forge');

    const p = (html) => { const d = h('div', 'color:#c9ced6;margin-bottom:12px'); d.innerHTML = html; card.appendChild(d); };
    const strong = (s) => '<b style="color:#e6e8ea">' + s + '</b>';

    p('Wire ' + strong('shader') + ' and ' + strong('math') + ' nodes into a live image, '
      + 'then hit ' + strong('Author UI') + ' to expose just the sliders and previews you '
      + 'want — that becomes the front-end people see.');

    p('Your work is saved ' + strong('in this browser only') + '. Nothing uploads. '
      + 'Use ' + strong('File ▸ Share link') + ' to hand someone a link — the entire graph '
      + 'travels inside the URL, so it opens instantly with no server. Clearing your browser '
      + 'data erases everything, so ' + strong('File ▸ Export Graph') + ' a .json backup of '
      + 'anything you want to keep (and ' + strong('File ▸ Import') + ' it back later).');

    p('Sharing images: a picture you add with ' + strong('File ▸ Import Image') + ' lives only '
      + 'in your browser and can’t travel in a link. Use a ' + strong('URL Image') + ' node '
      + 'instead and point it at a picture hosted somewhere public (GitHub, imgur, a CDN). The '
      + 'graph stays tiny and the image loads for everyone.');

    const box = h('div', 'background:#12161c;border:1px solid #262b33;border-radius:9px;padding:12px 14px;margin-bottom:6px');
    box.appendChild(h('div', 'color:#e6e8ea;font-weight:600;margin-bottom:6px',
      'Multiple graphs, version history, Video & AI'));
    const b2 = h('div', 'color:#8a929c;font-size:12.5px');
    b2.innerHTML = 'These need the free ' + strong('desktop version') + '. It stores projects '
      + 'as real folders (so one project can hold many graphs, each with saved versions you can '
      + 'restore) and runs ' + strong('ComfyUI') + ' (AI + depth) and ' + strong('ffmpeg') + ' '
      + '(video) on your own machine — a browser can’t do those. Here, each project holds a '
      + 'single graph and those nodes stay disabled. Grab Forge from the project’s README, run '
      + strong('start.bat') + ', and use the editor there. Everything else works fully right here — '
      + 'including the ' + strong('Cloud AI') + ' nodes (Depth, Generate), once you add your own ChatGPT or Gemini key under ⚙ Settings.';
    box.appendChild(b2); card.appendChild(box);

    const row = h('div', 'display:flex;justify-content:flex-end;margin-top:16px');
    const ok = h('button', BTN_PRIMARY + ';padding:8px 20px', 'Got it');
    ok.onclick = close; row.appendChild(ok); card.appendChild(row);
  });
}

// repopulate the topbar project dropdown, selecting `current`
async function refreshProjectSelect(current) {
  try {
    const { projects } = await window.ForgeStore.api.listProjects();
    const sel = $('projectSelect'); if (!sel) return;
    sel.innerHTML = '';
    for (const pn of projects) {
      const o = document.createElement('option'); o.value = o.textContent = pn;
      if (pn === current) o.selected = true; sel.appendChild(o);
    }
  } catch (e) {}
}

// Drop a graph into a brand-new project and switch to it, WITHOUT touching whatever
// the visitor already had open.
async function adoptGraph(graph, name) {
  const store = window.ForgeStore;
  try {
    await store.api.createProject(name);      // also makes it the current project
    await store.saveGraph(name, graph);
  } catch (e) { /* fall through and at least display it */ }
  RT.project = name;
  RT.graph.clear();
  try { RT.graph.configure(graph); } catch (e) { console.error('graph configure failed', e); }
  await RT.refreshGallery();
  RT.redraw();
  await refreshProjectSelect(name);
  return name;
}

// ── forking a shared link into a fresh workspace ─────────────────────────────
async function maybeFork() {
  const hash = readHash();
  if (!hash.g) return;
  let graph;
  try { graph = await decodeGraph(hash.g); }
  catch (e) { toast('That share link is broken', 'bad'); return; }

  const name = await adoptGraph(graph, 'Shared ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  // drop the hash so a reload doesn't fork again
  history.replaceState(null, '', location.pathname + location.search);
  toast('Opened a shared graph — tinker away; it’s saved as “' + name + '”', 'good');
}

// ── wire up ──────────────────────────────────────────────────────────────────
async function init() {
  const ok = await waitFor(() => $('topbar') && RT.graph && window.ForgeStore && $('projectSelect'));
  if (!ok) { console.warn('webeditor: editor not ready'); return; }

  const bar = $('topbar');
  const anchor = $('settingsBtn') || null;
  const b = document.createElement('button');
  b.className = 'btn'; b.textContent = '?'; b.title = 'Help'; b.onclick = openHelp;
  bar.insertBefore(b, anchor);

  await maybeFork();

  if (!localStorage.getItem('forge.web.helpSeen')) {
    localStorage.setItem('forge.web.helpSeen', '1');
    openHelp();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
