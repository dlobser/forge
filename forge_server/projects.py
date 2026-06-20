"""
projects.py — the shared image pool every shader and workflow draws from.

Each project is a folder under <projects_dir>:

    <Project>/
        project.json          (effect arrays + chain; see config.py)
        sourceimages/         (imported, shader-rendered, and AI-generated images)
        sequences/<name>/      (animation frame dumps awaiting ffmpeg)
        videos/               (encoded mp4s)
        .thumbs/              (cached gallery thumbnails)

Imported files are saved with the project name prepended, per the spec. Cropping
& scaling to a square is OPTIONAL (reformat flag). Every image gets a sidecar
`<file>.json` recording where it came from (import / shader / ai), which color &
depth inputs and parameters produced it — so a render can be read back later.
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config

try:
    from PIL import Image
    _PIL = True
except ImportError:  # degrade gracefully; reformat/thumbs need Pillow
    _PIL = False

_IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


# ── helpers ──────────────────────────────────────────────────────────────────
def _unique(folder: Path, stem: str, ext: str) -> Path:
    cand = folder / f"{stem}{ext}"
    i = 1
    while cand.exists():
        cand = folder / f"{stem}_{i}{ext}"
        i += 1
    return cand


def _meta_path(img: Path) -> Path:
    return img.with_suffix(img.suffix + ".json")


def _write_meta(img: Path, meta: Dict[str, Any]) -> None:
    meta = {"file": img.name, "created": time.time(), **meta}
    _meta_path(img).write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _read_meta(img: Path) -> Dict[str, Any]:
    p = _meta_path(img)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def crop_scale_square(data: bytes, size: int = 1024) -> bytes:
    """Center-crop to a square, resize to size×size, return PNG bytes."""
    if not _PIL:
        raise RuntimeError("Pillow is required for crop/scale (pip install pillow)")
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    if size:
        im = im.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


# ── import ───────────────────────────────────────────────────────────────────
def import_image(settings: Dict[str, Any], project: str, data: bytes,
                 orig_name: str, reformat: bool = False, size: int = 1024
                 ) -> Dict[str, Any]:
    paths = config.ensure_project_dirs(settings, project)
    stem = config.slug(Path(orig_name).stem)
    if reformat:
        data = crop_scale_square(data, size)
        ext = ".png"
    else:
        ext = Path(orig_name).suffix.lower() or ".png"
        if ext not in _IMG_EXTS:
            ext = ".png"
    out = _unique(paths["sourceimages"], f"{config.slug(project)}_{stem}", ext)
    out.write_bytes(data)
    _write_meta(out, {"kind": "import", "original": orig_name, "reformatted": reformat})
    return entry(settings, project, out)


def save_image(settings: Dict[str, Any], project: str, data: bytes, name: str,
               kind: str, meta: Optional[Dict[str, Any]] = None, ext: str = ".png"
               ) -> Dict[str, Any]:
    """Persist a shader render or AI output into the project's source images."""
    paths = config.ensure_project_dirs(settings, project)
    prefix = config.slug(project)
    nm = config.slug(name)
    # avoid doubling the project prefix when `name` was derived from an existing
    # (already-prefixed) gallery filename, e.g. a depth map of a shader output
    stem = nm if nm.startswith(prefix) else f"{prefix}__{nm}"
    out = _unique(paths["sourceimages"], stem, ext)
    out.write_bytes(data)
    _write_meta(out, {"kind": kind, **(meta or {})})
    return entry(settings, project, out)


# ── depth side-car of an image ───────────────────────────────────────────────
def depth_name(settings: Dict[str, Any], project: str, src_filename: str) -> Path:
    paths = config.project_paths(settings, project)
    stem = Path(src_filename).stem
    return paths["sourceimages"] / f"{stem}_depth.png"


# ── gallery ──────────────────────────────────────────────────────────────────
def entry(settings: Dict[str, Any], project: str, img: Path) -> Dict[str, Any]:
    meta = _read_meta(img)
    st = img.stat()
    return {
        "filename": img.name,
        "url": f"/api/image?project={project}&file={img.name}",
        "thumb": f"/api/thumb?project={project}&file={img.name}",
        "kind": meta.get("kind", "import"),
        "mtime": st.st_mtime,
        "size": st.st_size,
        "meta": meta,
    }


def gallery(settings: Dict[str, Any], project: str) -> List[Dict[str, Any]]:
    paths = config.ensure_project_dirs(settings, project)
    folder = paths["sourceimages"]
    items = [p for p in folder.iterdir()
             if p.is_file() and p.suffix.lower() in _IMG_EXTS]
    items.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [entry(settings, project, p) for p in items]


def source_path(settings: Dict[str, Any], project: str, filename: str) -> Path:
    """Resolve a gallery filename to a real path inside the project (safe)."""
    paths = config.project_paths(settings, project)
    p = (paths["sourceimages"] / Path(filename).name).resolve()
    root = paths["sourceimages"].resolve()
    if root not in p.parents and p != root:
        raise ValueError("path outside project sourceimages")
    return p


# ── thumbnails (cached) ──────────────────────────────────────────────────────
def thumb(settings: Dict[str, Any], project: str, filename: str, size: int = 256
          ) -> Optional[Path]:
    src = source_path(settings, project, filename)
    if not src.exists():
        return None
    if not _PIL:
        return src  # serve full image as a fallback
    cache = config.project_dir(settings, project) / ".thumbs"
    cache.mkdir(parents=True, exist_ok=True)
    dst = cache / f"{src.stem}_{size}.jpg"
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return dst
    try:
        im = Image.open(src).convert("RGB")
        im.thumbnail((size, size), Image.LANCZOS)
        im.save(dst, format="JPEG", quality=85)
        return dst
    except OSError:
        return src
