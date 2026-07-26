"""
server.py — FastAPI app. Serves the Forge front-end and exposes the REST API the
browser drives.

Run:  python -m forge_server.server          ->  http://127.0.0.1:8191
      python -m forge_server.server --port N

Layout served:
    /              -> web/graph/index.html (node view, the default)
    /play.html     -> web/graph/play.html (the authored end-user front-end)
    /classic       -> web/index.html (original chain view)
    /web/*         -> web/ (js, css)
    /shaders/*     -> shaders/ (the .vert/.frag/.js triplets, scanned + imported
                      directly by the browser)
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import bundle, config, depth, graphs, projects, video, workflows
from .comfy import ComfyClient, ComfyError

ROOT = config.ROOT
WEB_DIR = ROOT / "web"

app = FastAPI(title="Forge")
_settings: Dict[str, Any] = config.load_settings()
_comfy_cache: Dict[str, ComfyClient] = {}


@app.middleware("http")
async def no_cache(request, call_next):
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


def comfy() -> ComfyClient:
    c = _settings["comfy"]
    key = f'{c["host"]}:{c["port"]}'
    if key not in _comfy_cache:
        _comfy_cache.clear()
        _comfy_cache[key] = ComfyClient(c["host"], c["port"])
    return _comfy_cache[key]


def current_project() -> str:
    return _settings.get("current_project", "Untitled")


# ── settings ─────────────────────────────────────────────────────────────────
@app.get("/api/settings")
def get_settings():
    return _settings


@app.post("/api/settings")
def set_settings(body: Dict[str, Any]):
    global _settings
    _settings = config._merge(_settings, body)
    config.save_settings(_settings)
    _comfy_cache.clear()
    return _settings


# ── projects ─────────────────────────────────────────────────────────────────
class ProjectReq(BaseModel):
    name: str


@app.get("/api/projects")
def list_projects():
    return {"projects": config.list_projects(_settings), "current": current_project()}


@app.post("/api/projects/select")
def select_project(req: ProjectReq):
    global _settings
    _settings["current_project"] = req.name
    config.save_settings(_settings)
    return config.load_project(_settings, req.name)


@app.post("/api/projects/create")
def create_project(req: ProjectReq):
    global _settings
    prj = config.default_project(req.name)
    config.save_project(_settings, prj)
    _settings["current_project"] = req.name
    config.save_settings(_settings)
    return prj


@app.get("/api/project")
def get_project():
    return config.load_project(_settings, current_project())


@app.post("/api/project")
def save_project(body: Dict[str, Any]):
    body.setdefault("name", current_project())
    config.save_project(_settings, body)
    return {"ok": True}


# ── comfy status ─────────────────────────────────────────────────────────────
@app.get("/api/comfy/status")
def comfy_status():
    c = comfy()
    ok = c.ping()
    info: Dict[str, Any] = {"ok": ok}
    if ok:
        try:
            info["depth"] = depth.describe(_settings, c)
        except ComfyError:
            info["depth"] = None
    return info


# ── gallery / images ─────────────────────────────────────────────────────────
@app.get("/api/gallery")
def api_gallery(project: Optional[str] = None):
    return {"images": projects.gallery(_settings, project or current_project())}


@app.post("/api/import")
async def api_import(file: UploadFile = File(...), project: str = Form(None),
                     reformat: bool = Form(False), size: int = Form(1024)):
    data = await file.read()
    try:
        return projects.import_image(_settings, project or current_project(), data,
                                     file.filename or "image.png", reformat, size)
    except RuntimeError as e:
        raise HTTPException(400, str(e))


@app.get("/api/image")
def api_image(project: str = Query(...), file: str = Query(...)):
    try:
        p = projects.source_path(_settings, project, file)
    except ValueError:
        raise HTTPException(403, "bad path")
    if not p.exists():
        raise HTTPException(404, "not found")
    return FileResponse(p, headers={"Cache-Control": "no-cache"})


@app.get("/api/thumb")
def api_thumb(project: str = Query(...), file: str = Query(...), size: int = 256):
    t = projects.thumb(_settings, project, file, size)
    if not t or not t.exists():
        raise HTTPException(404, "not found")
    return FileResponse(t, headers={"Cache-Control": "no-cache"})


# ── remote image proxy ───────────────────────────────────────────────────────
# The URL Image node textures a remote image, which WebGL only allows if the host
# sends CORS headers. Plenty of hosts don't — and some (imgur among them) refuse a
# request whose Referer is a localhost dev server, so the same URL that works from
# a deployed static build fails here. Re-serving the bytes from this origin makes
# the request same-origin, where CORS doesn't apply at all. The front-end only
# reaches for this after a direct load has already failed.
#
# Scoped deliberately: http(s) only, and never a private/loopback address, so this
# can't be used to read the machine's own network from the browser.
@app.get("/api/proxy_image")
def api_proxy_image(url: str = Query(..., min_length=8, max_length=4096)):
    import ipaddress
    import socket
    import urllib.error
    import urllib.parse
    import urllib.request

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(400, "only http(s) URLs")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except OSError:
        raise HTTPException(502, "cannot resolve host")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(403, "refusing to proxy a private address")

    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Forge)",
        "Accept": "image/*,*/*;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = r.headers.get("Content-Type", "application/octet-stream")
            data = r.read(64 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"remote host said {e.code}")
    except (urllib.error.URLError, OSError) as e:
        raise HTTPException(502, f"fetch failed: {e}")
    if not ctype.startswith("image/"):
        raise HTTPException(415, f"not an image ({ctype})")
    return Response(content=data, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=3600",
                             "Access-Control-Allow-Origin": "*"})


class DepthReq(BaseModel):
    project: Optional[str] = None
    file: str


@app.post("/api/depth")
def api_depth(req: DepthReq):
    project = req.project or current_project()
    src = projects.source_path(_settings, project, req.file)
    if not src.exists():
        raise HTTPException(404, "source not found")
    try:
        png = depth.generate(_settings, comfy(), src.read_bytes(), req.file)
    except ComfyError as e:
        raise HTTPException(502, f"ComfyUI: {e}")
    out = projects.save_image(_settings, project, png, f"{Path(req.file).stem}_depth",
                              "depth", {"source": req.file})
    return out


class DeleteReq(BaseModel):
    project: Optional[str] = None
    file: str


class RenameImageReq(BaseModel):
    project: Optional[str] = None
    file: str
    new_name: str


# Renaming an image breaks any node that referenced it by name, so the front-end
# rewrites those references in the open graph after a successful rename — see
# renameFile() in filemenu.js. Graphs in OTHER documents keep the old name and will
# report a failed load, which is honest: there is no way to find every graph in every
# project that might mention this file.
@app.post("/api/image/rename")
def api_rename_image(req: RenameImageReq):
    project = req.project or current_project()
    try:
        return projects.rename_image(_settings, project, req.file, req.new_name)
    except FileNotFoundError:
        raise HTTPException(404, f"no image named {req.file!r}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except OSError as e:
        raise HTTPException(500, f"rename failed: {e}")


@app.post("/api/image/delete")
def api_delete(req: DeleteReq):
    project = req.project or current_project()
    p = projects.source_path(_settings, project, req.file)
    for f in (p, p.with_suffix(p.suffix + ".json")):
        try:
            f.unlink()
        except OSError:
            pass
    return {"ok": True}


# ── shaders ──────────────────────────────────────────────────────────────────
@app.get("/api/shaders")
def api_shaders():
    d = config.shaders_dir(_settings)
    out = []
    if d.exists():
        for js in sorted(d.glob("*.js")):
            key = js.stem
            if key.startswith("_"):
                continue
            out.append({
                "key": key,
                "js": f"/shaders/{js.name}",
                "frag": f"/shaders/{key}.frag" if (d / f"{key}.frag").exists() else None,
                "vert": f"/shaders/{key}.vert" if (d / f"{key}.vert").exists() else None,
            })
    return {"shaders": out}


@app.get("/api/mathnodes")
def api_mathnodes():
    d = config.mathnodes_dir(_settings)
    out = []
    for js in sorted(d.glob("*.js")):
        if js.stem.startswith("_"):
            continue
        out.append({"key": js.stem, "js": f"/mathnodes/{js.name}"})
    return {"mathnodes": out}


# ── shader render outputs (PNG from the browser canvas) ──────────────────────
@app.post("/api/render/save")
async def api_render_save(file: UploadFile = File(...), project: str = Form(None),
                          name: str = Form("render"), meta: str = Form("{}")):
    data = await file.read()
    try:
        meta_obj = json.loads(meta)
    except json.JSONDecodeError:
        meta_obj = {}
    return projects.save_image(_settings, project or current_project(), data, name,
                               "shader", meta_obj)


@app.post("/api/sequence/frame")
async def api_seq_frame(file: UploadFile = File(...), project: str = Form(None),
                        name: str = Form("sequence"), index: int = Form(0)):
    data = await file.read()
    fn = video.save_frame(_settings, project or current_project(), name, index, data)
    return {"ok": True, "frame": fn}


class SeqReq(BaseModel):
    project: Optional[str] = None
    name: str


@app.post("/api/sequence/clear")
def api_seq_clear(req: SeqReq):
    video.clear_sequence(_settings, req.project or current_project(), req.name)
    return {"ok": True}


@app.get("/api/sequences")
def api_sequences(project: Optional[str] = None):
    return {"sequences": video.list_sequences(_settings, project or current_project())}


class VideoReq(BaseModel):
    project: Optional[str] = None
    name: str
    fps: Optional[int] = None


@app.get("/api/video/command")
def api_video_command(project: Optional[str] = None, name: str = Query(...),
                      fps: Optional[int] = None):
    return video.resolve_command(_settings, project or current_project(), name, fps)


@app.post("/api/video/make")
def api_video_make(req: VideoReq):
    return video.make_video(_settings, req.project or current_project(), req.name, req.fps)


# ── AI workflows ─────────────────────────────────────────────────────────────
@app.get("/api/workflows")
def api_workflows():
    return {"workflows": workflows.scan(_settings)}


@app.get("/api/workflow/schema")
def api_workflow_schema(key: str = Query(...)):
    c = comfy()
    object_info = None
    try:
        if c.ping():
            object_info = c.object_info()
    except ComfyError:
        object_info = None
    try:
        return workflows.build_schema(_settings, key, object_info)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


class SidecarReq(BaseModel):
    key: str
    data: Dict[str, Any]


@app.post("/api/workflow/sidecar")
def api_workflow_sidecar(req: SidecarReq):
    workflows.save_sidecar(_settings, req.key, req.data)
    return {"ok": True}


class GenerateReq(BaseModel):
    project: Optional[str] = None
    key: str
    name: Optional[str] = None
    values: Dict[str, Any] = {}
    images: Dict[str, str] = {}   # slotId -> gallery filename


@app.post("/api/ai/generate")
def api_generate(req: GenerateReq):
    project = req.project or current_project()
    c = comfy()
    if not c.ping():
        raise HTTPException(502, "ComfyUI is not reachable")
    try:
        object_info = c.object_info()
    except ComfyError:
        object_info = None
    try:
        raw = workflows._load_raw(_settings, req.key)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    api_graph, _ = workflows.to_api(raw, object_info)
    schema = workflows.build_schema(_settings, req.key, object_info)

    # upload any chosen gallery images, map slotId -> comfy input name
    image_names: Dict[str, str] = {}
    for slot_id, filename in (req.images or {}).items():
        if not filename:
            continue
        src = projects.source_path(_settings, project, filename)
        if src.exists():
            image_names[slot_id] = c.upload_image(src.read_bytes(), f"forge_{filename}")

    graph = workflows.patch(api_graph, schema, req.values or {}, image_names)
    try:
        png, _ = c.run_and_fetch(graph)
    except ComfyError as e:
        raise HTTPException(502, f"ComfyUI: {e}")
    name = req.name or req.key
    return projects.save_image(_settings, project, png, name, "ai",
                               {"workflow": req.key, "values": req.values,
                                "images": req.images})


# ── node graph documents ─────────────────────────────────────────────────────
# A project is a workspace; graphs are documents inside it (see graphs.py). This
# never touches project.json. GET /api/graph without a `name` returns the current
# document, which is what the published player asks for and how this behaved
# before documents existed.
@app.get("/api/graph")
def api_get_graph(project: Optional[str] = None, name: Optional[str] = None):
    return graphs.load(_settings, project or current_project(), name)


class GraphReq(BaseModel):
    project: Optional[str] = None
    name: Optional[str] = None
    graph: Dict[str, Any]
    snapshot: bool = False       # explicit Save also writes a version
    label: str = ""


@app.post("/api/graph")
def api_save_graph(req: GraphReq):
    project = req.project or current_project()
    name = req.name or graphs.current(_settings, project)
    return graphs.save(_settings, project, name, req.graph,
                       snapshot=req.snapshot, label=req.label)


@app.get("/api/graphs")
def api_list_graphs(project: Optional[str] = None):
    project = project or current_project()
    return {"graphs": graphs.list_graphs(_settings, project),
            "current": graphs.current(_settings, project)}


class GraphNameReq(BaseModel):
    project: Optional[str] = None
    name: str


@app.post("/api/graphs/select")
def api_select_graph(req: GraphNameReq):
    project = req.project or current_project()
    graphs.set_current(_settings, project, req.name)
    return {"ok": True, "name": graphs.current(_settings, project),
            "graph": graphs.load(_settings, project, req.name)}


class SaveAsReq(BaseModel):
    project: Optional[str] = None
    name: str
    graph: Dict[str, Any]


@app.post("/api/graphs/saveas")
def api_save_as(req: SaveAsReq):
    """Save under a new document name in the same project, then switch to it.

    Same project on purpose: the gallery lives at project level, so Source and
    Import nodes keep resolving in the copy.
    """
    project = req.project or current_project()
    name = graphs.unique_name(_settings, project, req.name)
    graphs.save(_settings, project, name, req.graph, snapshot=True, label="saved as")
    graphs.set_current(_settings, project, name)
    return {"ok": True, "name": name}


@app.post("/api/graphs/delete")
def api_delete_graph(req: GraphNameReq):
    project = req.project or current_project()
    if len(graphs.list_graphs(_settings, project)) <= 1:
        raise HTTPException(400, "a project needs at least one graph")
    graphs.delete(_settings, project, req.name)
    return {"ok": True, "current": graphs.current(_settings, project)}


class RenameReq(BaseModel):
    project: Optional[str] = None
    name: str
    new_name: str


@app.post("/api/graphs/rename")
def api_rename_graph(req: RenameReq):
    project = req.project or current_project()
    try:
        return {"ok": True, "name": graphs.rename(_settings, project,
                                                  req.name, req.new_name)}
    except FileNotFoundError:
        raise HTTPException(404, f"no graph named {req.name!r}")


# ── version history ──────────────────────────────────────────────────────────
@app.get("/api/graph/versions")
def api_list_versions(project: Optional[str] = None, name: Optional[str] = None):
    project = project or current_project()
    name = name or graphs.current(_settings, project)
    return {"name": name, "versions": graphs.list_versions(_settings, project, name)}


@app.get("/api/graph/version")
def api_get_version(id: str, project: Optional[str] = None,
                    name: Optional[str] = None):
    project = project or current_project()
    name = name or graphs.current(_settings, project)
    try:
        return graphs.load_version(_settings, project, name, id)
    except FileNotFoundError:
        raise HTTPException(404, "no such version")


class VersionReq(BaseModel):
    project: Optional[str] = None
    name: Optional[str] = None
    id: str


@app.post("/api/graph/version/restore")
def api_restore_version(req: VersionReq):
    project = req.project or current_project()
    name = req.name or graphs.current(_settings, project)
    try:
        return {"ok": True, "graph": graphs.restore_version(
            _settings, project, name, req.id)}
    except FileNotFoundError:
        raise HTTPException(404, "no such version")


# ── .forge.json bundles ──────────────────────────────────────────────────────
@app.get("/api/export/graph")
def api_export_graph(project: Optional[str] = None, name: Optional[str] = None):
    return bundle.export_graph(_settings, project or current_project(), name)


@app.get("/api/export/project")
def api_export_project(project: Optional[str] = None):
    return bundle.export_project(_settings, project or current_project())


class ImportReq(BaseModel):
    payload: Dict[str, Any]
    project: Optional[str] = None


@app.post("/api/import/bundle")
def api_import_bundle(req: ImportReq):
    try:
        return bundle.import_bundle(_settings, req.payload, req.project)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ── static front-end ─────────────────────────────────────────────────────────
@app.get("/")
def index():
    # Forge is node-only going forward: the graph view is the default front-end.
    return FileResponse(WEB_DIR / "graph" / "index.html")


# The authored end-user front-end. author.js opens this with a *relative* URL
# ('play.html'), because in a static export index.html and play.html really are
# siblings at the site root. Here the editor is served from "/" while the file
# itself lives at /web/graph/play.html, so that relative link lands on "/play.html"
# — which is why it used to 404. Serve the file there so the same relative link
# works in both deployments.
@app.get("/play.html")
@app.get("/play")
def play():
    return FileResponse(WEB_DIR / "graph" / "play.html")


@app.get("/classic")
def classic():
    # The original chain-based UI, kept around but no longer the default.
    return FileResponse(WEB_DIR / "index.html")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


app.mount("/web", StaticFiles(directory=str(WEB_DIR)), name="web")
app.mount("/shaders", StaticFiles(directory=str(config.shaders_dir(_settings))), name="shaders")
app.mount("/mathnodes", StaticFiles(directory=str(config.mathnodes_dir(_settings))), name="mathnodes")


def main():
    import sys
    import uvicorn
    host = os.environ.get("FORGE_HOST", "127.0.0.1")
    port = int(os.environ.get("FORGE_PORT", "8191"))
    if "--port" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except (ValueError, IndexError):
            pass
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
