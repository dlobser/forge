// liveview.js — the fullscreen viewer, shared by the editor and the authored page.
//
// The old fullscreen captured a PNG and showed it in an <img>, which is why going
// fullscreen froze the animation: what you were looking at was a screenshot. This
// draws into a canvas from a per-frame hook instead, so the graph keeps running and
// the picture keeps moving. Same trick as the in-node thumbnails — blit the node's
// texture into the shared GL canvas, then drawImage it — except sized to the screen.
//
// It also asks for real browser fullscreen on the overlay, so a projector or second
// display gets the picture with no chrome around it.
import { RT } from './runtime.js';

let overlay = null;    // reused; building it once keeps the canvas + its context warm

function build() {
  if (overlay) return overlay;
  const root = document.createElement('div');
  root.id = 'forgeLiveView';
  root.style.cssText = 'position:fixed;inset:0;z-index:120;background:#000;display:none;'
    + 'align-items:center;justify-content:center;cursor:none;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;max-width:100%;max-height:100%;'
    + 'image-rendering:auto;background:#000;';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;'
    + 'gap:10px;align-items:center;padding:7px 12px;background:#000c;border:1px solid #333;'
    + 'border-radius:9px;font:12px -apple-system,Segoe UI,sans-serif;color:#cfd3d8;'
    + 'opacity:0;transition:opacity .18s;pointer-events:none;';
  const mk = (label) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'background:#1c2028;color:#eee;border:1px solid #333;border-radius:6px;'
      + 'padding:5px 11px;cursor:pointer;font-size:12px;';
    return b;
  };
  const fsBtn = mk('⤢ Fullscreen');
  const closeBtn = mk('✕ Close');
  const hint = document.createElement('span');
  hint.style.cssText = 'color:#8a929c;';
  hint.textContent = 'F fullscreen · Esc close';
  bar.append(fsBtn, closeBtn, hint);
  root.append(canvas, bar);
  document.body.appendChild(root);
  overlay = { root, canvas, ctx: canvas.getContext('2d'), bar, fsBtn, closeBtn };
  return overlay;
}

let active = null;    // { source, unhook, onKey, hideTimer }

function toggleFullscreen(root) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
}

export function closeLiveView() {
  if (!active) return;
  const { root } = build();
  active.unhook();
  document.removeEventListener('keydown', active.onKey, true);
  clearTimeout(active.hideTimer);
  active = null;
  root.style.display = 'none';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// `source()` is polled every frame and returns { tex, width, height } — or null,
// which paints black rather than tearing the overlay down (an upstream node can be
// momentarily disconnected without the fullscreen view giving up).
export function openLiveView(source) {
  const ui = build();
  if (active) closeLiveView();
  ui.root.style.display = 'flex';

  const showBar = () => {
    ui.bar.style.opacity = '1'; ui.bar.style.pointerEvents = 'auto';
    ui.root.style.cursor = 'default';
    clearTimeout(active && active.hideTimer);
    const t = setTimeout(() => {
      ui.bar.style.opacity = '0'; ui.bar.style.pointerEvents = 'none';
      ui.root.style.cursor = 'none';
    }, 2200);
    if (active) active.hideTimer = t;
  };

  const draw = () => {
    const frame = source();
    const dw = Math.max(1, ui.root.clientWidth | 0), dh = Math.max(1, ui.root.clientHeight | 0);
    const tw = (frame && frame.width) || 1, th = (frame && frame.height) || 1;
    // The canvas is sized to the picture's aspect at screen scale, then CSS
    // letterboxes it inside the overlay. Cap at the display size: rendering a 4K
    // texture into a 1080p screen at full resolution is pure waste.
    const fit = Math.min(dw / tw, dh / th);
    const cw = Math.max(1, Math.round(tw * Math.min(fit, 1) || tw));
    const ch = Math.max(1, Math.round(th * Math.min(fit, 1) || th));
    if (ui.canvas.width !== cw || ui.canvas.height !== ch) { ui.canvas.width = cw; ui.canvas.height = ch; }
    ui.ctx.fillStyle = '#000'; ui.ctx.fillRect(0, 0, cw, ch);
    if (!frame || !frame.tex) return;
    try {
      const r = RT.engine.blitToCanvas(frame.tex, tw, th, Math.max(cw, ch));
      ui.ctx.drawImage(RT.engine.canvas, 0, 0, r.width, r.height, 0, 0, cw, ch);
    } catch (e) {}
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeLiveView(); }
    else if (e.key === 'f' || e.key === 'F') { e.stopPropagation(); toggleFullscreen(ui.root); }
  };
  document.addEventListener('keydown', onKey, true);

  active = { unhook: RT.addHook(draw), onKey, hideTimer: 0 };
  ui.fsBtn.onclick = (e) => { e.stopPropagation(); toggleFullscreen(ui.root); };
  ui.closeBtn.onclick = (e) => { e.stopPropagation(); closeLiveView(); };
  ui.root.onmousemove = showBar;
  ui.root.ondblclick = () => toggleFullscreen(ui.root);
  // A plain click on the backdrop closes; a click on the bar does not.
  ui.root.onclick = (e) => { if (e.target === ui.root || e.target === ui.canvas) closeLiveView(); };
  showBar();
  draw();
}

// PNG download of a node texture — used by the authored view's Save button, which
// has to work with no backend at all (a static host has nowhere to POST to).
export async function downloadTexture(tex, width, height, filename) {
  const blob = await RT.engine.captureTexture(tex, width, height);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || 'forge.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
