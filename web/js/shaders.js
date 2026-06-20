// shaders.js — the Shaders tab: an expandable array of shader-effect instances
// on the left, each with color/depth inputs, auto-generated control sliders, a
// Render button, and (for animated effects) a sequence → ffmpeg pipeline. The
// selected effect previews live in the WebGL display on the right.
import { S } from './state.js';
import { api } from './api.js';
import { display } from './display.js';
import { el, toast, openPicker, rgbToHex, hexToRgb } from './ui.js';

const OUTPUT_SIZES = [256, 512, 1024, 2048, 4096];
let selectedId = null;
const expanded = new Set();

export function renderShaders(container) {
  container.innerHTML = '';
  const defs = S.shaderDefs;

  // add-bar
  const sel = el('select', {}, ...defs.map((d) => el('option', { value: d.key }, d.def.name || d.key)));
  container.append(el('div', { class: 'add-bar' },
    sel,
    el('button', {
      class: 'btn primary', onclick: () => {
        if (!defs.length) return toast('No shaders found in /shaders', 'bad');
        const fx = S.newShaderEffect(sel.value);
        S.project.shaderEffects.push(fx); S.save();
        expanded.add(fx.id); selectEffect(fx.id);
        renderShaders(container);
      },
    }, '＋ Add effect')));

  if (!S.project.shaderEffects.length)
    container.append(el('div', { class: 'muted tiny', style: 'padding:8px' },
      'Add a shader effect, assign a color (and depth) image, then Render.'));

  for (const fx of S.project.shaderEffects) container.append(card(fx, container));
  updateOverlay();
}

function card(fx, container) {
  const def = S.shaderDef(fx.shader);
  const isOpen = expanded.has(fx.id);
  const c = el('div', { class: 'card' + (isOpen ? ' open' : '') + (fx.id === selectedId ? ' selected' : '') });

  const name = el('input', {
    class: 'name', value: fx.name, title: 'Rename',
    onchange: (e) => { fx.name = e.target.value || def?.def.name || fx.shader; S.save(); },
    onclick: (e) => e.stopPropagation(),
  });
  const head = el('div', { class: 'card-head', onclick: () => selectEffect(fx.id) },
    el('span', { class: 'chev' }, '▶'),
    name,
    el('span', { class: 'kind' }, def ? (def.def.animated ? 'anim' : 'shader') : 'missing'),
    el('button', {
      class: 'btn small danger', title: 'Remove', onclick: (e) => {
        e.stopPropagation();
        S.project.shaderEffects = S.project.shaderEffects.filter((f) => f !== fx);
        if (selectedId === fx.id) { selectedId = null; display.clear(); }
        S.save(); renderShaders(container);
      },
    }, '✕'));
  head.querySelector('.chev').onclick = (e) => {
    e.stopPropagation();
    expanded.has(fx.id) ? expanded.delete(fx.id) : expanded.add(fx.id);
    c.classList.toggle('open');
  };
  c.append(head);

  if (!def) { c.append(el('div', { class: 'card-body' }, el('div', { class: 'muted' }, `Shader "${fx.shader}" not found.`))); return c; }

  const body = el('div', { class: 'card-body' });

  // color / depth inputs (a shader may relabel them, e.g. Kuramoto's two drivers)
  const labels = def.def.inputLabels || {};
  body.append(el('div', { class: 'io-row' },
    ioSlot(fx, 'color', labels.color || 'Color', container),
    ioSlot(fx, 'depth', labels.depth || 'Depth', container)));

  // controls
  for (const ctrl of def.def.controls || []) body.append(control(fx, ctrl));

  // output size
  body.append(el('div', { class: 'control' }, el('div', { class: 'crow' },
    el('label', {}, 'Output size'),
    (() => {
      const s = el('select', { onchange: (e) => { fx.outputSize = +e.target.value; S.save(); } },
        ...OUTPUT_SIZES.map((n) => el('option', { value: n, selected: n === fx.outputSize }, `${n} × ${n}`)));
      return s;
    })())));

  // feedback (ping-pong) effects: grid resolution + reseed
  if (def.def.feedback) {
    const grid = el('select', {
      onchange: (e) => { fx.simSize = +e.target.value; S.save(); if (fx.id === selectedId) { display.resetSim(); display.renderStatic(); } },
    }, ...[128, 256, 512].map((n) => el('option', { value: n, selected: n === (fx.simSize || def.def.simSize || 256) }, `${n} × ${n} grid`)));
    body.append(el('div', { class: 'control' }, el('div', { class: 'crow' },
      el('label', {}, 'Sim grid'), grid,
      el('button', {
        class: 'btn small', title: 'Reseed the simulation',
        onclick: () => { if (fx.id !== selectedId) { selectEffect(fx.id); } display.resetSim(); display.renderStatic(); toast('Simulation reseeded'); },
      }, '↺ Reset'))));
  }

  // render + (animation) controls
  const renderBtn = el('button', { class: 'btn primary', onclick: () => doRender(fx, renderBtn) }, 'Render → gallery');
  body.append(el('div', { class: 'row end' }, renderBtn));

  if (def.def.animated) body.append(animBlock(fx));

  c.append(body);
  return c;
}

function ioSlot(fx, slot, label, container) {
  const url = S.thumbURL(fx[slot]);
  const thumb = el('div', { class: 'io-thumb', title: 'Click to choose', onclick: async () => {
    await S.refreshGallery();
    const choice = await openPicker(S.projectName, S.gallery, `${label} image`);
    if (choice === null) return;
    fx[slot] = choice || null; S.save();
    if (fx.id === selectedId) display.reloadImages();
    renderShaders(container);
  } }, url ? el('img', { src: url }) : (slot === 'depth' ? 'depth (optional)' : 'choose color'));
  const actions = [el('span', { class: 'io-label' }, label)];
  if (slot === 'depth' && fx.color)
    actions.push(el('button', { class: 'btn small', title: 'Generate depth from the color image with ComfyUI',
      onclick: (e) => { e.stopPropagation(); genDepth(fx, container); } }, '⚙ gen'));
  return el('div', { class: 'io-slot' }, el('div', { class: 'row' }, ...actions), thumb);
}

export function control(fx, ctrl) {
  const wrap = el('div', { class: 'control' + (ctrl.type === 'text' ? ' full' : '') });
  const cur = fx.params[ctrl.uniform] ?? ctrl.value;
  const live = (v) => {
    fx.params[ctrl.uniform] = v;
    if (fx.id === selectedId && !display.playing) display.renderStatic();
    S.save();
  };
  if (ctrl.type === 'range') {
    const out = el('span', { class: 'val' }, fmt(cur));
    const r = el('input', { type: 'range', min: ctrl.min, max: ctrl.max, step: ctrl.step ?? 0.01, value: cur,
      oninput: (e) => { out.textContent = fmt(+e.target.value); live(+e.target.value); } });
    wrap.append(el('div', { class: 'crow' }, el('label', {}, ctrl.label), r, out));
  } else if (ctrl.type === 'bool') {
    const cb = el('input', { type: 'checkbox', onchange: (e) => live(e.target.checked) });
    cb.checked = !!cur;
    wrap.append(el('div', { class: 'crow' }, el('label', {}, ctrl.label), cb));
  } else if (ctrl.type === 'color') {
    const ci = el('input', { type: 'color', value: rgbToHex(cur), oninput: (e) => live(hexToRgb(e.target.value)) });
    wrap.append(el('div', { class: 'crow' }, el('label', {}, ctrl.label), ci));
  } else if (ctrl.type === 'select') {
    const s = el('select', { onchange: (e) => live(+e.target.value) },
      ...(ctrl.options || []).map((o, i) => el('option', { value: o.value ?? i, selected: (o.value ?? i) === cur }, o.label ?? o)));
    wrap.append(el('div', { class: 'crow' }, el('label', {}, ctrl.label), s));
  } else {
    const n = el('input', { type: 'number', value: cur, step: ctrl.step ?? 0.01,
      onchange: (e) => live(+e.target.value) });
    wrap.append(el('div', { class: 'crow' }, el('label', {}, ctrl.label), n));
  }
  return wrap;
}

function animBlock(fx) {
  const block = el('div', { style: 'border-top:1px solid var(--line);padding-top:8px;display:flex;flex-direction:column;gap:8px' });
  block.append(el('div', { class: 'section-title' }, 'Animation'));
  const fps = el('input', { type: 'number', min: 1, max: 60, value: fx.fps, style: 'width:60px',
    onchange: (e) => { fx.fps = +e.target.value || 24; S.save(); } });
  const frames = el('input', { type: 'number', min: 1, max: 3600, value: fx.frames, style: 'width:70px',
    onchange: (e) => { fx.frames = +e.target.value || 48; S.save(); } });
  block.append(el('div', { class: 'row' },
    el('span', { class: 'tiny muted' }, 'fps'), fps,
    el('span', { class: 'tiny muted' }, 'frames'), frames));

  const prog = el('i');
  const progWrap = el('div', { class: 'progress' }, prog);
  const cmd = el('textarea', { readonly: true, rows: 3, class: 'tiny', placeholder: 'ffmpeg command appears here after rendering a sequence' });

  const seqBtn = el('button', { class: 'btn', onclick: () => renderSequence(fx, prog, cmd, seqBtn) }, 'Render sequence');
  const vidBtn = el('button', { class: 'btn go', onclick: () => makeVideo(fx, cmd, vidBtn) }, 'Make video');
  block.append(el('div', { class: 'row' }, seqBtn, vidBtn),
    progWrap,
    el('div', { class: 'row' },
      el('button', { class: 'btn small', title: 'Copy ffmpeg command',
        onclick: () => { navigator.clipboard.writeText(cmd.value); toast('Command copied'); } }, 'copy cmd')),
    cmd);
  return block;
}

const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

// ── selection / overlay ──────────────────────────────────────────────────────
async function selectEffect(id) {
  selectedId = id;
  document.querySelectorAll('#listPanel .card').forEach((c) => c.classList.remove('selected'));
  const fx = S.project.shaderEffects.find((f) => f.id === id);
  if (!fx) return;
  await display.setEffect(fx);
  updateOverlay();
  // mark selected without full re-render
  renderShaders(document.getElementById('listPanel'));
}

export function updateOverlay() {
  const ov = document.getElementById('displayOverlay');
  if (!ov) return;
  ov.innerHTML = '';
  const fx = S.project.shaderEffects.find((f) => f.id === selectedId);
  if (!fx) return;
  ov.append(el('span', { class: 'pill' }, fx.name));
  const def = S.shaderDef(fx.shader);
  if (def?.def.animated) {
    const timePill = el('span', { class: 'pill' }, '0.00s');
    display.onTime = (t) => (timePill.textContent = t.toFixed(2) + 's');
    const btn = el('button', { class: 'btn small', onclick: () => {
      display.playing ? display.pause() : display.play();
      btn.textContent = display.playing ? '⏸' : '▶';
    } }, display.playing ? '⏸' : '▶');
    ov.append(btn, timePill);
  } else {
    display.onTime = null;
  }
}

// ── actions ──────────────────────────────────────────────────────────────────
async function genDepth(fx, container) {
  if (!fx.color) return toast('Pick a color image first', 'bad');
  if (!S.comfy.ok) { await S.refreshComfy(); if (!S.comfy.ok) return toast('ComfyUI not reachable', 'bad'); }
  toast('Generating depth…');
  try {
    const out = await api.depth(S.projectName, fx.color);
    fx.depth = out.filename; S.save();
    await S.refreshGallery();
    if (fx.id === selectedId) display.reloadImages();
    renderShaders(container);
    toast('Depth map saved', 'good');
  } catch (e) { toast('Depth failed: ' + e.message, 'bad'); }
}

async function doRender(fx, btn) {
  if (!fx.color) return toast('Pick a color image first', 'bad');
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Rendering…';
  try {
    await selectEffect(fx.id);
    const blob = await display.capture(fx.outputSize, 0);
    const out = await api.renderSave(S.projectName, fx.name, blob, {
      shader: fx.shader, color: fx.color, depth: fx.depth, params: fx.params, outputSize: fx.outputSize,
    });
    await S.refreshGallery();
    S.touch();
    toast('Saved ' + out.filename, 'good');
  } catch (e) { toast('Render failed: ' + e.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = old; }
}

async function renderSequence(fx, prog, cmd, btn) {
  if (!fx.color) return toast('Pick a color image first', 'bad');
  btn.disabled = true;
  try {
    await selectEffect(fx.id); display.pause();
    display.resetSim();   // feedback effects start each sequence from a fresh seed
    await api.seqClear(S.projectName, fx.name);
    for (let i = 0; i < fx.frames; i++) {
      // advance:true steps feedback sims one frame per capture (no-op otherwise)
      const blob = await display.capture(fx.outputSize, i / fx.fps, true);
      await api.seqFrame(S.projectName, fx.name, i, blob);
      prog.style.width = Math.round(((i + 1) / fx.frames) * 100) + '%';
    }
    const info = await api.videoCommand(S.projectName, fx.name, fx.fps);
    cmd.value = info.command;
    toast(`Rendered ${fx.frames} frames`, 'good');
    display.play();
  } catch (e) { toast('Sequence failed: ' + e.message, 'bad'); }
  finally { btn.disabled = false; }
}

async function makeVideo(fx, cmd, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Encoding…';
  try {
    const res = await api.videoMake(S.projectName, fx.name, fx.fps);
    cmd.value = res.command;
    toast(res.ok ? 'Video: ' + res.out : 'ffmpeg failed (see log)', res.ok ? 'good' : 'bad');
    if (!res.ok) console.warn(res.log);
  } catch (e) { toast('Video failed: ' + e.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = old; }
}

export function shadersDeselect() { selectedId = null; display.onTime = null; }
