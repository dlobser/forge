// endui.js — shared "end-user" UI for the published front-end. A graph that the
// author tagged (graph.extra.endUser) is rendered as a left bar of categorized
// controls + one or more preview windows, with the node network running underneath.
//
// Every control is just an existing litegraph widget: we read widget.value /
// widget.options and write back through widget.callback(v) (same path the node
// editor uses), so a slider here drives the node exactly as it would in the graph.
// Previews mirror a Viewer node's live texture (node._tex) into a 2D canvas via
// engine.blitToCanvas — the same trick the in-node thumbnails use.
import { RT } from './runtime.js';
import { markDirty } from './widgets.js';

const PREVIEW_PX = 512;   // internal capture resolution for preview canvases

// ── enumeration (used by the author panel) ───────────────────────────────────────
// For each node, the widgets that could be exposed as controls, and whether it can
// be shown as a preview (Viewer nodes). Buttons are included so an author can expose
// e.g. an Import "Upload image…" button or an AI "⚡ Generate" button.
export function enumerateExposable(graph) {
  const out = [];
  for (const node of graph._nodes || []) {
    const widgets = (node.widgets || []).map((w) => ({ name: w.name, type: w.type }));
    const isViewer = node.type === 'forge/viewer';
    if (!widgets.length && !isViewer) continue;
    out.push({ node, widgets, isViewer });
  }
  return out;
}

// ── one control, bound to a live widget ──────────────────────────────────────────
function findWidget(node, name) { return (node.widgets || []).find((w) => w.name === name); }

function comboPairs(node, w) {
  // Source's image picker should always reflect the current gallery, not the stale
  // list captured when the node was built.
  if (node.type === 'forge/source' && w.name === 'image')
    return RT.gallery.map((i) => ({ label: i.filename, value: i.filename }));
  const vals = (w.options && w.options.values) || [];
  if (Array.isArray(vals)) return vals.map((v) => ({ label: String(v), value: v }));
  return Object.entries(vals).map(([label, value]) => ({ label, value }));
}

function controlInput(node, w) {
  const el = document.createElement('div'); el.className = 'eu-input';

  if (w.type === 'button') {
    if (w._pid !== undefined) {                         // AI prompt → inline textarea
      const ta = document.createElement('textarea'); ta.className = 'eu-textarea';
      ta.value = String((node.properties.values && node.properties.values[w._pid]) ?? '');
      ta.oninput = () => { node.properties.values[w._pid] = ta.value; markDirty(node); };
      el.appendChild(ta); return el;
    }
    const b = document.createElement('button'); b.className = 'eu-btn'; b.textContent = w.name;
    b.onclick = () => { try { w.callback && w.callback(); } catch (e) {} };
    el.appendChild(b); return el;
  }

  if (w.type === 'toggle') {
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'eu-toggle';
    cb.checked = !!w.value;
    cb.onchange = () => { w.value = cb.checked; w.callback && w.callback(cb.checked); };
    el.appendChild(cb); return el;
  }

  if (w.type === 'combo') {
    const sel = document.createElement('select'); sel.className = 'eu-select';
    const pairs = comboPairs(node, w);
    pairs.forEach((p, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = p.label; sel.appendChild(o); });
    let idx = pairs.findIndex((p) => p.value === w.value);
    if (idx < 0) idx = pairs.findIndex((p) => String(p.value) === String(w.value));
    sel.value = String(idx < 0 ? 0 : idx);
    sel.onchange = () => { const v = pairs[+sel.value] && pairs[+sel.value].value; w.value = v; w.callback && w.callback(v); };
    el.appendChild(sel); return el;
  }

  if (w.type === 'text' && w._isColor) {
    const c = document.createElement('input'); c.type = 'color'; c.className = 'eu-color';
    c.value = /^#?[0-9a-f]{6}$/i.test(String(w.value)) ? (String(w.value)[0] === '#' ? w.value : '#' + w.value) : '#ffffff';
    c.oninput = () => { w.value = c.value; w.callback && w.callback(c.value); };
    el.appendChild(c); return el;
  }

  if (w.type === 'text') {
    const t = document.createElement('input'); t.type = 'text'; t.className = 'eu-text';
    t.value = String(w.value ?? '');
    t.oninput = () => { w.value = t.value; w.callback && w.callback(t.value); };
    el.appendChild(t); return el;
  }

  // 'slider' and 'number' → range (+readout) / number
  const opt = w.options || {};
  const isSlider = w.type === 'slider' && opt.min !== undefined && opt.max !== undefined;
  const num = document.createElement('input'); num.type = 'number'; num.className = 'eu-num';
  if (opt.step !== undefined) num.step = opt.step;
  if (opt.min !== undefined) num.min = opt.min;
  if (opt.max !== undefined) num.max = opt.max;
  num.value = w.value;
  const apply = (v) => { v = +v; if (isNaN(v)) return; w.value = v; w.callback && w.callback(v); };
  if (isSlider) {
    const r = document.createElement('input'); r.type = 'range'; r.className = 'eu-range';
    r.min = opt.min; r.max = opt.max; r.step = opt.step ?? 0.01; r.value = w.value;
    r.oninput = () => { num.value = r.value; apply(r.value); };
    num.oninput = () => { r.value = num.value; apply(num.value); };
    el.appendChild(r);
  } else {
    num.oninput = () => apply(num.value);
  }
  el.appendChild(num);
  return el;
}

function controlRow(node, w, label) {
  const row = document.createElement('div'); row.className = 'eu-ctrl';
  const lab = document.createElement('label'); lab.className = 'eu-label'; lab.textContent = label || w.name;
  row.appendChild(lab);
  row.appendChild(controlInput(node, w));
  return row;
}

// ── build the full end-user view; returns a per-frame drawPreviews() ─────────────
export function buildEndUserUI(root, config, graph) {
  injectStyle();
  root.innerHTML = '';
  const wrap = document.createElement('div'); wrap.className = 'eu-wrap';
  const bar = document.createElement('aside'); bar.className = 'eu-bar';
  const stage = document.createElement('main'); stage.className = 'eu-stage';
  wrap.append(bar, stage); root.appendChild(wrap);

  if (config.title) { const t = document.createElement('div'); t.className = 'eu-apptitle'; t.textContent = config.title; bar.appendChild(t); }

  // controls grouped by category, in config order
  const cats = []; const byCat = new Map();
  for (const c of config.controls || []) {
    const node = graph.getNodeById(c.nodeId); if (!node) continue;
    const w = findWidget(node, c.widget); if (!w) continue;
    const cat = c.category || 'Controls';
    if (!byCat.has(cat)) { byCat.set(cat, []); cats.push(cat); }
    byCat.get(cat).push(controlRow(node, w, c.label));
  }
  if (!cats.length) { const e = document.createElement('div'); e.className = 'eu-empty'; e.textContent = 'No controls exposed yet — open the editor’s “Author UI” panel.'; bar.appendChild(e); }
  for (const cat of cats) {
    const sec = document.createElement('section'); sec.className = 'eu-cat';
    const h = document.createElement('h4'); h.textContent = cat; sec.appendChild(h);
    for (const row of byCat.get(cat)) sec.appendChild(row);
    bar.appendChild(sec);
  }

  // previews
  const previews = [];
  for (const p of config.previews || []) {
    const node = graph.getNodeById(p.nodeId); if (!node) continue;
    const box = document.createElement('div'); box.className = 'eu-preview';
    if (p.label) { const l = document.createElement('div'); l.className = 'eu-pvlabel'; l.textContent = p.label; box.appendChild(l); }
    const cv = document.createElement('canvas'); cv.width = PREVIEW_PX; cv.height = PREVIEW_PX; cv.className = 'eu-canvas';
    box.appendChild(cv); stage.appendChild(box);
    previews.push({ nodeId: p.nodeId, canvas: cv, ctx: cv.getContext('2d') });
  }
  if (!previews.length) { const e = document.createElement('div'); e.className = 'eu-empty'; e.textContent = 'No preview windows — tag a Viewer node in “Author UI”.'; stage.appendChild(e); }

  return function drawPreviews() {
    for (const pv of previews) {
      const node = graph.getNodeById(pv.nodeId);
      const tex = node && node._tex;
      if (!tex) { pv.ctx.clearRect(0, 0, pv.canvas.width, pv.canvas.height); continue; }
      // Blit at the node's own resolution, then letterbox into the square preview
      // canvas — otherwise a non-square output gets squashed to a square.
      const out = node._out || {};
      const tw = out.width || PREVIEW_PX, th = out.height || PREVIEW_PX;
      const cw = pv.canvas.width, ch = pv.canvas.height;
      const s = Math.min(cw / tw, ch / th), iw = tw * s, ih = th * s;
      try {
        RT.engine.blitToCanvas(tex, tw, th);
        pv.ctx.clearRect(0, 0, cw, ch);
        pv.ctx.drawImage(RT.engine.canvas, (cw - iw) / 2, (ch - ih) / 2, iw, ih);
      } catch (e) {}
    }
  };
}

// ── styles (injected once; shared by play.html and any in-editor preview) ─────────
let _styled = false;
function injectStyle() {
  if (_styled) return; _styled = true;
  const css = `
  .eu-wrap{ display:flex; height:100%; width:100%; background:var(--eu-bg,#0d0f12); color:var(--eu-text,#e6e8ea);
    font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif; }
  .eu-bar{ width:300px; min-width:300px; height:100%; overflow-y:auto; background:var(--eu-panel,#15181d);
    border-right:1px solid var(--eu-line,#262b33); padding:14px; display:flex; flex-direction:column; gap:14px; }
  .eu-apptitle{ font-size:18px; font-weight:600; letter-spacing:.5px; color:#fff; }
  .eu-cat{ display:flex; flex-direction:column; gap:10px; }
  .eu-cat h4{ margin:0; color:var(--eu-muted,#8a929c); text-transform:uppercase; font-size:10px; letter-spacing:1.5px;
    border-bottom:1px solid var(--eu-line,#262b33); padding-bottom:6px; }
  .eu-ctrl{ display:flex; flex-direction:column; gap:5px; }
  .eu-label{ color:var(--eu-muted,#8a929c); font-size:11px; }
  .eu-input{ display:flex; align-items:center; gap:8px; }
  .eu-range{ flex:1; accent-color:var(--eu-accent,#5b8cff); }
  .eu-num{ width:74px; background:#0d0f12; color:inherit; border:1px solid var(--eu-line,#262b33); border-radius:5px; padding:4px 6px; }
  .eu-select,.eu-text{ flex:1; background:#0d0f12; color:inherit; border:1px solid var(--eu-line,#262b33); border-radius:5px; padding:5px 7px; }
  .eu-textarea{ flex:1; min-height:64px; resize:vertical; background:#0d0f12; color:inherit; border:1px solid var(--eu-line,#262b33);
    border-radius:5px; padding:6px 8px; font:12px/1.4 ui-monospace,monospace; }
  .eu-color{ width:44px; height:28px; padding:0; background:none; border:1px solid var(--eu-line,#262b33); border-radius:5px; cursor:pointer; }
  .eu-toggle{ width:18px; height:18px; accent-color:var(--eu-accent,#5b8cff); cursor:pointer; }
  .eu-btn{ background:var(--eu-accent,#5b8cff); color:#fff; border:none; border-radius:6px; padding:7px 12px; cursor:pointer; font-size:12px; }
  .eu-stage{ flex:1; height:100%; overflow:auto; display:flex; flex-wrap:wrap; align-content:flex-start; gap:16px; padding:20px;
    justify-content:center; }
  .eu-preview{ display:flex; flex-direction:column; gap:6px; }
  .eu-pvlabel{ color:var(--eu-muted,#8a929c); text-transform:uppercase; font-size:10px; letter-spacing:1px; }
  .eu-canvas{ width:min(72vh,640px); height:min(72vh,640px); max-width:100%; background:#000;
    border:1px solid var(--eu-line,#262b33); border-radius:8px; image-rendering:auto; }
  .eu-empty{ color:var(--eu-muted,#8a929c); font-size:12px; line-height:1.6; }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
}
