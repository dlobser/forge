// gallery.js — the Gallery tab: thumbnails of every source image in the project
// (imported, shader-rendered, AI-generated, or depth). Click an image to view it
// full screen. A checkbox on each tile enables multi-select; the toolbar deletes
// the whole selection at once. The single ✕ (on hover) still deletes one.
import { S } from './state.js';
import { api } from './api.js';
import { el, openLightbox, toast } from './ui.js';

const selected = new Set();
let panelEl = null;
let toolbarEl = null;

export async function renderGallery(panel) {
  panelEl = panel;
  panel.innerHTML = '';
  await S.refreshGallery();
  // drop selections for images that no longer exist
  const names = new Set(S.gallery.map((i) => i.filename));
  [...selected].forEach((f) => { if (!names.has(f)) selected.delete(f); });

  toolbarEl = el('div', { class: 'gallery-toolbar' });
  panel.append(toolbarEl);
  updateToolbar();

  if (!S.gallery.length) {
    panel.append(el('div', { class: 'muted', style: 'padding:20px;grid-column:1/-1' },
      'No images yet. Use “Import image…” up top, or render a shader / generate an AI image.'));
    return;
  }
  for (const im of S.gallery) panel.append(thumb(im));
}

function updateToolbar() {
  if (!toolbarEl) return;
  const n = selected.size;
  toolbarEl.innerHTML = '';
  // native append() stringifies null/false, so build the list and filter first
  [
    el('span', { class: 'muted tiny' }, n ? `${n} selected` : `${S.gallery.length} image${S.gallery.length === 1 ? '' : 's'}`),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn small', onclick: () => { S.gallery.forEach((i) => selected.add(i.filename)); syncSelection(); } }, 'Select all'),
    n ? el('button', { class: 'btn small', onclick: () => { selected.clear(); syncSelection(); } }, 'Clear') : null,
    el('button', { class: 'btn small danger', disabled: n === 0, onclick: deleteSelected },
      n ? `Delete selected (${n})` : 'Delete selected'),
  ].filter(Boolean).forEach((node) => toolbarEl.append(node));
}

// reflect the selection set onto the DOM without re-fetching the gallery
function syncSelection() {
  panelEl.querySelectorAll('.gthumb').forEach((g) => {
    const f = g.dataset.file;
    g.classList.toggle('selected', selected.has(f));
    const cb = g.querySelector('.gsel');
    if (cb) cb.checked = selected.has(f);
  });
  updateToolbar();
}

function thumb(im) {
  const caption = `${im.filename} · ${im.kind}` + provenance(im);
  const cb = el('input', { type: 'checkbox', class: 'gsel', title: 'Select',
    onclick: (e) => {
      e.stopPropagation();
      e.target.checked ? selected.add(im.filename) : selected.delete(im.filename);
      g.classList.toggle('selected', e.target.checked);
      updateToolbar();
    } });
  cb.checked = selected.has(im.filename);
  const g = el('div', { class: 'gthumb' + (selected.has(im.filename) ? ' selected' : ''), dataset: { file: im.filename } },
    cb,
    el('div', { class: `badge ${im.kind}` }, im.kind),
    el('button', { class: 'gdel', title: 'Delete', onclick: async (e) => {
      e.stopPropagation();
      await api.deleteImage(S.projectName, im.filename);
      selected.delete(im.filename);
      toast('Deleted ' + im.filename);
      renderGallery(panelEl);
    } }, '✕'),
    el('img', { src: api.thumbURL(S.projectName, im.filename), loading: 'lazy',
      onclick: () => openLightbox(api.imageURL(S.projectName, im.filename), caption) }),
    el('div', { class: 'cap', title: im.filename }, im.filename));
  return g;
}

async function deleteSelected() {
  const files = [...selected];
  if (!files.length) return;
  if (!confirm(`Delete ${files.length} image${files.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  for (const f of files) {
    try { await api.deleteImage(S.projectName, f); } catch (e) { /* keep going */ }
  }
  selected.clear();
  toast(`Deleted ${files.length} image${files.length === 1 ? '' : 's'}`, 'good');
  renderGallery(panelEl);
}

function provenance(im) {
  const m = im.meta || {};
  if (m.workflow) return ` · ${m.workflow}`;
  if (m.shader) return ` · ${m.shader}`;
  if (m.source) return ` · from ${m.source}`;
  return '';
}
