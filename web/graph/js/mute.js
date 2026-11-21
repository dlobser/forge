// mute.js — the editor half of muting: the shortcut, the menu item and the veil.
// The evaluation half (what a muted node passes through) lives in boot.js, so the
// published page treats a muted node exactly as the editor does.
//
//   Ctrl+M (or Ctrl+B)   mute / unmute the selected nodes
//   right-click a node   ▸ Mute (pass-through) / Unmute
import { RT } from './runtime.js';
import { MUTED, isMuted } from './boot.js';

const LG = window.LiteGraph;

export function setMuted(nodes, on) {
  for (const n of nodes) n.mode = on ? MUTED : LG.ALWAYS;
  RT.requestSave(); RT.redraw();
}

// Several selected and some already muted? One press unmutes them all, so a
// second press reliably does the opposite of the first.
export function toggleMuted(nodes) {
  if (!nodes.length) return;
  setMuted(nodes, !nodes.some(isMuted));
  RT.toast(nodes.length + ' node' + (nodes.length > 1 ? 's' : '') + (isMuted(nodes[0]) ? ' muted' : ' unmuted'));
}

const selected = () => Object.values((RT.graphcanvas && RT.graphcanvas.selected_nodes) || {});

let installed = false;
export function installMute() {
  if (installed) return;
  installed = true;
  const LGC = window.LGraphCanvas;

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'm' && k !== 'b') return;
    const t = e.target, tag = t && t.localName;
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
    const nodes = selected();
    if (!nodes.length) return;
    e.preventDefault(); e.stopPropagation();
    toggleMuted(nodes);
  }, true);

  // Right-click menu: first item, so it's where your hand expects it.
  const origMenu = LGC.prototype.getNodeMenuOptions;
  LGC.prototype.getNodeMenuOptions = function (node) {
    const opts = origMenu.call(this, node) || [];
    const sel = selected();
    const targets = sel.includes(node) ? sel : [node];
    opts.unshift({
      content: (isMuted(node) ? '▶ Unmute' : '⦸ Mute (pass-through)') + '   Ctrl+M',
      callback: () => setMuted(targets, !isMuted(node)),
    }, null);
    return opts;
  };

  // The veil: a muted node is drawn as usual, then dimmed and labelled, so it's
  // obvious at a glance which parts of a graph are switched off.
  const origDraw = LGC.prototype.drawNode;
  LGC.prototype.drawNode = function (node, ctx) {
    origDraw.call(this, node, ctx);
    if (!isMuted(node)) return;
    const th = LG.NODE_TITLE_HEIGHT;
    const collapsed = node.flags && node.flags.collapsed;
    const w = collapsed ? (node._collapsed_width || LG.NODE_COLLAPSED_WIDTH) : node.size[0];
    const h = collapsed ? th : node.size[1] + th;
    ctx.save();
    ctx.fillStyle = 'rgba(12,10,22,0.62)';
    ctx.fillRect(0, -th, w, h);
    ctx.strokeStyle = 'rgba(170,140,255,0.75)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]); ctx.strokeRect(0.5, -th + 0.5, w - 1, h - 1); ctx.setLineDash([]);
    ctx.fillStyle = '#c9b8ff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('MUTED', w - 8, -th / 2 + 4);
    ctx.restore();
  };
}
