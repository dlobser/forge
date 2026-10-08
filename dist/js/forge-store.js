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
// Anything needing ComfyUI — local depth, local AI generate — rejects with a readable
// message that the nodes surface as a toast. The Sequence node doesn't come here for
// video: in this build it encodes in the browser instead (videoexport.js).
(function () {
  'use strict';

  var DB_NAME = 'forge-web';
  // v1 held one graph per project. v2 holds named documents with version history,
  // the same model as the desktop app's projects/<name>/graphs/ (forge_server/graphs.py).
  var DB_VERSION = 2;
  var DEFAULT_PROJECT = 'My Project';
  var DEFAULT_DOC = 'Untitled';
  var MAX_VERSIONS = 50;           // per document; oldest pruned beyond this
  var IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];

  var db = null;
  // filename -> blob: URL. Never revoked while the project is open: a node may still
  // be showing it, and a revoked URL renders as a broken image with no way back.
  var urls = new Map();

  function notAvailable(what) {
    return Promise.reject(new Error(
      what + ' needs the desktop version (it runs ComfyUI/ffmpeg locally)'));
  }

  // An error that handleFetch turns into an HTTP status with a {detail} body, the
  // shape FastAPI's HTTPException gives the desktop build, so filemenu.js shows the
  // same message either way.
  function httpError(status, msg) { var e = new Error(msg); e.status = status; return e; }

  // ── IndexedDB plumbing ─────────────────────────────────────────────────────
  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result, t = req.transaction;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'name' });
        if (!d.objectStoreNames.contains('images')) {
          var s = d.createObjectStore('images', { keyPath: 'id' });
          s.createIndex('project', 'project', { unique: false });
        }
        if (!d.objectStoreNames.contains('docs')) {
          d.createObjectStore('docs', { keyPath: 'id' }).createIndex('project', 'project', { unique: false });
        }
        if (!d.objectStoreNames.contains('versions')) {
          d.createObjectStore('versions', { keyPath: 'id' }).createIndex('doc', 'doc', { unique: false });
        }
        // v1's single graph per project becomes that project's "Untitled" document.
        // Done inside the upgrade transaction, so it either all happens or none does.
        if (d.objectStoreNames.contains('graphs')) {
          t.objectStore('graphs').getAll().onsuccess = function (e) {
            (e.target.result || []).forEach(function (row) {
              if (!row || !row.graph) return;
              t.objectStore('docs').put({
                id: docId(row.project, DEFAULT_DOC), project: row.project,
                name: DEFAULT_DOC, graph: row.graph, mtime: Date.now(),
              });
              t.objectStore('meta').put({ k: 'currentDoc:' + row.project, v: DEFAULT_DOC });
            });
            d.deleteObjectStore('graphs');
          };
        }
      };
      // another tab still has the old version open; the upgrade waits for it
      req.onblocked = function () {
        console.warn('Forge: close other Forge tabs so this one can update its storage');
      };
      req.onsuccess = function () {
        var d = req.result;
        // let a newer build in another tab upgrade instead of hanging behind us
        d.onversionchange = function () { d.close(); };
        resolve(d);
      };
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
  function byIndex(store, index, key) { return wrap(tx(store, 'readonly').index(index).getAll(key)); }
  function countIndex(store, index, key) { return wrap(tx(store, 'readonly').index(index).count(key)); }

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
  // a document name never contains '/', so this can't collide across projects
  function docId(project, name) { return project + '/' + safeName(name); }
  function body(init) { try { return JSON.parse(init.body); } catch (e) { return {}; } }
  function hasImageExt(f) { return IMG_EXTS.indexOf((/\.[^.]*$/.exec(f) || [''])[0].toLowerCase()) >= 0; }
  function baseName(f) { return String(f || '').split(/[\\/]/).pop(); }

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

  // ── graph documents (mirrors forge_server/graphs.py) ───────────────────────
  // A project owns the gallery; graphs are documents inside it, so Save As keeps
  // Source/Import nodes resolving. Versions are written by explicit saves only —
  // the 500ms autosave writes the document but never snapshots it.
  function safeName(name) {
    name = String(name == null ? '' : name).trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
    name = name.replace(/^[. ]+|[. ]+$/g, '');
    return name.slice(0, 80) || DEFAULT_DOC;
  }

  async function getDoc(project, name) { return get('docs', docId(project, name)); }

  async function currentDoc(project) {
    var m = await get('meta', 'currentDoc:' + project);
    if (m && m.v && await getDoc(project, m.v)) return m.v;
    var docs = await listDocs(project);
    return docs.length ? docs[0].name : DEFAULT_DOC;
  }
  function setCurrentDoc(project, name) { return put('meta', { k: 'currentDoc:' + project, v: safeName(name) }); }

  async function listDocs(project) {
    var rows = await byIndex('docs', 'project', project);
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      out.push({
        name: rows[i].name, mtime: rows[i].mtime / 1000,
        size: JSON.stringify(rows[i].graph || {}).length,
        versions: await countIndex('versions', 'doc', rows[i].id),
      });
    }
    out.sort(function (a, b) { return b.mtime - a.mtime; });
    return out;
  }

  // 'Sketch' -> 'Sketch 2' -> 'Sketch 3' … so Save As never silently clobbers
  async function uniqueDoc(project, name) {
    var base = safeName(name);
    if (!await getDoc(project, base)) return base;
    var n = 2;
    while (await getDoc(project, base + ' ' + n)) n++;
    return base + ' ' + n;
  }

  async function loadDoc(project, name) {
    var row = await getDoc(project, name || await currentDoc(project));
    return (row && row.graph) || {};
  }

  async function saveDoc(project, name, graph, snapshot, label) {
    name = safeName(name);
    await put('docs', { id: docId(project, name), project: project, name: name, graph: graph || {}, mtime: Date.now() });
    var made = snapshot ? await writeVersion(project, name, graph || {}, label || '') : null;
    return { ok: true, name: name, version: made };
  }

  async function deleteDoc(project, name) {
    var id = docId(project, name);
    var vs = await byIndex('versions', 'doc', id);
    for (var i = 0; i < vs.length; i++) await del('versions', vs[i].id);
    await del('docs', id);
    var m = await get('meta', 'currentDoc:' + project);
    if (m && safeName(m.v) === safeName(name)) {
      var docs = await listDocs(project);
      if (docs.length) await setCurrentDoc(project, docs[0].name);
    }
  }

  async function renameDoc(project, name, newName) {
    var src = await getDoc(project, name);
    if (!src) throw httpError(404, 'no graph named ' + JSON.stringify(name));
    var nn = await uniqueDoc(project, newName);
    var id = docId(project, nn);
    await put('docs', Object.assign({}, src, { id: id, name: nn }));
    var vs = await byIndex('versions', 'doc', src.id);
    for (var i = 0; i < vs.length; i++) {
      await put('versions', Object.assign({}, vs[i], { id: id + '@' + vs[i].vid, doc: id }));
      await del('versions', vs[i].id);
    }
    await del('docs', src.id);
    var m = await get('meta', 'currentDoc:' + project);
    if (m && safeName(m.v) === src.name) await setCurrentDoc(project, nn);
    return nn;
  }

  // ── versions ───────────────────────────────────────────────────────────────
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  async function writeVersion(project, name, graph, label) {
    var id = docId(project, name), now = new Date();
    var stamp = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
      + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    // two saves in one second must not overwrite each other; zero-padded so ids
    // still sort chronologically as text ('-02' before '-10')
    var vid = stamp, n = 2;
    while (await get('versions', id + '@' + vid)) { vid = stamp + '-' + pad(n); n++; }
    var rec = { id: id + '@' + vid, doc: id, vid: vid, saved: now.toISOString(), label: label, graph: graph };
    await put('versions', rec);
    var vs = (await byIndex('versions', 'doc', id)).sort(function (a, b) { return a.vid < b.vid ? -1 : 1; });
    for (var i = 0; i < vs.length - MAX_VERSIONS; i++) await del('versions', vs[i].id);
    requestPersist();
    return { id: vid, saved: rec.saved, label: label };
  }

  async function listVersions(project, name) {
    var vs = await byIndex('versions', 'doc', docId(project, name));
    vs.sort(function (a, b) { return a.vid < b.vid ? 1 : -1; });
    return vs.map(function (v) {
      return { id: v.vid, saved: v.saved, label: v.label || '', nodes: ((v.graph && v.graph.nodes) || []).length };
    });
  }

  async function loadVersion(project, name, vid) {
    var v = await get('versions', docId(project, name) + '@' + vid);
    if (!v) throw httpError(404, 'no such version');
    return v.graph || {};
  }

  // Snapshot what is there first, so restoring is itself undoable.
  async function restoreVersion(project, name, vid) {
    var graph = await loadVersion(project, name, vid);
    var cur = await getDoc(project, name);
    if (cur && cur.graph) await writeVersion(project, name, cur.graph, 'before restore');
    await saveDoc(project, name, graph, false);
    return graph;
  }

  // Ask the browser not to evict this site's storage under disk pressure. Once,
  // on the first explicit save, which is when someone has shown they mean to keep
  // things. Chrome decides silently; Firefox may ask.
  var persistAsked = false;
  function requestPersist() {
    if (persistAsked) return;
    persistAsked = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); }
    catch (e) {}
  }

  // ── image rename (mirrors projects.rename_image) ───────────────────────────
  // The extension only changes between known image suffixes and the bytes are
  // never re-encoded; a bare name keeps the original suffix.
  async function renameImage(project, file, newName) {
    var rec = await get('images', imgId(project, file));
    if (!rec) throw httpError(404, 'no image named ' + JSON.stringify(file));
    var raw = baseName(String(newName || '').trim());
    var m = /\.[^.]*$/.exec(raw);
    var ext = m && m.index > 0 ? m[0].toLowerCase() : '';
    var stem = ext ? raw.slice(0, -ext.length) : raw;
    stem = Array.from(stem).filter(function (c) { return /[\p{L}\p{N}]/u.test(c) || ' ._-'.indexOf(c) >= 0; }).join('').trim();
    if (!stem) throw httpError(400, 'that name has no usable characters');
    if (IMG_EXTS.indexOf(ext) < 0) ext = (/\.[^.]*$/.exec(rec.filename) || ['.png'])[0];
    var dst = stem + ext;
    if (dst === rec.filename) return entry(rec);
    if (await get('images', imgId(project, dst))) throw httpError(400, dst + ' already exists');
    var moved = Object.assign({}, rec, { id: imgId(project, dst), filename: dst, mtime: Date.now() });
    await put('images', moved);
    await del('images', rec.id);
    var u = urls.get(rec.filename);
    if (u) { urls.delete(rec.filename); urls.set(dst, u); }
    return entry(moved);
  }

  // ── .forge.json bundles (same format as forge_server/bundle.py) ────────────
  // Images ride along as data URLs, so a file exported here opens in the desktop
  // app and the other way round.
  function blobToDataURL(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  function referencedImages(graph) {
    var out = new Set();
    ((graph && graph.nodes) || []).forEach(function (n) {
      var p = n.properties || {};
      ['file', 'output'].forEach(function (k) {
        if (typeof p[k] === 'string' && hasImageExt(p[k])) out.add(baseName(p[k]));
      });
    });
    return out;
  }

  async function collectImages(project, only) {
    var rows = await projectImages(project), out = [];
    for (var i = 0; i < rows.length; i++) {
      if (only && !only.has(rows[i].filename)) continue;
      out.push({ filename: rows[i].filename, kind: rows[i].kind, data: await blobToDataURL(rows[i].blob) });
    }
    return out;
  }

  async function exportGraphBundle(project, name) {
    name = name || await currentDoc(project);
    var graph = await loadDoc(project, name);
    return {
      forge: 1, kind: 'graph', project: project, name: name, graph: graph,
      images: await collectImages(project, referencedImages(graph)),
    };
  }

  async function exportProjectBundle(project) {
    var docs = await listDocs(project), graphs = {};
    for (var i = 0; i < docs.length; i++) graphs[docs[i].name] = await loadDoc(project, docs[i].name);
    var cur = await currentDoc(project);
    return {
      forge: 1, kind: 'project', project: project, current: cur, graphs: graphs,
      graph: graphs[cur] || {},        // what an older web importer looks for
      images: await collectImages(project),
    };
  }

  // Always into a NEW project, so an import can never overwrite open work.
  async function importBundle(payload, projectName) {
    if (!payload || typeof payload !== 'object') throw httpError(400, 'not a Forge file');
    var docs = payload.graphs && typeof payload.graphs === 'object' ? payload.graphs : null;
    if (!docs || !Object.keys(docs).length) {
      if (!payload.graph || typeof payload.graph !== 'object') throw httpError(400, 'not a Forge file — no graph inside');
      docs = {};
      docs[safeName(payload.name || DEFAULT_DOC)] = payload.graph;
    }
    var base = String(projectName || payload.project || 'Imported').trim() || 'Imported';
    var project = base, n = 2;
    while (await get('projects', project)) project = base + ' ' + n++;
    await put('projects', { name: project, created: Date.now() });

    var names = Object.keys(docs);
    for (var i = 0; i < names.length; i++) {
      if (docs[names[i]] && typeof docs[names[i]] === 'object') await saveDoc(project, names[i], docs[names[i]], false);
    }
    var current = payload.current && docs[payload.current] ? payload.current : names[0];
    await setCurrentDoc(project, current);

    var images = 0, list = payload.images || [];
    for (var j = 0; j < list.length; j++) {
      var im = list[j];
      if (!im || typeof im.data !== 'string' || im.data.indexOf(',') < 0) continue;
      try {
        var blob = await (await fetch(im.data)).blob();
        var filename = baseName(im.filename) || 'image.png';
        await put('images', {
          id: imgId(project, filename), project: project, filename: filename,
          kind: im.kind || 'import', blob: blob, mtime: Date.now(), size: blob.size, meta: {},
        });
        images++;
      } catch (e) { /* skip an unreadable image rather than fail the whole import */ }
    }
    return { ok: true, project: project, current: safeName(current), graphs: names.length, images: images };
  }

  // ── fetch router, used by static-shim.js ───────────────────────────────────
  // Returns a Response for routes this store owns, or null to let the shim fall
  // through to the baked /data/*.json (shaders, math nodes, workflow schemas).
  async function handleFetch(url, init) {
    await ready;
    var u = new URL(url, location.href);
    var path = u.pathname;
    var method = ((init && init.method) || 'GET').toUpperCase();
    var q = function (k) { return u.searchParams.get(k); };
    var json = function (o) {
      return new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    };
    try {
      var res = await route(path, method, q, init || {});
      return res === null ? null : json(res);
    } catch (e) {
      return new Response(JSON.stringify({ detail: e.message || String(e) }), {
        status: e.status || 500, headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  async function route(path, method, q, init) {
    var p = method === 'GET' ? {} : body(init);
    var project = (method === 'GET' ? q('project') : p.project) || await currentProject();
    var name;

    switch (path) {
      // documents
      case '/api/graph':
        if (method === 'GET') return loadDoc(project, q('name'));
        return saveDoc(project, p.name || await currentDoc(project), p.graph, !!p.snapshot, p.label);
      case '/api/graphs':
        return { graphs: await listDocs(project), current: await currentDoc(project) };
      case '/api/graphs/select':
        await setCurrentDoc(project, p.name);
        return { ok: true, name: await currentDoc(project), graph: await loadDoc(project, p.name) };
      case '/api/graphs/saveas':
        name = await uniqueDoc(project, p.name);
        await saveDoc(project, name, p.graph, true, 'saved as');
        await setCurrentDoc(project, name);
        return { ok: true, name: name };
      case '/api/graphs/delete':
        if ((await listDocs(project)).length <= 1) throw httpError(400, 'a project needs at least one graph');
        await deleteDoc(project, p.name);
        return { ok: true, current: await currentDoc(project) };
      case '/api/graphs/rename':
        return { ok: true, name: await renameDoc(project, p.name, p.new_name) };

      // versions
      case '/api/graph/versions':
        name = q('name') || await currentDoc(project);
        return { name: name, versions: await listVersions(project, name) };
      case '/api/graph/version':
        return loadVersion(project, q('name') || await currentDoc(project), q('id'));
      case '/api/graph/version/restore':
        return { ok: true, graph: await restoreVersion(project, p.name || await currentDoc(project), p.id) };

      // bundles
      case '/api/export/graph': return exportGraphBundle(project, q('name'));
      case '/api/export/project': return exportProjectBundle(project);
      case '/api/import/bundle': return importBundle(p.payload, p.project);

      // gallery
      case '/api/image/rename': return renameImage(project, p.file, p.new_name);
      case '/api/image/delete': return api.deleteImage(project, p.file);

      // projects + settings
      case '/api/projects': return api.listProjects();
      case '/api/project': return api.getProject();
      case '/api/settings': return api.getSettings();
      case '/api/gallery': return api.gallery(project);
      case '/api/comfy/status': return api.comfyStatus();
      case '/api/projects/select':
      case '/api/projects/create':
        try { return await (path.endsWith('create') ? api.createProject : api.selectProject)(p.name); }
        catch (e) { throw httpError(400, e.message); }
    }
    return null;
  }

  // ── compatibility helpers for callers that predate documents ───────────────
  // Each acts on a project's current document.
  async function loadGraph(project) {
    await ready;
    project = project || await currentProject();
    return loadDoc(project);
  }
  async function saveGraph(project, graph) {
    await ready;
    project = project || await currentProject();
    return saveDoc(project, await currentDoc(project), graph, false);
  }
  async function exportGraph(project) {
    await ready;
    return exportGraphBundle(project || await currentProject());
  }
  async function importGraph(payload, projectName) {
    await ready;
    return (await importBundle(payload, projectName)).project;
  }

  window.ForgeStore = {
    ready: ready, api: api, handleFetch: handleFetch,
    loadGraph: loadGraph, saveGraph: saveGraph,
    exportGraph: exportGraph, importGraph: importGraph,
    currentProject: currentProject,
  };
})();
