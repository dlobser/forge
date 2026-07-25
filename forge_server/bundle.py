"""bundle.py — .forge.json export/import for graphs and whole projects.

Two sizes of bundle, both plain JSON with images inlined as data URLs so a file
is self-contained and survives email, chat or a thumb drive:

  graph bundle    one document + only the gallery images its nodes reference
  project bundle  every document in the project + the whole gallery

The shape matches what the browser build's forge-store.js already reads and
writes ({forge:1, project, graph, images:[{filename,kind,data}]}), so a file
exported from the desktop app opens in the web build and vice versa. A project
bundle adds `graphs` and `current` on top; it also still carries a top-level
`graph` (the current document) purely so the older web importer, which looks for
exactly that key, gets something sensible instead of an error.
"""

from __future__ import annotations

import base64
import json
import mimetypes
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from . import config, graphs, projects

IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


def referenced_images(graph: Dict[str, Any]) -> Set[str]:
    """Filenames a graph's nodes point at (Source `file`, depth/AI `output`)."""
    found: Set[str] = set()
    for node in graph.get("nodes") or []:
        props = node.get("properties") or {}
        for key in ("file", "output"):
            v = props.get(key)
            if isinstance(v, str) and v.lower().endswith(IMG_EXTS):
                found.add(Path(v).name)
    return found


def _data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def _collect_images(s: Dict[str, Any], project: str,
                    only: Optional[Set[str]] = None) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for item in projects.gallery(s, project):
        name = item["filename"]
        if only is not None and name not in only:
            continue
        try:
            path = projects.source_path(s, project, name)
            out.append({"filename": name, "kind": item.get("kind", "import"),
                        "data": _data_url(path)})
        except (OSError, ValueError):
            continue
    return out


# ── export ───────────────────────────────────────────────────────────────────
def export_graph(s: Dict[str, Any], project: str,
                 name: Optional[str] = None) -> Dict[str, Any]:
    name = name or graphs.current(s, project)
    graph = graphs.load(s, project, name)
    return {
        "forge": 1,
        "kind": "graph",
        "project": project,
        "name": name,
        "graph": graph,
        "images": _collect_images(s, project, referenced_images(graph)),
    }


def export_project(s: Dict[str, Any], project: str) -> Dict[str, Any]:
    docs = {d["name"]: graphs.load(s, project, d["name"])
            for d in graphs.list_graphs(s, project)}
    cur = graphs.current(s, project)
    return {
        "forge": 1,
        "kind": "project",
        "project": project,
        "current": cur,
        "graphs": docs,
        # for the web build's importer, which keys off a top-level `graph`
        "graph": docs.get(cur) or {},
        "images": _collect_images(s, project),
    }


# ── import ───────────────────────────────────────────────────────────────────
def _unique_project(s: Dict[str, Any], name: str) -> str:
    base = (name or "Imported").strip() or "Imported"
    if not config.project_dir(s, base).exists():
        return base
    n = 2
    while config.project_dir(s, f"{base} {n}").exists():
        n += 1
    return f"{base} {n}"


def _write_images(s: Dict[str, Any], project: str,
                  images: List[Dict[str, Any]]) -> int:
    paths = config.ensure_project_dirs(s, project)
    folder = paths["sourceimages"]
    written = 0
    for im in images or []:
        data = im.get("data") or ""
        if "," not in data:
            continue
        try:
            raw = base64.b64decode(data.split(",", 1)[1])
        except (ValueError, TypeError):
            continue
        target = folder / Path(im.get("filename") or "image.png").name
        try:
            target.write_bytes(raw)
            written += 1
        except OSError:
            continue
    return written


def import_bundle(s: Dict[str, Any], payload: Dict[str, Any],
                  project_name: Optional[str] = None) -> Dict[str, Any]:
    """Load either bundle kind into a fresh project; never touches an existing one.

    Importing into a new project rather than merging keeps the operation
    non-destructive: whatever you had open is still there afterwards.
    """
    if not isinstance(payload, dict):
        raise ValueError("not a Forge file")
    docs: Dict[str, Any] = payload.get("graphs") or {}
    if not docs:
        graph = payload.get("graph")
        if not isinstance(graph, dict):
            raise ValueError("not a Forge file — no graph inside")
        docs = {graphs.safe_name(payload.get("name") or graphs.DEFAULT_NAME): graph}

    project = _unique_project(s, project_name or payload.get("project") or "Imported")
    # project.json is what makes a folder a project: config.list_projects only
    # returns directories that have one, so an import that merely created the
    # subfolders would land on disk and then be invisible in the project picker.
    config.save_project(s, config.default_project(project))

    for name, graph in docs.items():
        if isinstance(graph, dict):
            graphs.save(s, project, name, graph)
    current = payload.get("current")
    if not current or graphs.safe_name(current) not in \
            {graphs.safe_name(k) for k in docs}:
        current = next(iter(docs))
    graphs.set_current(s, project, current)

    images = _write_images(s, project, payload.get("images") or [])
    return {"ok": True, "project": project, "current": graphs.safe_name(current),
            "graphs": len(docs), "images": images}
