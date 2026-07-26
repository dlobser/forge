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
import { downloadTexture, openLiveView } from './liveview.js';
import { isSource, isViewer } from './nodes.js';
import { markDirty } from './widgets.js';

const MAX_PREVIEW_PX = 2048;   // cap on the internal blit for a preview canvas

// ── enumeration (used by the author panel) ───────────────────────────────────────
// For each node, the widgets that could be exposed as controls, and whether it can
// be shown as a preview (Viewer nodes). Buttons are included so an author can expose
// e.g. an Import "Upload image…" button or an AI "⚡ Generate" button.
export function enumerateExposable(graph) {
  const out = [];
  for (const node of graph._nodes || []) {
    const widgets = (node.widgets || []).map((w) => ({ name: w.name, type: w.type }));
    const viewer = isViewer(node);
    if (!widgets.length && !viewer) continue;
    out.push({ node, widgets, isViewer: viewer });
  }
  return out;
}

// ── one control, bound to a live widget ──────────────────────────────────────────
function findWidget(node, name) { return (node.widgets || []).find((w) => w.name === name); }

function comboPairs(node, w) {
  // Source's image picker should always reflect the current gallery, not the stale
  // list captured when the node was built.
  if (isSource(node) && w.name === 'image')
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
//
// Layout, and why: the viewer is the point of the page, so it goes at the TOP and
// stays there — on a phone it is sticky, so scrolling through a long list of
// controls never pushes the picture you are adjusting off screen. Several viewers
// become a dropdown rather than a row of canvases: two 500px canvases side by side
// don't fit a phone, and rendering the ones you aren't looking at is wasted GPU.
// On a wide screen the controls move into a column beside the viewer instead.
export function buildEndUserUI(root, config, graph) {
  injectStyle();
  root.innerHTML = '';
  const wrap = document.createElement('div'); wrap.className = 'eu-wrap';
  const stageWrap = document.createElement('div'); stageWrap.className = 'eu-stagewrap';
  const bar = document.createElement('aside'); bar.className = 'eu-bar';
  wrap.append(stageWrap, bar); root.appendChild(wrap);

  // ── the viewer, its selector, and its actions ──
  const previews = (config.previews || [])
    .map((p) => ({ nodeId: p.nodeId, label: p.label, node: graph.getNodeById(p.nodeId) }))
    .filter((p) => p.node);

  const topbar = document.createElement('div'); topbar.className = 'eu-topbar';
  const titleEl = document.createElement('div'); titleEl.className = 'eu-apptitle';
  titleEl.textContent = config.title || 'Forge';
  const select = document.createElement('select'); select.className = 'eu-viewsel';
  previews.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = p.label || ('View ' + (i + 1));
    select.appendChild(o);
  });
  select.hidden = previews.length < 2;      // one viewer needs no chooser
  const actions = document.createElement('div'); actions.className = 'eu-actions';
  const mkBtn = (label, title) => {
    const b = document.createElement('button'); b.className = 'eu-iconbtn';
    b.textContent = label; b.title = title; return b;
  };
  const saveBtn = mkBtn('⬇', 'Save this image as a PNG');
  const fsBtn = mkBtn('⤢', 'Fullscreen (keeps playing)');
  actions.append(saveBtn, fsBtn);
  topbar.append(titleEl, select, actions);

  const box = document.createElement('div'); box.className = 'eu-canvasbox';
  const canvas = document.createElement('canvas'); canvas.className = 'eu-canvas';
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  box.appendChild(canvas);
  stageWrap.append(topbar, box);
  if (!previews.length) {
    const e = document.createElement('div'); e.className = 'eu-empty';
    e.textContent = 'No preview windows — tag a Viewer node in “Author UI”.';
    box.replaceChildren(e);
  }

  let active = 0;
  select.onchange = () => { active = +select.value || 0; lastStamp = ''; };

  const currentFrame = () => {
    const pv = previews[active];
    const node = pv && graph.getNodeById(pv.nodeId);
    const tex = node && node._tex;
    if (!tex) return null;
    const out = node._out || {};
    return { tex, width: out.width || 512, height: out.height || 512 };
  };

  // Save has to work with no backend at all — a static host has nowhere to POST —
  // so it captures the texture in the browser and downloads the PNG directly.
  saveBtn.onclick = async () => {
    const f = currentFrame();
    if (!f) return;
    const name = (config.title || 'forge').replace(/[^A-Za-z0-9._-]+/g, '_');
    const label = (previews[active] && previews[active].label) || '';
    const suffix = label ? '_' + label.replace(/[^A-Za-z0-9._-]+/g, '_') : '';
    saveBtn.disabled = true;
    try { await downloadTexture(f.tex, f.width, f.height, name + suffix + '.png'); }
    finally { saveBtn.disabled = false; }
  };
  fsBtn.onclick = () => openLiveView(currentFrame);
  canvas.ondblclick = () => openLiveView(currentFrame);

  // ── controls grouped by category, in config order ──
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

  // ── per-frame draw ──
  // Redraw only when the picture or the layout actually changed. A static graph on a
  // phone then costs nothing, which matters a great deal more on a phone than it
  // does on a desktop GPU.
  let lastStamp = '';
  return function drawPreviews() {
    const pv = previews[active];
    const node = pv && graph.getNodeById(pv.nodeId);
    const tex = node && node._tex;
    const out = (node && node._out) || {};
    const tw = out.width || 512, th = out.height || 512;
    // Fit the canvas to the picture's aspect at (capped) device resolution; CSS then
    // scales it into whatever space the layout gave us.
    const cssW = Math.max(1, box.clientWidth || 512), cssH = Math.max(1, box.clientHeight || 512);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fit = Math.min(cssW / tw, cssH / th, 1) * dpr;
    const cw = Math.max(1, Math.min(MAX_PREVIEW_PX, Math.round(tw * fit)));
    const ch = Math.max(1, Math.min(MAX_PREVIEW_PX, Math.round(th * fit)));
    const stamp = [active, (out.version | 0), tex ? 1 : 0, cw, ch].join('|');
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.clearRect(0, 0, cw, ch);
    if (!tex) return;
    try {
      const r = RT.engine.blitToCanvas(tex, tw, th, Math.max(cw, ch));
      ctx.drawImage(RT.engine.canvas, 0, 0, r.width, r.height, 0, 0, cw, ch);
    } catch (e) {}
  };
}

// ── styles (injected once; shared by play.html and any in-editor preview) ─────────
let _styled = false;
function injectStyle() {
  if (_styled) return; _styled = true;
  const css = `
  /* Phone first: one scrolling column, viewer pinned to the top, controls below. */
  .eu-wrap{ display:flex; flex-direction:column; height:100%; width:100%; overflow-y:auto;
    -webkit-overflow-scrolling:touch; background:var(--eu-bg,#0d0f12); color:var(--eu-text,#e6e8ea);
    font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif; }
  .eu-stagewrap{ position:sticky; top:0; z-index:5; flex:0 0 auto; background:var(--eu-bg,#0d0f12);
    border-bottom:1px solid var(--eu-line,#262b33); padding:8px 10px 10px; }
  .eu-topbar{ display:flex; align-items:center; gap:8px; margin-bottom:8px; min-height:30px; }
  .eu-apptitle{ font-size:15px; font-weight:600; letter-spacing:.4px; color:#fff; flex:1;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .eu-viewsel{ background:#0d0f12; color:inherit; border:1px solid var(--eu-line,#262b33);
    border-radius:6px; padding:5px 7px; max-width:45%; font-size:12px; }
  .eu-actions{ display:flex; gap:6px; }
  .eu-iconbtn{ background:#1c2028; color:var(--eu-text,#e6e8ea); border:1px solid var(--eu-line,#262b33);
    border-radius:7px; min-width:36px; height:32px; font-size:15px; cursor:pointer; line-height:1; }
  .eu-iconbtn:disabled{ opacity:.5; cursor:default; }
  .eu-canvasbox{ display:flex; align-items:center; justify-content:center; width:100%;
    height:min(52vh, 62vw); background:#000; border:1px solid var(--eu-line,#262b33); border-radius:10px;
    overflow:hidden; }
  .eu-canvas{ display:block; max-width:100%; max-height:100%; width:auto; height:auto;
    background:#000; image-rendering:auto; }
  .eu-bar{ flex:1 1 auto; background:var(--eu-panel,#15181d); padding:14px;
    display:flex; flex-direction:column; gap:14px; }
  .eu-cat{ display:flex; flex-direction:column; gap:10px; }
  .eu-cat h4{ margin:0; color:var(--eu-muted,#8a929c); text-transform:uppercase; font-size:10px; letter-spacing:1.5px;
    border-bottom:1px solid var(--eu-line,#262b33); padding-bottom:6px; }
  .eu-ctrl{ display:flex; flex-direction:column; gap:5px; }
  .eu-label{ color:var(--eu-muted,#8a929c); font-size:11px; }
  .eu-input{ display:flex; align-items:center; gap:8px; }
  .eu-range{ flex:1; accent-color:var(--eu-accent,#5b8cff); height:28px; }
  .eu-num{ width:78px; background:#0d0f12; color:inherit; border:1px solid var(--eu-line,#262b33);
    border-radius:5px; padding:6px; font-size:13px; }
  .eu-select,.eu-text{ flex:1; min-width:0; background:#0d0f12; color:inherit;
    border:1px solid var(--eu-line,#262b33); border-radius:5px; padding:7px; font-size:13px; }
  .eu-textarea{ flex:1; min-height:64px; resize:vertical; background:#0d0f12; color:inherit; border:1px solid var(--eu-line,#262b33);
    border-radius:5px; padding:6px 8px; font:12px/1.4 ui-monospace,monospace; }
  .eu-color{ width:48px; height:32px; padding:0; background:none; border:1px solid var(--eu-line,#262b33); border-radius:5px; cursor:pointer; }
  .eu-toggle{ width:22px; height:22px; accent-color:var(--eu-accent,#5b8cff); cursor:pointer; }
  .eu-btn{ background:var(--eu-accent,#5b8cff); color:#fff; border:none; border-radius:6px;
    padding:9px 14px; cursor:pointer; font-size:13px; }
  .eu-empty{ color:var(--eu-muted,#8a929c); font-size:12px; line-height:1.6; }

  /* Wide screen: controls beside the viewer, each scrolling on its own. */
  @media (min-width: 900px){
    .eu-wrap{ flex-direction:row-reverse; overflow:hidden; }
    .eu-stagewrap{ position:static; flex:1 1 auto; display:flex; flex-direction:column;
      border-bottom:none; padding:16px; min-width:0; }
    .eu-apptitle{ font-size:17px; }
    .eu-canvasbox{ flex:1 1 auto; height:auto; min-height:0; }
    .eu-viewsel{ max-width:260px; }
    .eu-bar{ flex:0 0 320px; width:320px; height:100%; overflow-y:auto;
      border-right:1px solid var(--eu-line,#262b33); }
  }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
}
