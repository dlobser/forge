// state.js — the single shared store. Holds settings, the open project (effect
// arrays + chain), the gallery, the scanned shader definitions and workflow list,
// and ComfyUI status. Tabs read from here and call S.touch()/S.save() to persist.
import { api } from './api.js';
import { uid } from './ui.js';

export const S = {
  settings: null,
  project: { name: 'Untitled', shaderEffects: [], aiEffects: [], chain: [] },
  projects: [],
  gallery: [],
  shaderDefs: [],        // [{key, def, vertSrc, fragSrc}]
  workflows: [],         // [{key, name, format}]
  comfy: { ok: false, depth: null },
  onChange: null,        // app.js sets this to re-render the active tab
  _defaultVert: '',
  _saveTimer: null,

  get projectName() { return this.settings?.current_project || this.project?.name || 'Untitled'; },

  async init() {
    this.settings = await api.getSettings();
    const pl = await api.listProjects();
    this.projects = pl.projects;
    if (!this.projects.length) {
      this.project = await api.createProject('Untitled');
      this.projects = ['Untitled'];
    } else {
      this.project = await api.getProject();
    }
    await this.loadShaderDefs();
    await Promise.all([this.refreshGallery(), this.refreshWorkflows(), this.refreshComfy()]);
  },

  touch() { this.onChange && this.onChange(); },

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => api.saveProject(this.project).catch(() => {}), 350);
  },

  async refreshGallery() {
    const g = await api.gallery(this.projectName);
    this.gallery = g.images;
    return this.gallery;
  },

  async refreshWorkflows() {
    this.workflows = (await api.workflows()).workflows;
  },

  async refreshComfy() {
    try { this.comfy = await api.comfyStatus(); } catch { this.comfy = { ok: false }; }
  },

  async loadShaderDefs() {
    const { shaders } = await api.shaders();
    this._defaultVert = await (await fetch('/shaders/_fullscreen.vert')).text();
    const defs = [];
    for (const s of shaders) {
      try {
        const mod = await import(s.js + '?t=' + Date.now());
        const def = mod.default || {};
        const fragSrc = s.frag ? await (await fetch(s.frag)).text() : '';
        const vertSrc = s.vert ? await (await fetch(s.vert)).text() : this._defaultVert;
        defs.push({ key: s.key, def, vertSrc, fragSrc });
      } catch (e) { console.warn('shader load failed', s.key, e); }
    }
    this.shaderDefs = defs;
  },

  shaderDef(key) { return this.shaderDefs.find((d) => d.key === key); },

  // ── effect factory helpers ────────────────────────────────────────────────
  newShaderEffect(key) {
    const d = this.shaderDef(key); if (!d) return null;
    const params = {};
    for (const c of d.def.controls || []) params[c.uniform] = c.value;
    return {
      id: uid('fx'), shader: key, name: d.def.name || key,
      color: null, depth: null, params,
      outputSize: 1024, animated: !!d.def.animated, fps: 24, frames: 48,
      simSize: d.def.simSize || 256,   // feedback grid resolution (ignored otherwise)
    };
  },

  newAiEffect(key) {
    const wf = this.workflows.find((w) => w.key === key);
    return { id: uid('ai'), workflow: key, name: wf ? wf.name : key,
             values: {}, images: {}, output: null };
  },

  imageURL(file) { return file ? api.imageURL(this.projectName, file) : null; },
  thumbURL(file) { return file ? api.thumbURL(this.projectName, file) : null; },
};
