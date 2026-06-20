// api.js — thin wrappers over the Forge REST API.
async function j(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.status === 204 ? null : r.json();
}

export const api = {
  // settings & projects
  getSettings: () => j('GET', '/api/settings'),
  saveSettings: (s) => j('POST', '/api/settings', s),
  listProjects: () => j('GET', '/api/projects'),
  selectProject: (name) => j('POST', '/api/projects/select', { name }),
  createProject: (name) => j('POST', '/api/projects/create', { name }),
  getProject: () => j('GET', '/api/project'),
  saveProject: (p) => j('POST', '/api/project', p),
  comfyStatus: () => j('GET', '/api/comfy/status'),

  // gallery / images
  gallery: (project) => j('GET', `/api/gallery?project=${encodeURIComponent(project)}`),
  depth: (project, file) => j('POST', '/api/depth', { project, file }),
  deleteImage: (project, file) => j('POST', '/api/image/delete', { project, file }),
  imageURL: (project, file) => `/api/image?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`,
  thumbURL: (project, file) => `/api/thumb?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`,
  async importImage(project, file, reformat, size) {
    const fd = new FormData();
    fd.append('file', file); fd.append('project', project);
    fd.append('reformat', reformat ? 'true' : 'false'); fd.append('size', String(size));
    const r = await fetch('/api/import', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },

  // shaders
  shaders: () => j('GET', '/api/shaders'),
  async renderSave(project, name, blob, meta) {
    const fd = new FormData();
    fd.append('file', blob, 'render.png'); fd.append('project', project);
    fd.append('name', name); fd.append('meta', JSON.stringify(meta || {}));
    const r = await fetch('/api/render/save', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async seqFrame(project, name, index, blob) {
    const fd = new FormData();
    fd.append('file', blob, 'frame.png'); fd.append('project', project);
    fd.append('name', name); fd.append('index', String(index));
    const r = await fetch('/api/sequence/frame', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  seqClear: (project, name) => j('POST', '/api/sequence/clear', { project, name }),
  sequences: (project) => j('GET', `/api/sequences?project=${encodeURIComponent(project)}`),
  videoCommand: (project, name, fps) =>
    j('GET', `/api/video/command?project=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}${fps ? `&fps=${fps}` : ''}`),
  videoMake: (project, name, fps) => j('POST', '/api/video/make', { project, name, fps }),

  // AI workflows
  workflows: () => j('GET', '/api/workflows'),
  workflowSchema: (key) => j('GET', `/api/workflow/schema?key=${encodeURIComponent(key)}`),
  saveSidecar: (key, data) => j('POST', '/api/workflow/sidecar', { key, data }),
  generate: (req) => j('POST', '/api/ai/generate', req),
};
