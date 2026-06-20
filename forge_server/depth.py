"""
depth.py — generate a depth map for an image through ComfyUI.

Different ComfyUI installs ship different depth nodes, and some need a companion
model-loader node. So instead of one hardcoded graph we try a list of "recipes"
in priority order and use the first whose nodes the connected ComfyUI actually
reports in /object_info:

  1. DepthAnything_V2 (kijai)  — loader + estimator, best quality
  2. MiDaS Depth Approximation (WAS Node Suite) — single node
  3. a generic single preprocessor from settings.depth.preprocessors
     (controlnet_aux: DepthAnythingV2Preprocessor / Zoe / MiDaS-DepthMap…)

Each recipe returns LoadImage -> … -> SaveImage. generate() returns the PNG bytes.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

from .comfy import ComfyClient, ComfyError

LOAD = "1"
SAVE = "3"


def _save(src_node: str) -> Dict[str, Any]:
    return {"class_type": "SaveImage", "inputs": {"images": [src_node, 0], "filename_prefix": "forge_depth"}}


def _combo_default(comfy: ComfyClient, cls: str, name: str, fallback: Any = None) -> Any:
    info = (comfy.object_info().get(cls) or {}).get("input", {})
    for group in ("required", "optional"):
        spec = (info.get(group) or {}).get(name)
        if isinstance(spec, list) and spec:
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            if "default" in opts:
                return opts["default"]
            if isinstance(spec[0], list) and spec[0]:
                return spec[0][0]
    return fallback


# ── recipes ──────────────────────────────────────────────────────────────────
def _depth_workflow(comfy, oi, settings) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Prefer a user-supplied `depth.json` in the workflows folder (UI or API
    format). It's used as-is — its LoadImage receives the source — whenever every
    node it uses is installed; otherwise we fall back to the built-in recipes."""
    from . import config, workflows
    if not (config.workflows_dir(settings) / "depth.json").exists():
        return None
    try:
        api, _ = workflows.to_api(workflows._load_raw(settings, "depth"), oi)
    except Exception:
        return None
    if not api or not any(n.get("class_type") == "LoadImage" for n in api.values()):
        return None
    if any(n.get("class_type") not in oi for n in api.values()):
        return None   # a node it needs isn't installed → fall back to a recipe
    return "depth.json", api


def _depth_anything_v2(comfy, oi, settings) -> Optional[Tuple[str, Dict[str, Any]]]:
    if "DepthAnything_V2" not in oi or "DownloadAndLoadDepthAnythingV2Model" not in oi:
        return None
    model = _combo_default(comfy, "DownloadAndLoadDepthAnythingV2Model", "model",
                           "depth_anything_v2_vits_fp16.safetensors")
    g = {
        LOAD: {"class_type": "LoadImage", "inputs": {"image": None}},
        "L": {"class_type": "DownloadAndLoadDepthAnythingV2Model", "inputs": {"model": model}},
        "2": {"class_type": "DepthAnything_V2", "inputs": {"da_model": ["L", 0], "images": [LOAD, 0]}},
        SAVE: _save("2"),
    }
    return "DepthAnything_V2", g


def _midas_was(comfy, oi, settings) -> Optional[Tuple[str, Dict[str, Any]]]:
    if "MiDaS Depth Approximation" not in oi:
        return None
    g = {
        LOAD: {"class_type": "LoadImage", "inputs": {"image": None}},
        "2": {"class_type": "MiDaS Depth Approximation",
              "inputs": {"image": [LOAD, 0], "use_cpu": "false",
                         "midas_type": "DPT_Large", "invert_depth": "false"}},
        SAVE: _save("2"),
    }
    return "MiDaS Depth Approximation", g


def _generic_preprocessor(comfy, oi, settings) -> Optional[Tuple[str, Dict[str, Any]]]:
    res = int(settings.get("depth", {}).get("resolution", 1024))
    for cls in settings.get("depth", {}).get("preprocessors", []):
        if cls not in oi:
            continue
        inputs: Dict[str, Any] = {"image": [LOAD, 0]}
        info = (oi.get(cls) or {}).get("input", {})
        for group in ("required", "optional"):
            for name, spec in (info.get(group) or {}).items():
                if name == "image":
                    continue
                t = spec[0] if isinstance(spec, list) else spec
                opts = spec[1] if isinstance(spec, list) and len(spec) > 1 and isinstance(spec[1], dict) else {}
                if name == "resolution":
                    inputs[name] = res
                elif isinstance(t, list):
                    inputs[name] = opts.get("default", t[0] if t else "")
                elif t in ("INT", "FLOAT"):
                    inputs[name] = opts.get("default", 0)
                elif t == "BOOLEAN":
                    inputs[name] = opts.get("default", False)
                elif t == "STRING":
                    inputs[name] = opts.get("default", "")
        return cls, {LOAD: {"class_type": "LoadImage", "inputs": {"image": None}},
                     "2": {"class_type": cls, "inputs": inputs}, SAVE: _save("2")}
    return None


_RECIPES: List[Callable] = [_depth_workflow, _depth_anything_v2, _midas_was, _generic_preprocessor]


def choose(settings: Dict[str, Any], comfy: ComfyClient) -> Optional[Tuple[str, Dict[str, Any]]]:
    oi = comfy.object_info()
    for recipe in _RECIPES:
        out = recipe(comfy, oi, settings)
        if out:
            return out
    return None


def describe(settings: Dict[str, Any], comfy: ComfyClient) -> Optional[str]:
    """Name of the depth method Forge would use, or None — for the status line."""
    try:
        chosen = choose(settings, comfy)
    except ComfyError:
        return None
    return chosen[0] if chosen else None


def build_graph(settings: Dict[str, Any], comfy: ComfyClient, image_name: str) -> Dict[str, Any]:
    chosen = choose(settings, comfy)
    if not chosen:
        raise ComfyError(
            "No supported depth node found in ComfyUI. Install one of: "
            "ComfyUI-DepthAnythingV2 (DepthAnything_V2), WAS Node Suite "
            "(MiDaS Depth Approximation), or comfyui_controlnet_aux."
        )
    _, graph = chosen
    load_id = next((nid for nid, n in graph.items() if n.get("class_type") == "LoadImage"), LOAD)
    graph[load_id]["inputs"]["image"] = image_name
    return graph


def generate(settings: Dict[str, Any], comfy: ComfyClient, src_bytes: bytes,
             src_filename: str) -> bytes:
    name = comfy.upload_image(src_bytes, f"forge_src_{src_filename}")
    graph = build_graph(settings, comfy, name)
    data, _ = comfy.run_and_fetch(graph)
    return data
