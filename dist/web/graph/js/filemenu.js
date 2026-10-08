// filemenu.js — the File menu: documents, versions, bundles, projects, sharing.
//
// The model, which is the ordinary desktop-app one:
//
//   project   a workspace. Owns the image gallery.
//   graph     a document inside it. Save As makes another one, in the same
//             project, so Source/Import nodes keep resolving against that gallery.
//   version   a snapshot of a document, written by explicit saves only.
//
// The 500ms autosave still runs underneath (nothing is ever lost if the tab
// dies), but it writes the document *without* snapshotting; Ctrl+S is what puts
// a point in the history worth coming back to. That is why Save stays useful
// even though the editor saves continuously.
//
// Backends: the desktop server implements the document API. The static web build
// serves the same editor from IndexedDB via ForgeStore, which only knows about
// one graph per project — so `caps` is probed once at boot and the menu hides
// what the backend can't do rather than offering menu items that fail.
import { RT } from './runtime.js';
import { buildPlayLink, inspectShareability } from './share.js';
import {
  BTN, BTN_DANGER, BTN_PRIMARY, askChoice, askConfirm, askList, askText, downloadJSON,
  dropdown, h, modal, pickJSONFile, title, toast,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const FILE_EXT = '.forge.json';
const safeFile = (s) => String(s || 'graph').replace(/[^A-Za-z0-9._-]+/g, '_');

// ── backend capability probe ─────────────────────────────────────────────────
// GET /api/graphs answers with a document list on the desktop server. The static
// build's fetch shim has no such route, so anything but a well-formed answer
// means "this backend has no documents".
export const caps = { documents: false, bundles: false, store: null };

async function probe() {
  caps.store = window.ForgeStore || null;
  try {
    const r = await fetch('/api/graphs');
    if (r.ok) {
      const d = await r.json();
      if (d && Array.isArray(d.graphs)) { caps.documents = true; caps.bundles = true; }
    }
  } catch (e) { /* static build */ }
}

// ── small fetch helpers ──────────────────────────────────────────────────────
async function jget(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function jpost(path, body) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}
const q = (o) => Object.entries(o)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

// ── document state ───────────────────────────────────────────────────────────
export const doc = {
  name: 'Untitled',
  dirty: false,
  // Bumped on every graph mutation. Save compares against `savedAt` so the dirty
  // dot reflects real edits rather than the autosave timer firing.
  rev: 0,
  savedRev: 0,
};

function markClean() { doc.savedRev = doc.rev; doc.dirty = false; updateTitle(); }
export function markDirty() {
  doc.rev++;
  if (!doc.dirty) { doc.dirty = true; updateTitle(); }
}

export function updateTitle() {
  const el = $('docName');
  if (el) {
    el.textContent = doc.name + (doc.dirty ? ' •' : '');
    el.title = doc.dirty ? 'Unsaved changes — Ctrl+S to save a version' : 'Saved';
    el.style.color = doc.dirty ? '#e6e8ea' : '#8a929c';
  }
  document.title = 'Forge — ' + doc.name + (doc.dirty ? ' •' : '');
}

// ── open / save ──────────────────────────────────────────────────────────────
async function loadInto(graph) {
  RT.graph.clear();
  if (graph && graph.nodes && graph.nodes.length) {
    try { RT.graph.configure(graph); }
    catch (e) { console.error('graph configure failed', e); toast('That graph failed to load', 'bad'); }
  }
  RT.redraw();
  markClean();
}

export async function openDocument(name) {
  const r = await jpost('/api/graphs/select', { project: RT.project, name });
  doc.name = r.name;
  await loadInto(r.graph);
  toast('Opened “' + r.name + '”', 'good');
}

// Explicit save: writes the document AND appends a version.
export async function save() {
  if (!caps.documents) {
    // static build — one graph per project, no history to append to
    await window.ForgeStore.saveGraph(RT.project, RT.graph.serialize());
    markClean();
    toast('Saved', 'good');
    return;
  }
  try {
    await jpost('/api/graph', {
      project: RT.project, name: doc.name,
      graph: RT.graph.serialize(), snapshot: true,
    });
    markClean();
    toast('Saved “' + doc.name + '” — version added', 'good');
  } catch (e) { toast('Save failed: ' + e.message, 'bad'); }
}

export async function saveAs() {
  if (!caps.documents) return toast('Save As needs the desktop app', 'bad');
  const name = await askText({
    title: 'Save As',
    sub: 'Saves a copy as a new graph in this project, so it still uses the same image gallery.',
    value: doc.name, ok: 'Save',
  });
  if (!name) return;
  try {
    const r = await jpost('/api/graphs/saveas', {
      project: RT.project, name, graph: RT.graph.serialize(),
    });
    doc.name = r.name;
    markClean();
    toast('Saved as “' + r.name + '”', 'good');
  } catch (e) { toast('Save As failed: ' + e.message, 'bad'); }
}

async function newGraph() {
  if (doc.dirty && !await askConfirm({
    title: 'Start a new graph?',
    sub: 'The current graph has unsaved changes. They stay in its autosave, but no version is recorded.',
    ok: 'New graph',
  })) return;
  const name = await askText({ title: 'New graph', value: 'Untitled', ok: 'Create' });
  if (!name) return;
  try {
    const r = await jpost('/api/graphs/saveas', {
      project: RT.project, name, graph: { nodes: [], links: [] },
    });
    doc.name = r.name;
    await loadInto({});
    toast('New graph “' + r.name + '”', 'good');
  } catch (e) { toast('Could not create: ' + e.message, 'bad'); }
}

async function openGraph() {
  let data;
  try { data = await jget('/api/graphs?' + q({ project: RT.project })); }
  catch (e) { return toast('Could not list graphs: ' + e.message, 'bad'); }

  const rows = data.graphs.map((g) => ({
    id: g.name,
    label: g.name,
    current: g.name === data.current,
    meta: new Date(g.mtime * 1000).toLocaleString()
      + (g.versions ? '  ·  ' + g.versions + ' version' + (g.versions === 1 ? '' : 's') : ''),
    actions: [
      {
        label: 'Rename',
        fn: async (row, close) => {
          close();
          const nn = await askText({ title: 'Rename graph', value: row.id, ok: 'Rename' });
          if (!nn) return openGraph();
          try {
            const r = await jpost('/api/graphs/rename',
              { project: RT.project, name: row.id, new_name: nn });
            if (row.id === doc.name) { doc.name = r.name; updateTitle(); }
            toast('Renamed to “' + r.name + '”', 'good');
          } catch (e) { toast('Rename failed: ' + e.message, 'bad'); }
          openGraph();
        },
      },
      {
        label: 'Delete', css: BTN_DANGER,
        fn: async (row, close) => {
          close();
          if (await askConfirm({
            title: 'Delete “' + row.id + '”?',
            sub: 'The graph and all its saved versions are removed. This cannot be undone.',
            ok: 'Delete', danger: true,
          })) {
            try {
              const r = await jpost('/api/graphs/delete', { project: RT.project, name: row.id });
              toast('Deleted “' + row.id + '”', 'good');
              if (row.id === doc.name) await openDocument(r.current);
            } catch (e) { toast('Delete failed: ' + e.message, 'bad'); }
          }
          openGraph();
        },
      },
    ],
  }));

  const pick = await askList({
    title: 'Open graph',
    sub: 'Graphs in project “' + RT.project + '”.',
    rows, empty: 'No graphs in this project yet.',
  });
  if (pick && pick !== doc.name) {
    try { await openDocument(pick); }
    catch (e) { toast('Open failed: ' + e.message, 'bad'); }
  }
}

// ── gallery files ────────────────────────────────────────────────────────────
// Images arrive with machine-made names (MyProj__Color Grade_3.png), which is fine
// until you have forty of them and have to pick one out of a Source node's dropdown.
// Renaming here also rewrites the open graph's references, so a Source or Import node
// pointing at the old name doesn't quietly go blank.
function retargetImageRefs(oldName, newName) {
  let touched = 0;
  for (const n of (RT.graph && RT.graph._nodes) || []) {
    const p = n.properties || {};
    for (const k of ['file', 'output']) {
      if (p[k] === oldName) {
        p[k] = newName;
        const w = (n.widgets || []).find((x) => x.name === 'image');
        if (w) { if (w.options) w.options.values = RT.gallery.map((i) => i.filename); w.value = newName; }
        touched++;
      }
    }
  }
  if (touched) { RT.requestSave(); RT.redraw(); }
  return touched;
}

async function manageFiles() {
  await RT.refreshGallery();
  const rows = (RT.gallery || []).map((img) => ({
    id: img.filename,
    label: img.filename,
    meta: (img.kind || 'import') + '  ·  ' + Math.round((img.size || 0) / 1024) + ' KB',
    actions: [
      {
        label: 'Rename',
        fn: async (row, close) => {
          close();
          const nn = await askText({
            title: 'Rename image',
            sub: 'Nodes in this graph that use it are updated to match. Leave the extension off to keep the current one.',
            value: row.id, ok: 'Rename',
          });
          if (!nn || nn === row.id) return manageFiles();
          try {
            const r = await jpost('/api/image/rename',
              { project: RT.project, file: row.id, new_name: nn });
            await RT.refreshGallery();
            const n = retargetImageRefs(row.id, r.filename);
            toast('Renamed to “' + r.filename + '”'
              + (n ? ' · updated ' + n + ' node' + (n === 1 ? '' : 's') : ''), 'good');
          } catch (e) { toast('Rename failed: ' + e.message, 'bad'); }
          manageFiles();
        },
      },
      {
        label: 'Delete', css: BTN_DANGER,
        fn: async (row, close) => {
          close();
          if (await askConfirm({
            title: 'Delete “' + row.id + '”?',
            sub: 'The file and its sidecar are removed from this project. Nodes using it will show a load error.',
            ok: 'Delete', danger: true,
          })) {
            try {
              await jpost('/api/image/delete', { project: RT.project, file: row.id });
              await RT.refreshGallery();
              toast('Deleted “' + row.id + '”', 'good');
            } catch (e) { toast('Delete failed: ' + e.message, 'bad'); }
          }
          manageFiles();
        },
      },
    ],
  }));

  await askList({
    title: 'Images',
    sub: 'The gallery for project “' + RT.project + '”. Source and Import nodes pick from this list.',
    rows,
    empty: 'No images yet — File ▸ Import Image…',
    buttons: [{ label: 'Import Image…', primary: true, fn: (close) => { close(); const el = $('importInput'); if (el) el.click(); } }],
  });
}

// ── version history ──────────────────────────────────────────────────────────
async function versionHistory() {
  let data;
  try { data = await jget('/api/graph/versions?' + q({ project: RT.project, name: doc.name })); }
  catch (e) { return toast('Could not load history: ' + e.message, 'bad'); }

  const rows = data.versions.map((v) => ({
    id: v.id,
    label: new Date(v.saved).toLocaleString() + (v.label ? '  —  ' + v.label : ''),
    meta: v.nodes + ' node' + (v.nodes === 1 ? '' : 's'),
  }));

  const pick = await askList({
    title: 'Version history',
    sub: 'Saved versions of “' + doc.name + '”. Restoring first snapshots what you have now, '
      + 'so nothing is lost either way.',
    rows,
    empty: 'No versions yet — press Ctrl+S to record one.',
  });
  if (!pick) return;
  if (!await askConfirm({
    title: 'Restore this version?',
    sub: 'Your current graph is snapshotted first, so you can step back to it from this same list.',
    ok: 'Restore',
  })) return;
  try {
    const r = await jpost('/api/graph/version/restore',
      { project: RT.project, name: doc.name, id: pick });
    await loadInto(r.graph);
    toast('Restored', 'good');
  } catch (e) { toast('Restore failed: ' + e.message, 'bad'); }
}

// ── bundles ──────────────────────────────────────────────────────────────────
async function exportGraphFile() {
  try {
    let payload;
    if (caps.documents) {
      await jpost('/api/graph', { project: RT.project, name: doc.name, graph: RT.graph.serialize() });
      payload = await jget('/api/export/graph?' + q({ project: RT.project, name: doc.name }));
    } else {
      await window.ForgeStore.saveGraph(RT.project, RT.graph.serialize());
      payload = await window.ForgeStore.exportGraph(RT.project);
    }
    downloadJSON(payload, safeFile(caps.documents ? doc.name : RT.project) + FILE_EXT);
    toast('Exported', 'good');
  } catch (e) { toast('Export failed: ' + e.message, 'bad'); }
}

async function exportProjectFile() {
  if (!caps.bundles) return exportGraphFile();
  try {
    await jpost('/api/graph', { project: RT.project, name: doc.name, graph: RT.graph.serialize() });
    const payload = await jget('/api/export/project?' + q({ project: RT.project }));
    downloadJSON(payload, safeFile(RT.project) + '.project' + FILE_EXT);
    toast('Exported project “' + RT.project + '”', 'good');
  } catch (e) { toast('Export failed: ' + e.message, 'bad'); }
}

// Import always lands in a NEW project, so it can never overwrite open work.
async function importFile() {
  const payload = await pickJSONFile();
  if (!payload) return;
  if (payload.__error) return toast(payload.__error, 'bad');
  if (!payload.graph && !payload.graphs) return toast('Not a Forge file', 'bad');
  try {
    let project;
    if (caps.bundles) {
      const r = await jpost('/api/import/bundle', { payload });
      project = r.project;
      toast(`Imported into “${project}” — ${r.graphs} graph(s), ${r.images} image(s)`, 'good');
    } else {
      project = await window.ForgeStore.importGraph(payload);
      toast('Imported “' + project + '”', 'good');
    }
    if (RT.onProjectImported) await RT.onProjectImported(project);
  } catch (e) { toast('Import failed: ' + e.message, 'bad'); }
}

// ── switching projects ───────────────────────────────────────────────────────
// Switching swaps in the target project's own graph, so the one on screen
// disappears. It is not lost — it stays saved in the project it belongs to —
// but that is not obvious from a dropdown that changes the canvas underneath
// you, so say what will happen and offer to bring the graph along.

// Gallery images referenced by a graph belong to the project that holds them,
// so a carried graph would point at files the target project doesn't have.
function referencedImages(graph) {
  const out = new Set();
  for (const n of (graph && graph.nodes) || []) {
    const p = n.properties || {};
    for (const k of ['file', 'output']) {
      if (typeof p[k] === 'string' && /\.(png|jpe?g|webp|bmp)$/i.test(p[k])) out.add(p[k]);
    }
  }
  return [...out];
}

export async function confirmProjectSwitch(from, to) {
  const graph = RT.graph.serialize();
  const imgs = referencedImages(graph);
  const choices = [];

  if (doc.dirty) {
    choices.push({
      key: 'save', primary: true, label: 'Save, then switch',
      hint: 'Records a version of “' + doc.name + '” in ' + from + ' first.',
    });
  }
  choices.push({
    key: 'switch', primary: !doc.dirty, label: 'Switch',
    hint: doc.dirty
      ? 'Recent edits are kept by autosave in “' + doc.name + '”, but no version is recorded.'
      : '“' + doc.name + '” stays saved in ' + from + '; you can come back to it any time.',
  });
  if (caps.documents) {
    choices.push({
      key: 'copy', label: 'Take this graph along',
      hint: 'Copies “' + doc.name + '” into ' + to + ' as a new graph, and opens it there.',
    });
  }

  return askChoice({
    title: 'Switch to “' + to + '”?',
    sub: to + ' has its own graphs and its own image gallery, so the canvas will change.',
    warnings: imgs.length
      ? ['This graph uses ' + imgs.length + ' gallery image'
        + (imgs.length === 1 ? '' : 's') + ' from ' + from
        + '. Copying it to ' + to + ' will not bring '
        + (imgs.length === 1 ? 'it' : 'them') + ' along — export the project instead '
        + 'if you need the images too.']
      : [],
    choices,
  });
}

// Drop the carried graph into the project that is now open.
export async function carryGraphInto(project, graph, name) {
  try {
    const r = await jpost('/api/graphs/saveas', { project, name, graph });
    doc.name = r.name;
    await loadInto(graph);
    toast('Copied “' + r.name + '” into ' + project, 'good');
  } catch (e) { toast('Could not copy the graph: ' + e.message, 'bad'); }
}

// ── share ────────────────────────────────────────────────────────────────────
export function openShare() {
  const graph = RT.graph.serialize();
  const report = inspectShareability(graph);

  modal((card, close) => {
    title(card, 'Share this front-end',
      'Anyone with the link opens your authored UI — no install, no account. '
      + 'The whole graph rides in the link itself.');

    for (const w of report.warnings) {
      card.appendChild(h('div', 'background:#2a1d1d;border:1px solid #5c2a2a;color:#ffb0b0;'
        + 'border-radius:8px;padding:9px 11px;margin-bottom:10px;font-size:12px', '⚠ ' + w));
    }

    const editRow = h('label', 'display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer');
    const editChk = h('input'); editChk.type = 'checkbox'; editChk.checked = true;
    editRow.append(editChk, h('span', 'color:#e6e8ea',
      'Show an “Edit” button so viewers can open it in the editor'));
    card.appendChild(editRow);

    const field = h('input', 'width:100%;background:#0d0f12;color:#e6e8ea;border:1px solid #262b33;'
      + 'border-radius:6px;padding:9px 10px;font:12px ui-monospace,monospace;margin-bottom:10px');
    field.readOnly = true; field.value = 'building link…';
    card.appendChild(field);

    const row = h('div', 'display:flex;gap:8px;justify-content:flex-end');
    const copyBtn = h('button', BTN_PRIMARY, 'Copy link');
    const openBtn = h('button', BTN, 'Open ↗');
    const doneBtn = h('button', BTN, 'Close');
    row.append(copyBtn, openBtn, doneBtn);
    card.appendChild(row);

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

// ── the menu ─────────────────────────────────────────────────────────────────
function items() {
  const D = caps.documents;
  return [
    { label: 'New Graph', hint: 'Ctrl+N', fn: newGraph, disabled: !D },
    { label: 'Open Graph…', hint: 'Ctrl+O', fn: openGraph, disabled: !D },
    '-',
    { label: 'Save', hint: 'Ctrl+S', fn: save },
    { label: 'Save As…', hint: 'Ctrl+Shift+S', fn: saveAs, disabled: !D },
    { label: 'Version History…', fn: versionHistory, disabled: !D },
    '-',
    { label: 'Import Graph or Project…', fn: importFile },
    { label: 'Export Graph…', hint: FILE_EXT, fn: exportGraphFile },
    { label: 'Export Project…', hint: 'with images', fn: exportProjectFile },
    '-',
    { label: 'New Project…', fn: () => RT.newProject && RT.newProject() },
    { label: 'Import Image…', fn: () => $('importInput') && $('importInput').click() },
    { label: 'Images… (rename / delete)', fn: manageFiles, disabled: !D },
    '-',
    { label: 'Share link…', fn: openShare },
    {
      label: 'Open authored view ↗',
      // relative on purpose: index.html and play.html are siblings in a static
      // export, and the desktop server now serves /play.html to match
      fn: () => window.open('play.html?project=' + encodeURIComponent(RT.project), '_blank'),
    },
  ];
}

// ── wire up ──────────────────────────────────────────────────────────────────
// Settles once doc.name names the document the project opened on. Anything that
// switches project during boot (webeditor.js forking a share link) waits for it, or
// this would overwrite its doc.name with the previous project's document.
let menuReady;
export const fileMenuReady = new Promise((r) => { menuReady = r; });

export async function initFileMenu() {
  await probe();

  const btn = $('fileMenuBtn');
  if (btn) btn.onclick = () => dropdown(btn, items());

  if (caps.documents) {
    try {
      const data = await jget('/api/graphs?' + q({ project: RT.project }));
      doc.name = data.current || 'Untitled';
    } catch (e) { /* keep the default */ }
  }
  markClean();
  menuReady();

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); e.shiftKey ? saveAs() : save(); }
    else if (k === 'o' && caps.documents) { e.preventDefault(); openGraph(); }
    else if (k === 'n' && caps.documents) { e.preventDefault(); newGraph(); }
  });

  // A dirty document should cost a confirm before the tab closes.
  window.addEventListener('beforeunload', (e) => {
    if (!doc.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
