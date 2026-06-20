// ai.js — the AI tab: an array of ComfyUI-workflow instances. Each workflow's
// exposed parameters ({label:default} tags + auto-detected knobs) and image-input
// slots come from /api/workflow/schema. "Generate" patches the graph, runs it in
// ComfyUI, and saves the result into the same gallery the shaders use.
import { S } from './state.js';
import { api } from './api.js';
import { display } from './display.js';
import { el, toast, openPicker } from './ui.js';

const schemaCache = new Map();
let selectedId = null;
const expanded = new Set();

export async function getSchema(key) {
  if (schemaCache.has(key)) return schemaCache.get(key);
  const s = await api.workflowSchema(key);
  schemaCache.set(key, s);
  return s;
}

export function renderAi(container) {
  container.innerHTML = '';
  const wfs = S.workflows;
  const sel = el('select', {}, ...wfs.map((w) => el('option', { value: w.key }, `${w.name} (${w.format})`)));
  container.append(el('div', { class: 'add-bar' },
    sel,
    el('button', { class: 'btn primary', onclick: () => {
      if (!wfs.length) return toast('No workflows found', 'bad');
      const fx = S.newAiEffect(sel.value);
      S.project.aiEffects.push(fx); S.save();
      expanded.add(fx.id); selectAi(fx.id); renderAi(container);
    } }, '＋ Add workflow')));

  if (!wfs.length)
    container.append(el('div', { class: 'muted tiny', style: 'padding:8px' },
      `No workflows in ${S.settings?.paths?.workflows_dir || 'the workflows folder'}.`));
  if (!S.project.aiEffects.length && wfs.length)
    container.append(el('div', { class: 'muted tiny', style: 'padding:8px' },
      'Add a workflow, set its parameters & input images, then Generate.'));

  for (const fx of S.project.aiEffects) container.append(card(fx, container));
}

function card(fx, container) {
  const isOpen = expanded.has(fx.id);
  const c = el('div', { class: 'card' + (isOpen ? ' open' : '') + (fx.id === selectedId ? ' selected' : '') });

  const name = el('input', { class: 'name', value: fx.name,
    onchange: (e) => { fx.name = e.target.value || fx.workflow; S.save(); },
    onclick: (e) => e.stopPropagation() });
  const head = el('div', { class: 'card-head', onclick: () => selectAi(fx.id) },
    el('span', { class: 'chev' }, '▶'), name,
    el('span', { class: 'kind' }, 'ai'),
    el('button', { class: 'btn small danger', onclick: (e) => {
      e.stopPropagation();
      S.project.aiEffects = S.project.aiEffects.filter((f) => f !== fx);
      if (selectedId === fx.id) selectedId = null;
      S.save(); renderAi(container);
    } }, '✕'));
  head.querySelector('.chev').onclick = (e) => {
    e.stopPropagation();
    expanded.has(fx.id) ? expanded.delete(fx.id) : expanded.add(fx.id);
    c.classList.toggle('open');
  };
  c.append(head);

  const body = el('div', { class: 'card-body' }, el('div', { class: 'muted tiny' }, 'loading parameters…'));
  c.append(body);
  if (isOpen) fillBody(fx, body, container);
  // build body on first expand too
  head.querySelector('.chev').addEventListener('click', () => { if (expanded.has(fx.id) && body.dataset.filled !== '1') fillBody(fx, body, container); });
  return c;
}

async function fillBody(fx, body, container) {
  body.dataset.filled = '1';
  let schema;
  try { schema = await getSchema(fx.workflow); }
  catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'muted' }, 'Schema error: ' + e.message)); return; }
  body.innerHTML = '';

  // image slots
  if (schema.imageSlots.length) {
    body.append(el('div', { class: 'section-title' }, 'Input images'));
    const row = el('div', { class: 'io-row' });
    for (const slot of schema.imageSlots) row.append(aiSlot(fx, slot, container));
    body.append(row);
  }

  // params: tagged + prompts (multiline) up front, the rest under <details>
  const main = schema.params.filter((p) => p.source !== 'auto' || p.multiline);
  const auto = schema.params.filter((p) => p.source === 'auto' && !p.multiline);
  if (main.length) {
    body.append(el('div', { class: 'section-title' }, 'Parameters'));
    for (const p of main) body.append(aiControl(fx, p));
  }
  if (auto.length) {
    const det = el('details', { class: 'advanced' }, el('summary', {}, `Advanced (${auto.length})`));
    for (const p of auto) det.append(aiControl(fx, p));
    body.append(det);
  }
  if (!schema.params.length && !schema.imageSlots.length)
    body.append(el('div', { class: 'muted tiny' }, 'No exposed parameters. Add {tags} to the workflow or edit its sidecar.'));

  // generate row + output
  const outThumb = el('div', { class: 'io-thumb', style: 'height:96px',
    onclick: () => fx.output && display.showImage(S.imageURL(fx.output)) },
    fx.output ? el('img', { src: S.thumbURL(fx.output) }) : 'output');
  const genBtn = el('button', { class: 'btn primary', onclick: () => generate(fx, schema, genBtn, outThumb) }, 'Generate → gallery');
  const dice = el('button', { class: 'btn small', title: 'Randomize seed', onclick: () => { randomizeSeeds(fx, schema); fillBody(fx, body, container); } }, '🎲');
  body.append(el('div', { class: 'row end' }, dice, genBtn),
    el('div', { class: 'io-slot' }, el('div', { class: 'io-label' }, 'Last output'), outThumb));
}

function aiSlot(fx, slot, container) {
  const cur = fx.images[slot.id];
  const thumb = el('div', { class: 'io-thumb', title: 'Choose input image', onclick: async () => {
    await S.refreshGallery();
    const choice = await openPicker(S.projectName, S.gallery, slot.label);
    if (choice === null) return;
    if (choice) fx.images[slot.id] = choice; else delete fx.images[slot.id];
    S.save();
    thumb.innerHTML = '';
    thumb.append(fx.images[slot.id] ? el('img', { src: S.thumbURL(fx.images[slot.id]) }) : document.createTextNode('choose'));
  } }, cur ? el('img', { src: S.thumbURL(cur) }) : 'choose');
  return el('div', { class: 'io-slot' }, el('div', { class: 'io-label' }, slot.label), thumb);
}

export function aiControl(fx, p) {
  const wrap = el('div', { class: 'control' + (p.multiline ? ' full' : '') });
  const cur = fx.values[p.id] !== undefined ? fx.values[p.id] : p.value;
  const set = (v) => { fx.values[p.id] = v; S.save(); };
  if (p.multiline || (p.type === 'text' && p.source === 'auto')) {
    wrap.append(el('label', {}, p.label),
      el('textarea', { rows: 3, oninput: (e) => set(e.target.value) }, cur ?? ''));
  } else if (p.type === 'bool') {
    const cb = el('input', { type: 'checkbox', onchange: (e) => set(e.target.checked) }); cb.checked = !!cur;
    wrap.append(el('div', { class: 'crow' }, el('label', {}, p.label), cb));
  } else if (p.type === 'combo') {
    wrap.append(el('div', { class: 'crow' }, el('label', {}, p.label),
      el('select', { onchange: (e) => set(e.target.value) },
        ...(p.options || []).map((o) => el('option', { value: o, selected: o === cur }, String(o))))));
  } else if (p.type === 'int' || p.type === 'number') {
    const a = { type: 'number', value: cur, onchange: (e) => set(p.type === 'int' ? Math.round(+e.target.value) : +e.target.value) };
    if (p.step !== undefined) a.step = p.step; if (p.min !== undefined) a.min = p.min; if (p.max !== undefined) a.max = p.max;
    wrap.append(el('div', { class: 'crow' }, el('label', {}, p.label), el('input', a)));
  } else {
    wrap.append(el('div', { class: 'crow' }, el('label', {}, p.label),
      el('input', { type: 'text', value: cur ?? '', oninput: (e) => set(e.target.value), style: 'flex:1' })));
  }
  return wrap;
}

function randomizeSeeds(fx, schema) {
  for (const p of schema.params) {
    if (/seed/i.test(p.input)) fx.values[p.id] = Math.floor(Math.random() * 1e15);
  }
  S.save();
}

async function selectAi(id) {
  selectedId = id;
  const fx = S.project.aiEffects.find((f) => f.id === id);
  document.getElementById('displayOverlay').innerHTML = '';
  if (fx?.output) display.showImage(S.imageURL(fx.output));
  else display.showCanvas();
  renderAi(document.getElementById('listPanel'));
}

async function generate(fx, schema, btn, outThumb) {
  if (!S.comfy.ok) { await S.refreshComfy(); if (!S.comfy.ok) return toast('ComfyUI not reachable', 'bad'); }
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Generating…';
  const values = {};
  for (const p of schema.params) values[p.id] = fx.values[p.id] !== undefined ? fx.values[p.id] : p.value;
  try {
    const out = await api.generate({ project: S.projectName, key: fx.workflow, name: fx.name, values, images: fx.images });
    fx.output = out.filename; S.save();
    outThumb.innerHTML = ''; outThumb.append(el('img', { src: S.thumbURL(out.filename) }));
    display.showImage(S.imageURL(out.filename));
    await S.refreshGallery(); S.touch();
    toast('Generated ' + out.filename, 'good');
  } catch (e) { toast('Generate failed: ' + e.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = old; }
}

export function aiDeselect() { selectedId = null; }
