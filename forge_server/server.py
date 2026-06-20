"""
server.py — FastAPI app. Serves the Forge front-end and exposes the REST API the
browser drives.

Run:  python -m forge_server.server          ->  http://127.0.0.1:8191
      python -m forge_server.server --port N

Layout served:
    /              -> web/index.html
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

from . import config, depth, projects, video, workflows
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


# ── node graph (Forge Graph version) — its own file, never touches project.json ──
@app.get("/api/graph")
def api_get_graph(project: Optional[str] = None):
    p = config.project_dir(_settings, project or current_project()) / "graph.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


class GraphReq(BaseModel):
    project: Optional[str] = None
    graph: Dict[str, Any]


@app.post("/api/graph")
def api_save_graph(req: GraphReq):
    base = config.project_dir(_settings, req.project or current_project())
    base.mkdir(parents=True, exist_ok=True)
    (base / "graph.json").write_text(json.dumps(req.graph, indent=2), encoding="utf-8")
    return {"ok": True}


# ── static front-end ─────────────────────────────────────────────────────────
@app.get("/")
def index():
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
