// ui.js — tiny DOM helpers plus the shared modals (toast, image picker, lightbox).
import { api } from './api.js';

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

let _toastTimer = null;
export function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => (t.hidden = true), kind === 'bad' ? 6000 : 3000);
}

// Image picker — resolves to a gallery filename, '' to clear, or null on cancel.
export function openPicker(project, images, title = 'Choose image') {
  const modal = document.getElementById('picker');
  const grid = document.getElementById('pickerGrid');
  document.getElementById('pickerTitle').textContent = title;
  grid.innerHTML = '';
  return new Promise((resolve) => {
    const done = (val) => { modal.hidden = true; cleanup(); resolve(val); };
    const cleanup = () => {
      modal.querySelector('.modal-close').onclick = null;
      modal.onclick = null;
    };
    grid.append(el('div', { class: 'gthumb', onclick: () => done('') },
      el('div', { class: 'cap', style: 'aspect-ratio:1;display:flex;align-items:center;justify-content:center' }, '— none —')));
    if (!images.length)
      grid.append(el('div', { class: 'none' }, 'No images yet — import one or render something.'));
    for (const im of images) {
      grid.append(el('div', { class: 'gthumb', title: im.filename, onclick: () => done(im.filename) },
        el('div', { class: `badge ${im.kind}` }, im.kind),
        el('img', { src: api.thumbURL(project, im.filename), loading: 'lazy' }),
        el('div', { class: 'cap' }, im.filename)));
    }
    modal.querySelector('.modal-close').onclick = () => done(null);
    modal.onclick = (e) => { if (e.target === modal) done(null); };
    modal.hidden = false;
  });
}

export function openLightbox(url, caption = '') {
  const modal = document.getElementById('lightbox');
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightboxCaption').textContent = caption;
  modal.hidden = false;
  const close = () => { modal.hidden = true; };
  modal.querySelector('.lightbox-close').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

// 0..1 rgb array <-> #rrggbb
export function rgbToHex(rgb) {
  const h = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
}
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
