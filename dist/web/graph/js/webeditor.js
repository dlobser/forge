// webeditor.js — web-only additions to the node editor. Injected by export_static.py
// ONLY into the editor web build, so the desktop app (which serves the same source
// files) never sees any of this. Three jobs:
//
//   1. a Share button — packs the current graph into a play.html link (see share.js)
//   2. Export / Import — save the project to a .forge.json file (graph + its images
//      inlined) and load one back; the durable backup a share link isn't
//   3. a Help popup — what works on the web vs. what needs the desktop app
//   4. forking — opening an index.html#g=… link drops that graph into a fresh
//      workspace so the visitor can tinker without a server
//
// It is a module, loaded after graphApp.js, so RT and window.ForgeStore already
// exist by the time it runs (it still waits for RT.graph to be built).
import { RT } from './runtime.js';
import { buildPlayLink, inspectShareability } from './share.js';
import { decodeGraph, readHash } from './share.js';

const $ = (id) => document.getElementById(id);

function toast(msg, kind) {
  const box = $('toast'); if (!box) return;
  const el = document.createElement('div');
  el.className = 't' + (kind ? ' ' + kind : ''); el.textContent = msg;
  box.appendChild(el); setTimeout(() => el.remove(), 3500);
}

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

// ── a small modal ──────────────────────────────────────────────────────────────
function modal(build) {
  const back = document.createElement('div');
  back.style.cssText = 'position:fixed;inset:0;z-index:200;background:#000c;display:flex;'
    + 'align-items:center;justify-content:center;padding:20px;';
  const card = document.createElement('div');
  card.style.cssText = 'background:#15181d;border:1px solid #262b33;border-radius:12px;'
    + 'padding:22px 24px;max-width:520px;width:100%;line-height:1.6;color:#e6e8ea;'
    + 'font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 12px 40px #000a;'
    + 'max-height:88vh;overflow:auto;';
  const close = () => back.remove();
  back.onclick = (e) => { if (e.target === back) close(); };
  build(card, close);
  back.appendChild(card); document.body.appendChild(back);
  return close;
}

function h(tag, css, text) {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (text != null) el.textContent = text;
  return el;
}

// ── Share ────────────────────────────────────────────────────────────────────
function openShare() {
  const graph = RT.graph.serialize();
  const report = inspectShareability(graph);

  modal((card, close) => {
    card.appendChild(h('div', 'font-size:17px;margin-bottom:4px', 'Share this front-end'));
    card.appendChild(h('div', 'color:#8a929c;margin-bottom:14px',
      'Anyone with the link opens your authored UI — no install, no account. '
      + 'The whole graph rides in the link itself.'));

    for (const w of report.warnings) {
      const box = h('div', 'background:#2a1d1d;border:1px solid #5c2a2a;color:#ffb0b0;'
        + 'border-radius:8px;padding:9px 11px;margin-bottom:10px;font-size:12px', '⚠ ' + w);
      card.appendChild(box);
    }

    const editRow = h('label', 'display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer');
    const editChk = h('input'); editChk.type = 'checkbox'; editChk.checked = true;
    editRow.appendChild(editChk);
    editRow.appendChild(h('span', 'color:#e6e8ea', 'Show an “Edit” button so viewers can open it in the editor'));
    card.appendChild(editRow);

    const field = h('input', 'width:100%;background:#0d0f12;color:#e6e8ea;border:1px solid #262b33;'
      + 'border-radius:6px;padding:9px 10px;font:12px ui-monospace,monospace;margin-bottom:10px');
    field.readOnly = true; field.value = 'building link…';
    card.appendChild(field);

    const row = h('div', 'display:flex;gap:8px;justify-content:flex-end');
    const copyBtn = h('button', 'background:#5b8cff;color:#fff;border:none;border-radius:7px;'
      + 'padding:8px 16px;cursor:pointer;font-size:13px', 'Copy link');
    const openBtn = h('button', 'background:#1c2028;color:#e6e8ea;border:1px solid #262b33;'
      + 'border-radius:7px;padding:8px 16px;cursor:pointer;font-size:13px', 'Open ↗');
    const doneBtn = h('button', 'background:#1c2028;color:#8a929c;border:1px solid #262b33;'
      + 'border-radius:7px;padding:8px 16px;cursor:pointer;font-size:13px', 'Close');
    row.append(copyBtn, openBtn, doneBtn); card.appendChild(row);

    const lenNote = h('div', 'color:#8a929c;font-size:11px;margin-top:8px;text-align:right', '');
    card.appendChild(lenNote);

    let link = '';
    async function rebuild() {
      link = await buildPlayLink(graph, { allowEdit: editChk.checked });
      field.value = link;
      const n = link.length;
      lenNote.textContent = n + ' characters'
        + (n > 8000 ? ' — long; some chat apps may truncate it' : '');
      lenNote.style.color = n > 8000 ? '#ffb0b0' : '#8a929c';
    }
    editChk.onchange = rebuild;
    rebuild();

    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied', 'good'); }
      catch (e) { field.select(); document.execCommand && document.execCommand('copy'); toast('Link copied', 'good'); }
    };
    openBtn.onclick = () => window.open(link, '_blank');
    doneBtn.onclick = close;
  });
}

// ── Help ─────────────────────────────────────────────────────────────────────
function openHelp() {
  modal((card, close) => {
    card.appendChild(h('div', 'font-size:17px;margin-bottom:10px', 'Welcome to Forge'));

    const p = (html) => { const d = h('div', 'color:#c9ced6;margin-bottom:12px'); d.innerHTML = html; card.appendChild(d); };
    const strong = (s) => '<b style="color:#e6e8ea">' + s + '</b>';

    p('Wire ' + strong('shader') + ' and ' + strong('math') + ' nodes into a live image, '
      + 'then hit ' + strong('Author UI') + ' to expose just the sliders and previews you '
      + 'want — that becomes the front-end people see.');

    p('Your work is saved ' + strong('in this browser only') + '. Nothing uploads. '
      + 'Use ' + strong('Share') + ' to hand someone a link — the entire graph travels '
      + 'inside the URL, so it opens instantly with no server. Clearing your browser '
      + 'data erases everything, so ' + strong('Export') + ' a .json backup of anything '
      + 'you want to keep (and ' + strong('Import') + ' it back later).');

    p('Sharing images: a picture you ' + strong('Import') + ' lives only in your browser and '
      + 'can’t travel in a link. Use a ' + strong('URL Image') + ' node instead and point it at '
      + 'a picture hosted somewhere public (GitHub, imgur, a CDN). The graph stays tiny and the '
      + 'image loads for everyone.');

    const box = h('div', 'background:#12161c;border:1px solid #262b33;border-radius:9px;padding:12px 14px;margin-bottom:6px');
    box.appendChild(h('div', 'color:#e6e8ea;font-weight:600;margin-bottom:6px', 'Video, AI & Depth nodes'));
    const b2 = h('div', 'color:#8a929c;font-size:12.5px');
    b2.innerHTML = 'These need the free ' + strong('desktop version') + ', which runs '
      + strong('ComfyUI') + ' (for AI + depth) and ' + strong('ffmpeg') + ' (for video) on your '
      + 'own machine — a browser can’t do those. On the web they stay disabled. Grab Forge from '
      + 'the project’s README, run ' + strong('start.bat') + ', and use the editor there to '
      + 'generate images or export video. Everything else works fully right here.';
    box.appendChild(b2); card.appendChild(box);

    const row = h('div', 'display:flex;justify-content:flex-end;margin-top:16px');
    const ok = h('button', 'background:#5b8cff;color:#fff;border:none;border-radius:7px;'
      + 'padding:8px 20px;cursor:pointer;font-size:13px', 'Got it');
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
// the visitor already had open. Shared by the fork-on-open and file-import paths.
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

// ── Export / Import a .forge.json file ───────────────────────────────────────
// Unlike a share link (graph only, images via URL), this is a full self-contained
// backup: ForgeStore.exportGraph inlines every image the project uses. That makes
// it the right thing for "save my work" and for moving a project that relies on
// browser-imported pictures, which can't ride in a URL.
async function exportProject() {
  try {
    // persist any un-flushed edits first, then bundle
    document.getElementById('saveGraphBtn') && document.getElementById('saveGraphBtn').click();
    await new Promise((r) => setTimeout(r, 250));
    const project = RT.project;
    const payload = await window.ForgeStore.exportGraph(project);
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = project.replace(/[^A-Za-z0-9._-]+/g, '_') + '.forge.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Exported “' + project + '”', 'good');
  } catch (e) { toast('Export failed: ' + e.message, 'bad'); }
}

function importProject() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      if (!payload || !payload.graph) throw new Error('not a Forge .json file');
      // importGraph writes it (with images) into a fresh, uniquely-named project;
      // adopt that graph into the live editor so the canvas updates immediately.
      const name = await window.ForgeStore.importGraph(payload);
      RT.project = name;
      RT.graph.clear();
      try { RT.graph.configure(payload.graph); } catch (e) {}
      await RT.refreshGallery();
      RT.redraw();
      await refreshProjectSelect(name);
      toast('Imported “' + name + '”', 'good');
    } catch (e) { toast('Import failed: ' + e.message, 'bad'); }
  };
  inp.click();
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
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = label; b.title = title; b.onclick = fn;
    bar.insertBefore(b, anchor); return b;
  };
  mk('Share', 'Get a link to this front-end', openShare);
  mk('Export', 'Save this project to a .forge.json file (graph + images)', exportProject);
  mk('Import', 'Load a .forge.json file into a new project', importProject);
  mk('?', 'Help', openHelp);

  await maybeFork();

  if (!localStorage.getItem('forge.web.helpSeen')) {
    localStorage.setItem('forge.web.helpSeen', '1');
    openHelp();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
