// chain.js — the Chain tab. An ordered list of steps; each step references one
// of your existing shader/AI effect instances (or a freshly created one). The
// SHADER steps run live on the GPU, chained output→input, so the whole pipeline
// animates at full fps in the display with zero disk writes — and you can select
// any step, edit its parameters inline, and watch the result update. AI steps
// can't run per frame, so in the live view they contribute their last generated
// still (Run chain bakes them to disk). Per step you choose which input receives
// the previous step's output ("flow") and pin the other inputs to fixed images.
import { S } from './state.js';
import { api } from './api.js';
import { display } from './display.js';
import { el, toast, openPicker, uid } from './ui.js';
import { control } from './shaders.js';
import { aiControl } from './ai.js';
import { loadImage } from './shaderEngine.js';

const schemaCache = new Map();
const imgEls = {};            // filename -> HTMLImageElement (live preload cache)
const expanded = new Set();
let selectedStepId = null;
let containerEl = null;

// ── effect lookup ─────────────────────────────────────────────────────────────
function allEffects() {
  return [
    ...S.project.shaderEffects.map((f) => ({ id: f.id, kind: 'shader', name: f.name, ref: f })),
    ...S.project.aiEffects.map((f) => ({ id: f.id, kind: 'ai', name: f.name, ref: f })),
  ];
}
const findEffect = (id) => allEffects().find((e) => e.id === id);
async function getSchema(key) {
  if (!schemaCache.has(key)) schemaCache.set(key, await api.workflowSchema(key));
  return schemaCache.get(key);
}

const previewMode = () => S.project.chainPreviewMode || 'final';
const outputSize = () => S.project.chainOutputSize || 1024;
// QLab-style mute/solo: a muted step is bypassed (its input flows to the next);
// if any step is soloed, every non-soloed step is treated as muted.
const anySolo = () => S.project.chain.some((s) => s.solo);
const isMuted = (step) => !!step.muted || (anySolo() && !step.solo);

// per-instance fixed input image (color/depth are first-class; extras live in .inputs)
function fixedInputFile(inst, name) {
  if (name === 'color') return inst.color;
  if (name === 'depth') return inst.depth;
  return inst.inputs ? inst.inputs[name] : null;
}
function setFixedInputFile(inst, name, file) {
  if (name === 'color') inst.color = file || null;
  else if (name === 'depth') inst.depth = file || null;
  else { inst.inputs = inst.inputs || {}; if (file) inst.inputs[name] = file; else delete inst.inputs[name]; }
}
function shaderInputs(def) {
  return (def?.def.inputs && def.def.inputs.length) ? def.def.inputs : ['color', 'depth'];
}
function inputLabel(def, name) {
  return (def?.def.inputLabels && def.def.inputLabels[name]) || (name[0].toUpperCase() + name.slice(1));
}

// ── live image preload (the rAF loop reads imgEls synchronously) ───────────────
async function preload() {
  const files = new Set();
  if (S.project.chainSource) files.add(S.project.chainSource);
  for (const step of S.project.chain) {
    const e = findEffect(step.ref); if (!e) continue;
    if (e.kind === 'ai') { if (e.ref.output) files.add(e.ref.output); continue; }
    for (const name of shaderInputs(S.shaderDef(e.ref.shader))) {
      const f = fixedInputFile(e.ref, name); if (f) files.add(f);
    }
  }
  await Promise.all([...files].map(async (f) => {
    if (imgEls[f] !== undefined) return;
    imgEls[f] = null;
    try { imgEls[f] = await loadImage(S.imageURL(f)); } catch { imgEls[f] = null; }
  }));
}
// force a fresh load (AI bake overwrites the same filename)
async function reloadImg(file) {
  try {
    const im = new Image(); im.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = S.imageURL(file) + '?v=' + Date.now(); });
    imgEls[file] = im;
  } catch { imgEls[file] = null; }
}

// ── build the chainSpec the engine renders ─────────────────────────────────────
function stepShaderSpec(step, e) {
  const def = S.shaderDef(e.ref.shader);
  if (!def) return null;
  const inputs = shaderInputs(def);
  const flow = (step.flow && inputs.includes(step.flow)) ? step.flow : inputs[0];
  const inputImages = {}; const fixed = [];
  for (const name of inputs) {
    if (name === flow) continue;
    const f = fixedInputFile(e.ref, name);
    inputImages[name] = f ? (imgEls[f] || null) : null;
    fixed.push(name + ':' + (f || ''));
  }
  const simSize = e.ref.simSize || def.def.simSize || 256;
  return {
    kind: 'shader', key: def.key, vertSrc: def.vertSrc, fragSrc: def.fragSrc,
    controls: def.def.controls || [], params: e.ref.params,
    feedback: !!def.def.feedback, simSize, simKey: step.id,
    inputs, flowInput: flow, inputImages,
    resetToken: `${step.id}|${simSize}|${flow}|${fixed.join('|')}`,
  };
}

function buildChainSpec(advance, uptoIdx) {
  const chain = S.project.chain;
  let upto = uptoIdx;
  if (upto === undefined) {
    if (previewMode() === 'upto' && selectedStepId) {
      const si = chain.findIndex((s) => s.id === selectedStepId);
      upto = si >= 0 ? si : chain.length - 1;
    } else upto = chain.length - 1;
  }
  const steps = [];
  for (let i = 0; i <= upto && i < chain.length; i++) {
    const step = chain[i];
    if (isMuted(step)) { steps.push({ bypass: true }); continue; }   // pass input straight through
    const e = findEffect(step.ref);
    if (!e) continue;
    if (e.kind === 'ai') steps.push({ kind: 'ai', cachedImg: e.ref.output ? (imgEls[e.ref.output] || null) : null });
    else { const s = stepShaderSpec(step, e); if (s) steps.push(s); }
  }
  // `advance` flows to every step so feedback sims step one frame per draw
  return { steps, advance, sourceImg: S.project.chainSource ? (imgEls[S.project.chainSource] || null) : null };
}

// ── render the tab ─────────────────────────────────────────────────────────────
export function renderChain(container) {
  containerEl = container;
  container.innerHTML = '';
  display.showCanvas();
  preload().then(() => { if (!display.playing) display.renderChainOnce(false); });
  display.setChain((adv) => buildChainSpec(adv));
  setupOverlay();

  // source image
  container.append(el('div', { class: 'io-slot' },
    el('div', { class: 'io-label' }, 'Source image'),
    el('div', { class: 'io-thumb', onclick: async () => {
      await S.refreshGallery();
      const choice = await openPicker(S.projectName, S.gallery, 'Chain source image');
      if (choice === null) return;
      S.project.chainSource = choice || null; S.save();
      await preload(); renderChain(container);
    } }, S.project.chainSource ? el('img', { src: S.thumbURL(S.project.chainSource) }) : 'choose source')));

  // preview mode toggle + output size
  const modeToggle = el('div', { class: 'seg' },
    segBtn('Final', previewMode() === 'final', () => setPreviewMode('final')),
    segBtn('Up to step', previewMode() === 'upto', () => setPreviewMode('upto')));
  const sizeSel = el('select', { onchange: (e) => { S.project.chainOutputSize = +e.target.value; S.save(); } },
    ...[256, 512, 1024, 2048].map((n) => el('option', { value: n, selected: n === outputSize() }, `${n}²`)));
  container.append(el('div', { class: 'crow', style: 'margin:8px 0' },
    el('label', {}, 'Preview'), modeToggle, el('span', { style: 'flex:1' }), el('label', {}, 'Out'), sizeSel));

  // add-bar
  const sel = el('select');
  const exg = el('optgroup', { label: 'Existing effect' });
  allEffects().forEach((e) => exg.append(el('option', { value: 'ex:' + e.id }, `${e.name} · ${e.kind}`)));
  if (exg.children.length) sel.append(exg);
  const nsg = el('optgroup', { label: 'New shader' });
  S.shaderDefs.forEach((d) => nsg.append(el('option', { value: 'ns:' + d.key }, d.def.name || d.key)));
  if (nsg.children.length) sel.append(nsg);
  const nag = el('optgroup', { label: 'New AI workflow' });
  S.workflows.forEach((w) => nag.append(el('option', { value: 'na:' + w.key }, w.name)));
  if (nag.children.length) sel.append(nag);
  container.append(el('div', { class: 'add-bar' }, sel,
    el('button', { class: 'btn primary', onclick: () => addStep(sel.value) }, '＋ Add step')));

  if (!S.project.chain.length)
    container.append(el('div', { class: 'muted tiny', style: 'padding:8px' },
      'Add steps in order. Shader steps animate live; each step’s output feeds the next.'));

  // steps
  S.project.chain.forEach((step, i) => {
    container.append(stepCard(step, i));
    if (i < S.project.chain.length - 1) container.append(el('div', { class: 'chain-arrow' }, '↓'));
  });

  // run / render row
  const prog = el('i'); const progWrap = el('div', { class: 'progress' }, prog);
  const runBtn = el('button', { class: 'btn go', title: 'Generate every AI step (writes their outputs to disk)', onclick: () => runChain(runBtn, prog) }, '▶ Run chain (bake AI)');
  const finalBtn = el('button', { class: 'btn primary', onclick: () => renderFinal(finalBtn) }, 'Render final → gallery');
  container.append(el('div', { class: 'row', style: 'margin-top:8px' }, runBtn, finalBtn), progWrap);
  container.append(seqBlock(prog));
}

function setupOverlay() {
  const ov = document.getElementById('displayOverlay');
  if (!ov) return;
  ov.innerHTML = '';
  ov.append(el('span', { class: 'pill' }, 'Chain'));
  const timePill = el('span', { class: 'pill' }, display.time.toFixed(2) + 's');
  display.onTime = (t) => (timePill.textContent = t.toFixed(2) + 's');
  const btn = el('button', { class: 'btn small', onclick: () => {
    if (display.playing) { display.pause(); btn.textContent = '▶'; }
    else { display.resume(); btn.textContent = '⏸'; }
  } }, display.playing ? '⏸' : '▶');
  ov.append(btn, timePill);
}

function segBtn(label, active, onclick) {
  return el('button', { class: 'segbtn' + (active ? ' active' : ''), onclick }, label);
}
function setPreviewMode(m) { S.project.chainPreviewMode = m; S.save(); renderChain(containerEl); }

function stepCard(step, i) {
  const e = findEffect(step.ref);
  const isOpen = expanded.has(step.id);
  const c = el('div', { class: 'card chain-card' + (isOpen ? ' open' : '') + (step.id === selectedStepId ? ' selected' : '') + (isMuted(step) ? ' muted' : '') });

  const head = el('div', { class: 'card-head', onclick: () => selectStep(step.id) },
    el('span', { class: 'idx' }, String(i + 1)),
    el('span', { class: 'chev' }, '▶'),
    el('span', { class: 'name', style: 'flex:1' }, e ? e.name : '⚠ missing effect'),
    el('span', { class: 'kind' }, e ? e.kind : '?'),
    el('button', { class: 'btn small mute' + (step.muted ? ' on' : ''), title: 'Mute (bypass this step)',
      onclick: (ev) => { ev.stopPropagation(); step.muted = !step.muted; S.save(); renderChain(containerEl); } }, 'M'),
    el('button', { class: 'btn small solo' + (step.solo ? ' on' : ''), title: 'Solo (mute all others)',
      onclick: (ev) => { ev.stopPropagation(); step.solo = !step.solo; S.save(); renderChain(containerEl); } }, 'S'),
    el('button', { class: 'btn small', title: 'Up', onclick: (ev) => { ev.stopPropagation(); move(i, -1); } }, '↑'),
    el('button', { class: 'btn small', title: 'Down', onclick: (ev) => { ev.stopPropagation(); move(i, 1); } }, '↓'),
    el('button', { class: 'btn small danger', title: 'Remove', onclick: (ev) => {
      ev.stopPropagation();
      S.project.chain.splice(i, 1); if (selectedStepId === step.id) selectedStepId = null;
      S.save(); renderChain(containerEl);
    } }, '✕'));
  head.querySelector('.chev').onclick = (ev) => {
    ev.stopPropagation();
    expanded.has(step.id) ? expanded.delete(step.id) : expanded.add(step.id);
    c.classList.toggle('open');
  };
  c.append(head);
  if (!e) return c;

  const body = el('div', { class: 'card-body' });
  const scroll = el('div', { class: 'param-scroll' });
  if (e.kind === 'shader') fillShaderBody(step, e, scroll);
  else fillAiBody(step, e, scroll);
  body.append(scroll);
  c.append(body);
  return c;
}

function fillShaderBody(step, e, scroll) {
  const def = S.shaderDef(e.ref.shader);
  if (!def) { scroll.append(el('div', { class: 'muted' }, `Shader "${e.ref.shader}" not found`)); return; }
  const inputs = shaderInputs(def);
  const flow = (step.flow && inputs.includes(step.flow)) ? step.flow : inputs[0];

  // input mapping: which input receives the previous step's output
  scroll.append(el('div', { class: 'section-title' }, 'Inputs'));
  const flowRow = el('div', { class: 'crow' }, el('label', {}, 'Flow into'),
    el('div', { class: 'seg' }, ...inputs.map((name) =>
      segBtn(inputLabel(def, name), name === flow, () => { step.flow = name; S.save(); renderChain(containerEl); }))));
  scroll.append(flowRow);
  // fixed-image pickers for the non-flow inputs
  for (const name of inputs) {
    if (name === flow) continue;
    const cur = fixedInputFile(e.ref, name);
    scroll.append(el('div', { class: 'io-slot' },
      el('div', { class: 'io-label' }, inputLabel(def, name) + ' (fixed image)'),
      el('div', { class: 'io-thumb', onclick: async () => {
        await S.refreshGallery();
        const choice = await openPicker(S.projectName, S.gallery, inputLabel(def, name));
        if (choice === null) return;
        setFixedInputFile(e.ref, name, choice); S.save();
        await preload(); renderChain(containerEl);
      } }, cur ? el('img', { src: S.thumbURL(cur) }) : 'choose')));
  }

  // parameters (reuse the Shaders-tab control builder; edits the referenced instance)
  if ((def.def.controls || []).length) {
    scroll.append(el('div', { class: 'section-title' }, 'Parameters'));
    for (const ctrl of def.def.controls) scroll.append(control(e.ref, ctrl));
  }
  if (def.def.feedback)
    scroll.append(el('div', { class: 'row end' },
      el('button', { class: 'btn small', onclick: () => { display.resetChainSim(); toast('Simulation reseeded'); } }, '↺ Reset sim')));
}

async function fillAiBody(step, e, scroll) {
  scroll.append(el('div', { class: 'muted tiny' }, 'loading…'));
  let schema; try { schema = await getSchema(e.ref.workflow); }
  catch (err) { scroll.innerHTML = ''; scroll.append(el('div', { class: 'muted' }, 'Schema error: ' + err.message)); return; }
  scroll.innerHTML = '';
  scroll.append(el('div', { class: 'tiny muted' }, 'AI steps don’t animate live — they use the last baked still. The input is taken from the chain output reaching this step.'));
  if (schema.imageSlots.length > 1) {
    scroll.append(el('div', { class: 'section-title' }, 'Extra input images'));
    for (const slot of schema.imageSlots.slice(1)) scroll.append(aiImageSlot(e.ref, slot));
  }
  const main = schema.params.filter((p) => p.source !== 'auto' || p.multiline);
  const auto = schema.params.filter((p) => p.source === 'auto' && !p.multiline);
  if (main.length) { scroll.append(el('div', { class: 'section-title' }, 'Parameters')); for (const p of main) scroll.append(aiControl(e.ref, p)); }
  if (auto.length) { const det = el('details', { class: 'advanced' }, el('summary', {}, `Advanced (${auto.length})`)); for (const p of auto) det.append(aiControl(e.ref, p)); scroll.append(det); }
  const out = el('div', { class: 'io-thumb', style: 'height:80px' }, e.ref.output ? el('img', { src: S.thumbURL(e.ref.output) }) : 'not baked');
  const bake = el('button', { class: 'btn', onclick: () => bakeAiStep(step, e, bake, out) }, 'Bake this step');
  scroll.append(el('div', { class: 'row end' }, bake), el('div', { class: 'io-slot' }, el('div', { class: 'io-label' }, 'Baked output'), out));
}

function aiImageSlot(inst, slot) {
  const cur = inst.images[slot.id];
  return el('div', { class: 'io-slot' }, el('div', { class: 'io-label' }, slot.label),
    el('div', { class: 'io-thumb', onclick: async () => {
      await S.refreshGallery();
      const choice = await openPicker(S.projectName, S.gallery, slot.label);
      if (choice === null) return;
      if (choice) inst.images[slot.id] = choice; else delete inst.images[slot.id];
      S.save(); renderChain(containerEl);
    } }, cur ? el('img', { src: S.thumbURL(cur) }) : 'choose'));
}

// ── selection / structure ──────────────────────────────────────────────────────
function selectStep(id) {
  selectedStepId = id;
  document.querySelectorAll('#listPanel .chain-card').forEach((c) => c.classList.remove('selected'));
  if (!display.playing) display.renderChainOnce(false);
  renderChain(containerEl);
}
function move(i, d) {
  const j = i + d; const a = S.project.chain;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]]; S.save(); renderChain(containerEl);
}
function addStep(val) {
  if (!val) return toast('Nothing to add', 'bad');
  let ref;
  if (val.startsWith('ex:')) ref = val.slice(3);
  else if (val.startsWith('ns:')) { const fx = S.newShaderEffect(val.slice(3)); if (!fx) return; S.project.shaderEffects.push(fx); ref = fx.id; }
  else if (val.startsWith('na:')) { const fx = S.newAiEffect(val.slice(3)); S.project.aiEffects.push(fx); ref = fx.id; }
  if (!ref) return;
  const step = { id: uid('st'), ref };
  S.project.chain.push(step); S.save();
  expanded.add(step.id); selectedStepId = step.id;
  preload().then(() => renderChain(containerEl));
  renderChain(containerEl);
}

// ── actions ─────────────────────────────────────────────────────────────────────
function seqBlock(globalProg) {
  const block = el('div', { style: 'border-top:1px solid var(--line);padding-top:8px;margin-top:8px;display:flex;flex-direction:column;gap:8px' });
  block.append(el('div', { class: 'section-title' }, 'Animation → video'));
  const fps = el('input', { type: 'number', min: 1, max: 60, value: S.project.chainFps || 24, style: 'width:60px',
    onchange: (e) => { S.project.chainFps = +e.target.value || 24; S.save(); } });
  const frames = el('input', { type: 'number', min: 1, max: 3600, value: S.project.chainFrames || 48, style: 'width:70px',
    onchange: (e) => { S.project.chainFrames = +e.target.value || 48; S.save(); } });
  const cmd = el('textarea', { readonly: true, rows: 3, class: 'tiny', placeholder: 'ffmpeg command appears after rendering a sequence' });
  const prog = el('i'); const progWrap = el('div', { class: 'progress' }, prog);
  const seqBtn = el('button', { class: 'btn', onclick: () => renderSequence(seqBtn, prog, cmd) }, 'Render sequence');
  const vidBtn = el('button', { class: 'btn go', onclick: () => makeVideo(vidBtn, cmd) }, 'Make video');
  block.append(el('div', { class: 'row' }, el('span', { class: 'tiny muted' }, 'fps'), fps, el('span', { class: 'tiny muted' }, 'frames'), frames),
    el('div', { class: 'row' }, seqBtn, vidBtn), progWrap, cmd);
  return block;
}

const CHAIN_NAME = 'chain';

async function renderFinal(btn) {
  if (!S.project.chain.length) return toast('Add at least one step', 'bad');
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Rendering…';
  try {
    // render the whole chain regardless of the preview-boundary toggle
    const blob = await display.captureChainSpec(buildChainSpec(false, S.project.chain.length - 1), outputSize());
    const out = await api.renderSave(S.projectName, CHAIN_NAME, blob, { chain: true, steps: S.project.chain.length });
    await S.refreshGallery(); S.touch();
    toast('Saved ' + out.filename, 'good');
  } catch (e) { toast('Render failed: ' + e.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = old; }
}

// Bake every AI step left→right: each is fed the chain output reaching it.
async function runChain(btn, prog) {
  if (!S.project.chain.length) return toast('Add steps first', 'bad');
  const aiSteps = S.project.chain.map((s, i) => ({ s, i, e: findEffect(s.ref) })).filter((x) => x.e && x.e.kind === 'ai' && !isMuted(x.s));
  if (!aiSteps.length) return toast('No AI steps to bake — the preview is already live', 'good');
  if (!S.comfy.ok) { await S.refreshComfy(); if (!S.comfy.ok) return toast('ComfyUI not reachable', 'bad'); }
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Baking…';
  try {
    for (let k = 0; k < aiSteps.length; k++) {
      const { e, i } = aiSteps[k];
      await bakeAt(i, e);
      prog.style.width = Math.round(((k + 1) / aiSteps.length) * 100) + '%';
    }
    await S.refreshGallery(); S.touch();
    toast('Baked ' + aiSteps.length + ' AI step(s)', 'good');
    renderChain(containerEl);
  } catch (err) { toast('Run failed: ' + err.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = old; prog.style.width = '0'; }
}

async function bakeAiStep(step, e, btn, outThumb) {
  const i = S.project.chain.findIndex((s) => s.id === step.id);
  if (i < 0) return;
  if (!S.comfy.ok) { await S.refreshComfy(); if (!S.comfy.ok) return toast('ComfyUI not reachable', 'bad'); }
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Baking…';
  try {
    await bakeAt(i, e);
    outThumb.innerHTML = ''; outThumb.append(el('img', { src: S.thumbURL(e.ref.output) }));
    await S.refreshGallery(); S.touch();
    toast('Baked ' + e.ref.output, 'good');
  } catch (err) { toast('Bake failed: ' + err.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = old; }
}

// render the chain output reaching step i, save it, run the AI step on it
async function bakeAt(i, e) {
  const blob = await display.captureChainSpec(buildChainSpec(false, i - 1), outputSize());
  const inSaved = await api.renderSave(S.projectName, e.ref.name + '_in', blob, { chain: true, intermediate: true });
  const out = await runAi(e.ref, inSaved.filename);
  e.ref.output = out; S.save();
  await reloadImg(out);
}

async function runAi(effect, inputFile) {
  const schema = await getSchema(effect.workflow);
  const images = { ...effect.images };
  if (schema.imageSlots.length) images[schema.imageSlots[0].id] = inputFile;
  const values = {};
  for (const p of schema.params) values[p.id] = effect.values[p.id] !== undefined ? effect.values[p.id] : p.value;
  const out = await api.generate({ project: S.projectName, key: effect.workflow, name: effect.name + '_chain', values, images });
  return out.filename;
}

async function renderSequence(btn, prog, cmd) {
  if (!S.project.chain.length) return toast('Add steps first', 'bad');
  btn.disabled = true;
  const fps = S.project.chainFps || 24, frames = S.project.chainFrames || 48;
  try {
    display.pause(); display.resetChainSim();
    await api.seqClear(S.projectName, CHAIN_NAME);
    const last = S.project.chain.length - 1;
    for (let i = 0; i < frames; i++) {
      const blob = await display.captureChainSpec(buildChainSpec(true, last), outputSize());   // advance one step/frame
      await api.seqFrame(S.projectName, CHAIN_NAME, i, blob);
      prog.style.width = Math.round(((i + 1) / frames) * 100) + '%';
    }
    const info = await api.videoCommand(S.projectName, CHAIN_NAME, fps);
    cmd.value = info.command;
    toast(`Rendered ${frames} frames`, 'good');
    display.resume();
  } catch (e) { toast('Sequence failed: ' + e.message, 'bad'); }
  finally { btn.disabled = false; prog.style.width = '0'; }
}

async function makeVideo(btn, cmd) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Encoding…';
  try {
    const res = await api.videoMake(S.projectName, CHAIN_NAME, S.project.chainFps || 24);
    cmd.value = res.command;
    toast(res.ok ? 'Video: ' + res.out : 'ffmpeg failed (see log)', res.ok ? 'good' : 'bad');
    if (!res.ok) console.warn(res.log);
  } catch (e) { toast('Video failed: ' + e.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = old; }
}

export function chainDeselect() { selectedStepId = null; display.onTime = null; }
