"""
config.py — app-level settings (settings.json at the repo root) plus path helpers.

Two layers of state:
  * settings.json  — app-wide: ComfyUI connection, directory locations, ffmpeg
                     template, depth options, the currently-open project name.
  * <projects_dir>/<Project>/project.json — per-project: the shader-effect array,
                     the AI-workflow array, and the chain. Images for a project
                     live in <projects_dir>/<Project>/sourceimages, sequences in
                     .../sequences, rendered videos in .../videos.

Nothing here mutates the user's existing ComfyUI workflow files; tag overrides
are written to sidecar files next to them (see workflows.py).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parent.parent          # C:\_Main\ai\QRI
SETTINGS_PATH = ROOT / "settings.json"

DEFAULT_SETTINGS: Dict[str, Any] = {
    "comfy": {"host": "127.0.0.1", "port": 8188},
    "paths": {
        # scanned for *.json ComfyUI workflows (UI or API format)
        "workflows_dir": str(ROOT / "Workflows"),
        # everything Forge creates lives under here, one folder per project
        "projects_dir": str(ROOT / "projects"),
        # shader effect triplets (.vert/.frag/.js) live here, served statically
        "shaders_dir": str(ROOT / "shaders"),
    },
    # depth-map generation: Forge picks the first of these node classes that the
    # connected ComfyUI actually has (queried from /object_info).
    "depth": {
        "preprocessors": [
            "DepthAnythingV2Preprocessor",
            "DepthAnythingPreprocessor",
            "Zoe-DepthMapPreprocessor",
            "MiDaS-DepthMapPreprocessor",
        ],
        "resolution": 1024,
    },
    "video": {
        "fps": 24,
        # editable ffmpeg template. Placeholders: {fps} {start} {frames_in}
        # (the %0Nd glob) {out} (full output path).
        "command": (
            'ffmpeg -y -framerate {fps} -start_number {start} -i "{frames_in}" '
            '-c:v libx264 -pix_fmt yuv420p -crf 17 "{out}"'
        ),
    },
    "current_project": "Untitled",
}


# ── slugging ─────────────────────────────────────────────────────────────────
def slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "").strip())
    return s.strip("_") or "untitled"


# ── settings load/save ───────────────────────────────────────────────────────
def load_settings() -> Dict[str, Any]:
    if SETTINGS_PATH.exists():
        try:
            with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
                return _merge(DEFAULT_SETTINGS, json.load(f))
        except (json.JSONDecodeError, OSError):
            pass
    save_settings(DEFAULT_SETTINGS)
    return json.loads(json.dumps(DEFAULT_SETTINGS))


def save_settings(s: Dict[str, Any]) -> None:
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)


def _merge(base: Dict[str, Any], over: Dict[str, Any]) -> Dict[str, Any]:
    """Deep-ish merge: nested dicts are merged one level, everything else replaced."""
    out = json.loads(json.dumps(base))
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


# ── directory helpers ────────────────────────────────────────────────────────
def workflows_dir(s: Dict[str, Any]) -> Path:
    return Path(s["paths"]["workflows_dir"])


def shaders_dir(s: Dict[str, Any]) -> Path:
    return Path(s["paths"]["shaders_dir"])


def mathnodes_dir(s: Dict[str, Any] = None) -> Path:
    d = ROOT / "mathnodes"
    d.mkdir(parents=True, exist_ok=True)   # ensure it exists so the static mount works
    return d


def projects_dir(s: Dict[str, Any]) -> Path:
    p = Path(s["paths"]["projects_dir"])
    p.mkdir(parents=True, exist_ok=True)
    return p


def project_dir(s: Dict[str, Any], name: str) -> Path:
    return projects_dir(s) / slug(name)


def project_paths(s: Dict[str, Any], name: str) -> Dict[str, Path]:
    base = project_dir(s, name)
    return {
        "base": base,
        "json": base / "project.json",
        "sourceimages": base / "sourceimages",
        "sequences": base / "sequences",
        "videos": base / "videos",
    }


def ensure_project_dirs(s: Dict[str, Any], name: str) -> Dict[str, Path]:
    p = project_paths(s, name)
    for key in ("sourceimages", "sequences", "videos"):
        p[key].mkdir(parents=True, exist_ok=True)
    return p


# ── per-project state ────────────────────────────────────────────────────────
def default_project(name: str) -> Dict[str, Any]:
    return {
        "name": name,
        "shaderEffects": [],   # array of shader-effect instances (see web/js/shaders.js)
        "aiEffects": [],       # array of AI-workflow instances (see web/js/ai.js)
        "chain": [],           # ordered chain steps
    }


def load_project(s: Dict[str, Any], name: str) -> Dict[str, Any]:
    p = project_paths(s, name)
    if p["json"].exists():
        try:
            with open(p["json"], "r", encoding="utf-8") as f:
                data = json.load(f)
            data.setdefault("name", name)
            data.setdefault("shaderEffects", [])
            data.setdefault("aiEffects", [])
            data.setdefault("chain", [])
            return data
        except (json.JSONDecodeError, OSError):
            pass
    prj = default_project(name)
    save_project(s, prj)
    return prj


def save_project(s: Dict[str, Any], project: Dict[str, Any]) -> None:
    name = project.get("name") or "Untitled"
    p = ensure_project_dirs(s, name)
    with open(p["json"], "w", encoding="utf-8") as f:
        json.dump(project, f, indent=2)


def list_projects(s: Dict[str, Any]) -> list[str]:
    root = projects_dir(s)
    out = []
    for d in sorted(root.iterdir()) if root.exists() else []:
        if d.is_dir() and (d / "project.json").exists():
            try:
                with open(d / "project.json", "r", encoding="utf-8") as f:
                    out.append(json.load(f).get("name", d.name))
            except (json.JSONDecodeError, OSError):
                out.append(d.name)
    return out
