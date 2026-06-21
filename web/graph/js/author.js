// author.js — the editor-side "Author UI" panel. Lets the author choose which node
// widgets become end-user controls (with a category + label) and which Viewer nodes
// become preview windows, plus a front-end title. The result is stored in
// RT.graph.extra.endUser and persisted by the normal graph save; the published page
// (play.html) reads it. Loaded alongside graphApp.js; it imports the same RT
// singleton and wires its own button, so graphApp.js stays untouched.
import { RT } from './runtime.js';
import { enumerateExposable } from './endui.js';

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
  openView.onclick = () => { persist(); window.open('/web/graph/play.html?project=' + encodeURIComponent(RT.project), '_blank'); };
}

// wire the topbar button (DOM is ready: this module is deferred)
const btn = $('authorUiBtn');
if (btn) btn.onclick = openPanel;
