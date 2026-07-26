// author.js — the editor-side "Author UI" panel. Lets the author choose which node
// widgets become end-user controls (with a category + label) and which Viewer nodes
// become preview windows, plus a front-end title. The result is stored in
// RT.graph.extra.endUser and persisted by the normal graph save; the published page
// (play.html) reads it. Loaded alongside graphApp.js; it imports the same RT
// singleton and wires its own button, so graphApp.js stays untouched.
import { RT } from './runtime.js';
import { enumerateExposable } from './endui.js';
import { isViewer } from './nodes.js';

const $ = (id) => document.getElementById(id);

function nodeTitle(node) { return node.title || node.type || ('node ' + node.id); }

function openPanel() {
  if (!RT.graph) { RT.toast && RT.toast('Graph not ready yet', 'bad'); return; }
  const cfg = (RT.graph.extra && RT.graph.extra.endUser) || { title: '', controls: [], previews: [] };
  const findCtrl = (nid, w) => (cfg.controls || []).find((c) => c.nodeId === nid && c.widget === w);
  const findPrev = (nid) => (cfg.previews || []).find((p) => p.nodeId === nid);

  const ov = document.createElement('div'); ov.className = 'au-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:90;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#15181d;border:1px solid #262b33;border-radius:10px;width:min(760px,94vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;';

  const head = document.createElement('div');
  head.style.cssText = 'padding:14px 16px;border-bottom:1px solid #262b33;display:flex;align-items:center;gap:12px;';
  head.innerHTML = '<div style="font-size:14px;font-weight:600;flex:1;">Author end-user UI</div>';
  const titleWrap = document.createElement('div'); titleWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
  titleWrap.innerHTML = '<label style="color:#8a929c;text-transform:uppercase;font-size:10px;letter-spacing:1px;">Title</label>';
  const titleInput = document.createElement('input'); titleInput.type = 'text'; titleInput.value = cfg.title || '';
  titleInput.placeholder = 'My front-end';
  titleInput.style.cssText = 'background:#0d0f12;color:#e6e8ea;border:1px solid #262b33;border-radius:6px;padding:6px 8px;width:220px;';
  titleWrap.appendChild(titleInput); head.appendChild(titleWrap);

  const body = document.createElement('div');
  body.style.cssText = 'padding:8px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;';

  const lbl = (txt, w) => { const s = document.createElement('span'); s.textContent = txt; s.style.cssText = 'color:#8a929c;font-size:11px;' + (w ? `width:${w}px;` : ''); return s; };
  const inp = (val, ph, w) => { const i = document.createElement('input'); i.type = 'text'; i.value = val || ''; i.placeholder = ph; i.style.cssText = `background:#0d0f12;color:#e6e8ea;border:1px solid #262b33;border-radius:5px;padding:4px 6px;width:${w}px;`; return i; };

  const controlRows = []; const previewRows = [];
  const exposable = enumerateExposable(RT.graph);
  if (!exposable.length) { const e = document.createElement('div'); e.style.cssText = 'color:#8a929c;padding:18px 0;'; e.textContent = 'No nodes with controls yet. Add shader / math / source / viewer nodes first.'; body.appendChild(e); }

  for (const item of exposable) {
    const node = item.node;
    const sec = document.createElement('div'); sec.style.cssText = 'border:1px solid #262b33;border-radius:8px;padding:8px 10px;';
    const h = document.createElement('div'); h.textContent = nodeTitle(node);
    h.style.cssText = 'font-weight:600;margin-bottom:6px;color:#cdd3da;';
    const tag = document.createElement('span'); tag.textContent = '  #' + node.id; tag.style.cssText = 'color:#566;font-weight:400;font-size:10px;';
    h.appendChild(tag); sec.appendChild(h);

    for (const w of item.widgets) {
      const existing = findCtrl(node.id, w.name);
      const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!existing;
      const cat = inp(existing ? existing.category : nodeTitle(node), 'Category', 150);
      const lab = inp(existing ? existing.label : w.name, 'Label', 150);
      row.append(cb, lbl(w.name + '  (' + w.type + ')', 170), lbl('Cat', 26), cat, lbl('Label', 34), lab);
      sec.appendChild(row);
      controlRows.push({ nodeId: node.id, widget: w.name, cb, cat, lab });
    }

    if (item.isViewer) {
      const existing = findPrev(node.id);
      const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0 2px;border-top:1px solid #20242b;margin-top:4px;';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!existing;
      const lab = inp(existing ? existing.label : nodeTitle(node), 'Preview label', 150);
      row.append(cb, lbl('▣ Show as preview window', 200), lbl('Label', 34), lab);
      sec.appendChild(row);
      previewRows.push({ nodeId: node.id, cb, lab });
    }
    body.appendChild(sec);
  }

  const foot = document.createElement('div');
  foot.style.cssText = 'padding:12px 16px;border-top:1px solid #262b33;display:flex;align-items:center;gap:8px;';
  const mkBtn = (txt, style) => { const b = document.createElement('button'); b.textContent = txt; b.style.cssText = 'padding:7px 14px;border-radius:6px;cursor:pointer;border:1px solid #262b33;background:#1c2028;color:#e6e8ea;' + (style || ''); return b; };
  const openView = mkBtn('Open published view ↗', 'border-color:#2a5c4a;background:#1d3a30;color:#37d0a0;');
  const spacer = document.createElement('div'); spacer.style.flex = '1';
  const cancel = mkBtn('Cancel');
  const save = mkBtn('Save', 'border-color:#5b8cff;background:#5b8cff;color:#fff;');
  foot.append(openView, spacer, cancel, save);

  box.append(head, body, foot); ov.appendChild(box); document.body.appendChild(ov);
  const close = () => ov.remove();
  cancel.onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };

  const buildConfig = () => {
    const controls = [];
    for (const r of controlRows) if (r.cb.checked) controls.push({ kind: 'widget', nodeId: r.nodeId, widget: r.widget, category: r.cat.value.trim() || 'Controls', label: r.lab.value.trim() || r.widget });
    const previews = [];
    for (const r of previewRows) if (r.cb.checked) previews.push({ nodeId: r.nodeId, label: r.lab.value.trim() || '' });
    return { title: titleInput.value.trim(), controls, previews };
  };
  const persist = () => { RT.graph.extra = RT.graph.extra || {}; RT.graph.extra.endUser = buildConfig(); RT.requestSave(); };

  save.onclick = () => { persist(); RT.toast && RT.toast('End-user UI saved', 'good'); close(); };
  openView.onclick = () => { persist(); // relative — play.html always sits next to index.html, whether that's the
// desktop app's /web/graph/ or a static build's own root, so this needs no
// knowledge of where the page is mounted
window.open('play.html?project=' + encodeURIComponent(RT.project), '_blank'); };
}

// wire the topbar button (DOM is ready: this module is deferred)
const btn = $('authorUiBtn');
if (btn) btn.onclick = openPanel;

// ── Context Menu Patch ────────────────────────────────────────────────────────
if (window.LiteGraph && window.LiteGraph.LGraphCanvas) {
  const origGetNodeMenuOptions = window.LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions;
  
  const getEndUserConfig = () => {
    if (!RT.graph) return { title: '', controls: [], previews: [] };
    return (RT.graph.extra && RT.graph.extra.endUser) || { title: '', controls: [], previews: [] };
  };

  const saveEndUserConfig = (cfg) => {
    if (!RT.graph) return;
    RT.graph.extra = RT.graph.extra || {};
    RT.graph.extra.endUser = cfg;
    RT.requestSave();
    RT.redraw();
  };

  const getWidgetAtPos = (node, canvasX, canvasY) => {
    if (!node.widgets || !node.widgets.length) return null;
    const localX = canvasX - node.pos[0];
    const localY = canvasY - node.pos[1];
    const width = node.size[0];
    for (const w of node.widgets) {
      if (!w || w.disabled || w.last_y === undefined) continue;
      let widget_height = window.LiteGraph.NODE_WIDGET_HEIGHT;
      if (w.computeSize) {
        try {
          const sz = w.computeSize(width);
          if (sz && sz[1] !== undefined) widget_height = sz[1];
        } catch (e) {}
      }
      const widget_width = w.width || width;
      if (localX >= 6 && localX <= widget_width - 12 && localY >= w.last_y && localY <= w.last_y + widget_height) {
        return w;
      }
    }
    return null;
  };

  window.LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions = function(node) {
    let options = origGetNodeMenuOptions.call(this, node);
    if (!node) return options;

    const canvasX = this.graph_mouse[0];
    const canvasY = this.graph_mouse[1];
    const clickedWidget = getWidgetAtPos(node, canvasX, canvasY);
    const extraOptions = [];

    if (clickedWidget) {
      const cfg = getEndUserConfig();
      const idx = (cfg.controls || []).findIndex((c) => c.nodeId === node.id && c.widget === clickedWidget.name);
      if (idx >= 0) {
        extraOptions.push({
          content: `✏️ Edit "${clickedWidget.name}" UI settings...`,
          callback: function() {
            const currentCfg = getEndUserConfig();
            const cIdx = (currentCfg.controls || []).findIndex((c) => c.nodeId === node.id && c.widget === clickedWidget.name);
            if (cIdx < 0) return;
            const existing = currentCfg.controls[cIdx];
            const cat = prompt("Category for this control:", existing.category);
            if (cat === null) return;
            const label = prompt("Label for this control:", existing.label);
            if (label === null) return;
            existing.category = cat.trim() || 'Controls';
            existing.label = label.trim() || clickedWidget.name;
            saveEndUserConfig(currentCfg);
            RT.toast && RT.toast("Updated control settings", "good");
          }
        });
        extraOptions.push({
          content: `❌ Unexpose "${clickedWidget.name}" from UI`,
          callback: function() {
            const currentCfg = getEndUserConfig();
            const cIdx = (currentCfg.controls || []).findIndex((c) => c.nodeId === node.id && c.widget === clickedWidget.name);
            if (cIdx >= 0) {
              currentCfg.controls.splice(cIdx, 1);
              saveEndUserConfig(currentCfg);
              RT.toast && RT.toast("Removed control from end-user UI", "good");
            }
          }
        });
      } else {
        extraOptions.push({
          content: `➕ Expose "${clickedWidget.name}" to End-user UI`,
          callback: function() {
            const nodeTitleVal = node.title || node.type || ('node ' + node.id);
            const cat = prompt("Category for this control:", nodeTitleVal);
            if (cat === null) return;
            const label = prompt("Label for this control:", clickedWidget.name);
            if (label === null) return;
            
            const currentCfg = getEndUserConfig();
            currentCfg.controls = currentCfg.controls || [];
            currentCfg.controls.push({
              kind: 'widget',
              nodeId: node.id,
              widget: clickedWidget.name,
              category: cat.trim() || 'Controls',
              label: label.trim() || clickedWidget.name
            });
            saveEndUserConfig(currentCfg);
            RT.toast && RT.toast("Exposed control to end-user UI", "good");
          }
        });
      }
    }

    // Build the "★ End-user UI" submenu
    const subItems = [];
    
    // 1. Expose Widget submenu option
    subItems.push({
      content: "Expose Widget",
      has_submenu: true,
      callback: function(v, opts, ev, parentMenu) {
        if (!node.widgets || !node.widgets.length) {
          new window.LiteGraph.ContextMenu([{ content: "(No widgets)", disabled: true }], {
            event: ev,
            parentMenu: parentMenu,
            title: "Expose Widget"
          });
          return;
        }
        const cfg = getEndUserConfig();
        const widgetItems = node.widgets.map((w) => {
          const idx = (cfg.controls || []).findIndex((c) => c.nodeId === node.id && c.widget === w.name);
          const isExp = idx >= 0;
          return {
            content: (isExp ? "● " : "○ ") + w.name,
            callback: function() {
              if (isExp) {
                const action = confirm(`"${w.name}" is already exposed.\n\nClick OK to edit Category/Label, or Cancel to unexpose it.`);
                if (action) {
                  const cat = prompt("Category:", cfg.controls[idx].category);
                  if (cat === null) return;
                  const label = prompt("Label:", cfg.controls[idx].label);
                  if (label === null) return;
                  cfg.controls[idx].category = cat.trim() || 'Controls';
                  cfg.controls[idx].label = label.trim() || w.name;
                  saveEndUserConfig(cfg);
                  RT.toast && RT.toast("Updated control settings", "good");
                } else {
                  cfg.controls.splice(idx, 1);
                  saveEndUserConfig(cfg);
                  RT.toast && RT.toast("Removed control from end-user UI", "good");
                }
              } else {
                const nodeTitleVal = node.title || node.type || ('node ' + node.id);
                const cat = prompt("Category for this control:", nodeTitleVal);
                if (cat === null) return;
                const label = prompt("Label for this control:", w.name);
                if (label === null) return;
                cfg.controls = cfg.controls || [];
                cfg.controls.push({
                  kind: 'widget',
                  nodeId: node.id,
                  widget: w.name,
                  category: cat.trim() || 'Controls',
                  label: label.trim() || w.name
                });
                saveEndUserConfig(cfg);
                RT.toast && RT.toast("Exposed control to end-user UI", "good");
              }
            }
          };
        });
        new window.LiteGraph.ContextMenu(widgetItems, {
          event: ev,
          parentMenu: parentMenu,
          title: "Expose Widget"
        });
      }
    });

    // 2. Preview options if it is a ViewerNode
    if (isViewer(node)) {
      const cfg = getEndUserConfig();
      const pIdx = (cfg.previews || []).findIndex((p) => p.nodeId === node.id);
      const isExpPrev = pIdx >= 0;
      if (isExpPrev) {
        subItems.push({
          content: "✏️ Edit preview label...",
          callback: function() {
            const currentCfg = getEndUserConfig();
            const idx = (currentCfg.previews || []).findIndex((p) => p.nodeId === node.id);
            if (idx < 0) return;
            const label = prompt("Preview window label:", currentCfg.previews[idx].label);
            if (label !== null) {
              currentCfg.previews[idx].label = label.trim();
              saveEndUserConfig(currentCfg);
              RT.toast && RT.toast("Updated preview label", "good");
            }
          }
        });
        subItems.push({
          content: "❌ Remove from previews",
          callback: function() {
            const currentCfg = getEndUserConfig();
            const idx = (currentCfg.previews || []).findIndex((p) => p.nodeId === node.id);
            if (idx >= 0) {
              currentCfg.previews.splice(idx, 1);
              saveEndUserConfig(currentCfg);
              RT.toast && RT.toast("Removed viewer from previews", "good");
            }
          }
        });
      } else {
        subItems.push({
          content: "➕ Add as preview window",
          callback: function() {
            const label = prompt("Preview window label:", node.title || 'Preview');
            if (label !== null) {
              const currentCfg = getEndUserConfig();
              currentCfg.previews = currentCfg.previews || [];
              currentCfg.previews.push({
                nodeId: node.id,
                label: label.trim()
              });
              saveEndUserConfig(currentCfg);
              RT.toast && RT.toast("Added viewer as end-user preview", "good");
            }
          }
        });
      }
    }

    subItems.push(null); // separator
    subItems.push({
      content: "Open published view ↗",
      callback: function() {
        // relative — play.html always sits next to index.html, whether that's the
// desktop app's /web/graph/ or a static build's own root, so this needs no
// knowledge of where the page is mounted
window.open('play.html?project=' + encodeURIComponent(RT.project), '_blank');
      }
    });

    extraOptions.push({
      content: "★ End-user UI",
      has_submenu: true,
      callback: function(v, opts, ev, parentMenu) {
        new window.LiteGraph.ContextMenu(subItems, {
          event: ev,
          parentMenu: parentMenu,
          title: "End-user UI"
        });
      }
    });

    extraOptions.push(null); // separator
    options = extraOptions.concat(options);

    return options;
  };
}
