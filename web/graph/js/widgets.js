// widgets.js — turn a shader manifest `controls` entry or an AI workflow schema
// `param` into litegraph widgets bound to the node's persisted properties.
// addWidget(type, name, value, callback, options).
import { RT } from './runtime.js';

export function markDirty(node) {
  node._dirty = true;
  RT.requestSave();
  RT.redraw();
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
export function rgbToHex(a) {
  const c = Array.isArray(a) ? a : [1, 1, 1];
  return '#' + c.slice(0, 3).map((x) => clamp255(x).toString(16).padStart(2, '0')).join('');
}
export function hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec((h || '').trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// Add a single shader widget for one control. Used by addShaderWidgets and
// by _togglePinMode when switching a control back from pin to slider.
export function addSingleShaderWidget(node, c) {
  if (node.properties.params[c.uniform] === undefined) node.properties.params[c.uniform] = c.value;
  const set = (v) => { node.properties.params[c.uniform] = v; markDirty(node); };
  const cur = node.properties.params[c.uniform];
  let w;
  if (c.type === 'range') {
    w = node.addWidget('slider', c.label, cur, set, { min: c.min, max: c.max, step: c.step ?? 0.01 });
  } else if (c.type === 'bool') {
    w = node.addWidget('toggle', c.label, !!cur, set);
  } else if (c.type === 'select') {
    const values = {};
    (c.options || []).forEach((o, i) => { values[o.label ?? String(o)] = (o.value ?? i); });
    w = node.addWidget('combo', c.label, cur, set, { values });
  } else if (c.type === 'color') {
    w = node.addWidget('text', c.label, rgbToHex(cur), (v) => set(hexToRgb(v)));
  } else {
    w = node.addWidget('number', c.label, cur, set, { step: (c.step ?? 0.01) * 10 });
  }
  if (w) { w._uniform = c.uniform; w._isColor = (c.type === 'color'); }
  return w;
}

// Shader controls → widgets. Values live in node.properties.params[uniform].
export function addShaderWidgets(node, def) {
  node.properties.params = node.properties.params || {};
  for (const c of def.controls || []) addSingleShaderWidget(node, c);
}

// after a graph reload, make the widget displays match the restored params
// (litegraph builds shader widgets in the constructor, before configure runs)
export function syncShaderWidgets(node) {
  for (const w of node.widgets || []) {
    if (w._uniform === undefined) continue;
    const v = node.properties.params[w._uniform];
    w.value = w._isColor ? rgbToHex(v) : v;
  }
}

// AI schema params → widgets. Values live in node.properties.values[paramId].
export function addAiWidgets(node, schema) {
  node.properties.values = node.properties.values || {};
  for (const p of schema.params || []) {
    if (node.properties.values[p.id] === undefined) node.properties.values[p.id] = p.value;
    const set = (v) => { node.properties.values[p.id] = v; markDirty(node); };
    const cur = node.properties.values[p.id];
    let w;
    if (p.multiline) w = multilineWidget(node, p);              // prompts open an expandable editor
    else if (p.type === 'bool') w = node.addWidget('toggle', p.label, !!cur, set);
    else if (p.type === 'combo') w = node.addWidget('combo', p.label, cur, set, { values: p.options || [] });
    else if (p.type === 'int' || p.type === 'number')
      w = node.addWidget('number', p.label, cur, (v) => set(p.type === 'int' ? Math.round(v) : v),
        { min: p.min, max: p.max, step: p.step ?? 1 });
    else w = node.addWidget('text', p.label, String(cur ?? ''), set);
    if (w) w._pid = p.id;
  }
}

// a button that previews the text and opens a big editable textarea on click
function multilineWidget(node, p) {
  const short = (s) => { s = String(s ?? ''); s = s.replace(/\s+/g, ' ').trim(); return p.label + ': ' + (s.length > 24 ? s.slice(0, 24) + '…' : (s || '(empty)')); };
  const w = node.addWidget('button', short(node.properties.values[p.id]), null, () => {
    openTextEditor(p.label, node.properties.values[p.id] || '', (val) => {
      node.properties.values[p.id] = val; w.name = short(val); markDirty(node);
    });
  });
  return w;
}

// modal textarea (used for prompts). Save on Ctrl/Cmd+Enter or the Save button.
export function openTextEditor(title, value, onSave) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:80;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#15181d;border:1px solid #262b33;border-radius:10px;padding:14px;width:min(680px,92vw);display:flex;flex-direction:column;gap:10px;';
  const h = document.createElement('div'); h.textContent = title;
  h.style.cssText = 'color:#8a929c;text-transform:uppercase;font-size:11px;letter-spacing:1px;';
  const ta = document.createElement('textarea'); ta.value = value || '';
  ta.style.cssText = 'width:100%;height:240px;background:#0d0f12;color:#e6e8ea;border:1px solid #262b33;border-radius:6px;padding:10px;font:13px/1.5 ui-monospace,monospace;resize:vertical;';
  const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
  const mk = (label, primary) => { const b = document.createElement('button'); b.textContent = label;
    b.style.cssText = `padding:6px 14px;border-radius:6px;cursor:pointer;border:1px solid ${primary ? '#5b8cff' : '#262b33'};background:${primary ? '#5b8cff' : '#1c2028'};color:${primary ? '#fff' : '#e6e8ea'};`; return b; };
  const cancel = mk('Cancel', false), ok = mk('Save', true);
  row.append(cancel, ok); box.append(h, ta, row); ov.append(box); document.body.append(ov);
  ta.focus();
  const close = () => ov.remove();
  cancel.onclick = close;
  ok.onclick = () => { onSave(ta.value); close(); };
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ta.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { onSave(ta.value); close(); } };
}
