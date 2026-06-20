// app.js — bootstrap: top bar (project / import / settings), tab switching, the
// ComfyUI status poll, and routing the active tab's render. Each tab module owns
// its own panel; the display (WebGL canvas / image) is shared.
import { S } from './state.js';
import { api } from './api.js';
import { display } from './display.js';
import { el, toast } from './ui.js';
import { renderShaders } from './shaders.js';
import { renderAi } from './ai.js';
import { renderChain } from './chain.js';
import { renderGallery } from './gallery.js';

const $ = (id) => document.getElementById(id);
let activeTab = 'shaders';

function renderActive() {
  const list = $('listPanel'), gal = $('galleryPanel');
  if (activeTab === 'shaders') { display.showCanvas(); renderShaders(list); }
  else if (activeTab === 'ai') renderAi(list);
  else if (activeTab === 'chain') { display.showCanvas(); renderChain(list); }
  else if (activeTab === 'gallery') renderGallery(gal);
}

function showTab(name) {
  if (activeTab === 'chain' && name !== 'chain') display.stop();   // stop the live chain loop
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const isGallery = name === 'gallery';
  $('listPanel').hidden = isGallery;
  $('displayPanel').hidden = isGallery;
  $('galleryPanel').hidden = !isGallery;
  renderActive();
}

// ── top bar ────────────────────────────────────────────────────────────────
function fillProjects() {
  const sel = $('projectSelect');
  sel.innerHTML = '';
  for (const p of S.projects) sel.append(el('option', { value: p, selected: p === S.projectName }, p));
}

async function switchProject(name) {
  S.project = await api.selectProject(name);
  S.settings.current_project = name;
  await S.refreshGallery();
  display.clear();
  renderActive();
}

function wireTopbar() {
  $('projectSelect').onchange = (e) => switchProject(e.target.value).catch((err) => toast(err.message, 'bad'));
  $('newProjectBtn').onclick = async () => {
    const name = prompt('New project name:');
    if (!name) return;
    S.project = await api.createProject(name);
    S.settings.current_project = name;
    S.projects = (await api.listProjects()).projects;
    fillProjects(); await S.refreshGallery(); display.clear(); renderActive();
    toast('Project “' + name + '” created', 'good');
  };

  $('importBtn').onclick = () => $('importInput').click();
  $('importInput').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const reformat = $('reformatChk').checked;
    const size = +$('reformatSize').value;
    toast(`Importing ${files.length} image(s)…`);
    try {
      for (const f of files) await api.importImage(S.projectName, f, reformat, size);
      await S.refreshGallery(); S.touch();
      if (activeTab === 'gallery') renderActive();
      toast('Imported', 'good');
    } catch (err) { toast('Import failed: ' + err.message, 'bad'); }
  };

  $('settingsBtn').onclick = openSettings;
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
}

// ── settings ───────────────────────────────────────────────────────────────
function openSettings() {
  const body = $('settingsBody'); body.innerHTML = '';
  const s = S.settings;
  const field = (label, input) => el('div', { class: 'field' }, el('label', {}, label), input);
  const host = el('input', { type: 'text', value: s.comfy.host });
  const port = el('input', { type: 'number', value: s.comfy.port });
  const wfdir = el('input', { type: 'text', value: s.paths.workflows_dir });
  const depthRes = el('input', { type: 'number', value: s.depth.resolution });
  const fps = el('input', { type: 'number', value: s.video.fps });
  const cmd = el('textarea', { rows: 3 }, s.video.command);
  body.append(
    field('ComfyUI host', host), field('ComfyUI port', port),
    field('Workflows directory (restart to re-scan path)', wfdir),
    field('Depth resolution', depthRes),
    field('Video fps', fps),
    field('ffmpeg command  ·  {fps} {start} {frames_in} {out}', cmd),
    el('div', { class: 'row end' },
      el('button', { class: 'btn primary', onclick: async () => {
        await api.saveSettings({
          comfy: { host: host.value, port: +port.value },
          paths: { ...s.paths, workflows_dir: wfdir.value },
          depth: { ...s.depth, resolution: +depthRes.value },
          video: { fps: +fps.value, command: cmd.value },
        });
        S.settings = await api.getSettings();
        await Promise.all([S.refreshWorkflows(), S.refreshComfy()]);
        $('settingsModal').hidden = true;
        renderActive(); updateComfyDot();
        toast('Settings saved', 'good');
      } }, 'Save')));
  $('settingsModal').hidden = false;
}

function wireModals() {
  document.querySelectorAll('.modal .modal-close').forEach((b) => {
    b.onclick = () => (b.closest('.modal').hidden = true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
  });
}

// ── comfy status ───────────────────────────────────────────────────────────
function updateComfyDot() {
  const node = $('comfyStatus');
  node.classList.toggle('ok', !!S.comfy.ok);
  node.querySelector('.label').textContent = S.comfy.ok
    ? (S.comfy.depth ? 'comfy ✓' : 'comfy (no depth)') : 'comfy ✗';
}

async function pollComfy() {
  await S.refreshComfy();
  updateComfyDot();
}

// ── boot ───────────────────────────────────────────────────────────────────
(async function boot() {
  S.onChange = renderActive;
  wireTopbar(); wireModals();
  try {
    await S.init();
  } catch (e) {
    toast('Startup error: ' + e.message, 'bad');
    console.error(e);
    return;
  }
  fillProjects();
  updateComfyDot();
  showTab('shaders');
  // comfy is checked once on boot (S.refreshComfy in init); no constant polling —
  // Generate/Depth surface a clear error if ComfyUI isn't reachable.

  let rs;
  window.addEventListener('resize', () => {
    clearTimeout(rs);
    rs = setTimeout(() => { if (activeTab === 'shaders' && display.effect && !display.playing) display.renderStatic(); }, 150);
  });
})();
