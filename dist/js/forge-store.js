// forge-store.js — the browser-local backend for the published web build.
//
// The desktop app keeps projects, graphs and images in `projects/<name>/` on disk
// and reaches them over the REST API. On the web there is no server and no shared
// disk, so this file reimplements that same surface on top of IndexedDB: every
// visitor gets a private workspace inside their own browser, and nothing they make
// is ever uploaded anywhere.
//
// Loaded as a CLASSIC script (not a module) so it is guaranteed to have installed
// `window.ForgeStore` before static-shim.js and the module graph boot. Two consumers:
//
//   static-shim.js  routes fetch('/api/…') here (graphApp saves the graph that way)
//   api.js          gets `Object.assign(api, ForgeStore.api)` appended at export time
//
// Anything needing a GPU or a native binary — ComfyUI depth, AI generate, ffmpeg
// video — rejects with a readable message that the nodes surface as a toast.
(function () {
  'use strict';

  var DB_NAME = 'forge-web';
  var DB_VERSION = 1;
  var DEFAULT_PROJECT = 'My Project';
  var IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];

  var db = null;
  // filename -> blob: URL. Never revoked while the project is open: a node may still
  // be showing it, and a revoked URL renders as a broken image with no way back.
  var urls = new Map();

  function notAvailable(what) {
    return Promise.reject(new Error(
      what + ' needs the desktop version (it runs ComfyUI/ffmpeg locally)'));
  }

  // ── IndexedDB plumbing ─────────────────────────────────────────────────────
  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'name' });
        if (!d.objectStoreNames.contains('graphs')) d.createObjectStore('graphs', { keyPath: 'project' });
        if (!d.objectStoreNames.contains('images')) {
          var s = d.createObjectStore('images', { keyPath: 'id' });
          s.createIndex('project', 'project', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }

  function wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function get(store, key) { return wrap(tx(store, 'readonly').get(key)); }
  function put(store, val) { return wrap(tx(store, 'readwrite').put(val)); }
  function del(store, key) { return wrap(tx(store, 'readwrite').delete(key)); }
  function all(store) { return wrap(tx(store, 'readonly').getAll()); }

  // ── boot: open the db, guarantee one project exists ────────────────────────
  var ready = (async function () {
    db = await open();
    var projects = await all('projects');
    if (!projects.length) {
      await put('projects', { name: DEFAULT_PROJECT, created: Date.now() });
      await put('meta', { k: 'currentProject', v: DEFAULT_PROJECT });
    }
    return true;
  })();

  // ── helpers ────────────────────────────────────────────────────────────────
  function slug(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'x'; }
  function imgId(project, filename) { return project + '/' + filename; }

  async function currentProject() {
    var m = await get('meta', 'currentProject');
    if (m && m.v) return m.v;
    var p = await all('projects');
    return (p[0] && p[0].name) || DEFAULT_PROJECT;
  }

  async function projectImages(project) {
    var idx = db.transaction('images', 'readonly').objectStore('images').index('project');
    return wrap(idx.getAll(project));
  }

  function urlFor(rec) {
    var u = urls.get(rec.filename);
    if (!u) { u = URL.createObjectURL(rec.blob); urls.set(rec.filename, u); }
    return u;
  }

  // Mirrors projects.entry() so gallery consumers see the shape they expect.
  function entry(rec) {
    var u = urlFor(rec);
    return {
      filename: rec.filename, url: u, thumb: u, kind: rec.kind,
      mtime: rec.mtime / 1000, size: rec.size, meta: rec.meta || {},
    };
  }

  async function uniqueName(project, stem, ext) {
    var existing = new Set((await projectImages(project)).map(function (r) { return r.filename; }));
    var cand = stem + ext, i = 1;
    while (existing.has(cand)) { cand = stem + '_' + i + ext; i++; }
    return cand;
  }

  async function storeBlob(project, blob, stem, ext, kind, meta) {
    var filename = await uniqueName(project, stem, ext);
    var rec = {
      id: imgId(project, filename), project: project, filename: filename,
      kind: kind, blob: blob, mtime: Date.now(), size: blob.size, meta: meta || {},
    };
    await put('images', rec);
    return entry(rec);
  }

  // center-crop to a square and resize — the browser equivalent of PIL's crop_scale
  async function squarePNG(file, size) {
    var bmp = await createImageBitmap(file);
    var s = Math.min(bmp.width, bmp.height);
    var cv = document.createElement('canvas');
    cv.width = cv.height = size || 1024;
    var ctx = cv.getContext('2d');
    ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, cv.width, cv.height);
    bmp.close && bmp.close();
    return new Promise(function (res) { cv.toBlob(res, 'image/png'); });
  }

  // ── the api surface (mirrors web/js/api.js) ────────────────────────────────
  var api = {
    getSettings: async function () {
      await ready;
      return { current_project: await currentProject(), web: true };
    },
    saveSettings: async function () { await ready; return { ok: true }; },

    listProjects: async function () {
      await ready;
      var rows = await all('projects');
      rows.sort(function (a, b) { return a.name.localeCompare(b.name); });
      return { projects: rows.map(function (r) { return r.name; }), current: await currentProject() };
    },
    selectProject: async function (name) {
      await ready;
      await put('meta', { k: 'currentProject', v: name });
      urls.clear();                       // next gallery() re-mints URLs for the new project
      return { ok: true };
    },
    createProject: async function (name) {
      await ready;
      name = String(name || '').trim();
      if (!name) throw new Error('project name required');
      if (await get('projects', name)) throw new Error('project already exists');
      await put('projects', { name: name, created: Date.now() });
      await put('meta', { k: 'currentProject', v: name });
      return { ok: true, name: name };
    },
    getProject: async function () {
      await ready;
      var name = await currentProject();
      return { name: name, effects: [], chain: [] };
    },
    saveProject: async function () { await ready; return { ok: true }; },

    comfyStatus: async function () { return { ok: false, reason: 'web build' }; },

    gallery: async function (project) {
      await ready;
      var rows = await projectImages(project || await currentProject());
      rows.sort(function (a, b) { return b.mtime - a.mtime; });
      return { images: rows.map(entry) };
    },
    deleteImage: async function (project, file) {
      await ready;
      await del('images', imgId(project, file));
      var u = urls.get(file);
      if (u) { URL.revokeObjectURL(u); urls.delete(file); }
      return { ok: true };
    },
    // Synchronous by contract (nodes feed it straight to img.src), so it can only
    // read the cache gallery() filled. A miss renders as a transparent pixel
    // rather than a console full of 404s.
    imageURL: function (_project, file) {
      return urls.get(file)
        || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    },
    thumbURL: function (project, file) { return api.imageURL(project, file); },

    importImage: async function (project, file, reformat, size) {
      await ready;
      project = project || await currentProject();
      var ext = '.png', blob = file;
      if (reformat) {
        blob = await squarePNG(file, size || 1024);
      } else {
        var m = /\.[A-Za-z0-9]+$/.exec(file.name || '');
        ext = m && IMG_EXTS.indexOf(m[0].toLowerCase()) >= 0 ? m[0].toLowerCase() : '.png';
      }
      var stem = slug(project) + '_' + slug((file.name || 'image').replace(/\.[^.]*$/, ''));
      return storeBlob(project, blob, stem, ext, 'import',
                       { original: file.name, reformatted: !!reformat });
    },

    renderSave: async function (project, name, blob, meta) {
      await ready;
      project = project || await currentProject();
      var prefix = slug(project), nm = slug(name);
      var stem = nm.indexOf(prefix) === 0 ? nm : prefix + '__' + nm;
      return storeBlob(project, blob, stem, '.png', 'shader', meta);
    },

    depth: function () { return notAvailable('Depth generation'); },
    generate: function () { return notAvailable('AI generate'); },
    seqClear: function () { return notAvailable('Sequence rendering'); },
    seqFrame: function () { return notAvailable('Sequence rendering'); },
    sequences: async function () { return { sequences: [] }; },
    videoCommand: function () { return notAvailable('Video encoding'); },
    videoMake: function () { return notAvailable('Video encoding'); },
    saveSidecar: async function () { return { ok: true }; },
  };

  // ── graph load/save (graphApp uses raw fetch for these) ────────────────────
  async function loadGraph(project) {
    await ready;
    var row = await get('graphs', project || await currentProject());
    return (row && row.graph) || {};
  }
  async function saveGraph(project, graph) {
    await ready;
    await put('graphs', { project: project || await currentProject(), graph: graph });
    return { ok: true };
  }

  // ── fetch router, used by static-shim.js ───────────────────────────────────
  // Returns a Response for routes this store owns, or null to let the shim fall
  // through to the baked /data/*.json (shaders, math nodes, workflow schemas).
  async function handleFetch(url, init) {
    var u = new URL(url, location.href);
    var path = u.pathname;
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = init && init.body;
    var json = function (o) {
      return new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    };

    if (path === '/api/graph') {
      if (method === 'GET') return json(await loadGraph(u.searchParams.get('project')));
      var payload = {};
      try { payload = JSON.parse(body); } catch (e) {}
      return json(await saveGraph(payload.project, payload.graph));
    }
    if (path === '/api/projects') return json(await api.listProjects());
    if (path === '/api/project') return json(await api.getProject());
    if (path === '/api/settings') return json(await api.getSettings());
    if (path === '/api/gallery') return json(await api.gallery(u.searchParams.get('project')));
    if (path === '/api/comfy/status') return json(await api.comfyStatus());
    if (path === '/api/projects/select' || path === '/api/projects/create') {
      var p = {};
      try { p = JSON.parse(body); } catch (e) {}
      var fn = path.endsWith('create') ? api.createProject : api.selectProject;
      try { return json(await fn(p.name)); }
      catch (e) { return new Response(e.message, { status: 400 }); }
    }
    return null;
  }

  // ── export / import a graph as a file, so work survives a cleared cache ────
  async function exportGraph(project) {
    await ready;
    project = project || await currentProject();
    var graph = await loadGraph(project);
    var images = await projectImages(project);
    // inline the images so a shared .json is self-contained
    var payload = { forge: 1, project: project, graph: graph, images: [] };
    for (var i = 0; i < images.length; i++) {
      payload.images.push({
        filename: images[i].filename, kind: images[i].kind,
        data: await blobToDataURL(images[i].blob),
      });
    }
    return payload;
  }

  function blobToDataURL(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  async function importGraph(payload, projectName) {
    await ready;
    if (!payload || !payload.graph) throw new Error('not a Forge graph file');
    var name = projectName || payload.project || 'Imported';
    var existing = await get('projects', name);
    if (existing) name = name + ' ' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    await put('projects', { name: name, created: Date.now() });
    await saveGraph(name, payload.graph);
    for (var i = 0; i < (payload.images || []).length; i++) {
      var im = payload.images[i];
      var blob = await (await fetch(im.data)).blob();
      await put('images', {
        id: imgId(name, im.filename), project: name, filename: im.filename,
        kind: im.kind || 'import', blob: blob, mtime: Date.now(), size: blob.size, meta: {},
      });
    }
    await put('meta', { k: 'currentProject', v: name });
    return name;
  }

  window.ForgeStore = {
    ready: ready, api: api, handleFetch: handleFetch,
    loadGraph: loadGraph, saveGraph: saveGraph,
    exportGraph: exportGraph, importGraph: importGraph,
    currentProject: currentProject,
  };
})();
