"""
workflows.py — scan a directory of ComfyUI workflows, convert UI exports to API
format, discover the parameters & image inputs to expose, and patch a graph for
submission.

Two ways to expose a control to the Forge UI:

  1. Inline tags in any string widget value, the convention the user asked for:
        {positive prompt:"a grassy hill"}        -> text control, default text
        {denoise:0.5}                            -> number control, default 0.5
        {strength}                               -> number control, default 0
        {image:portrait}                         -> marks a LoadImage slot "portrait"
     A tag can sit inside a longer string; only the {..} is replaced at patch time.

  2. Auto-detection. Even with zero tags, the common knobs of well-known nodes
     (KSampler seed/steps/cfg/denoise, CLIPTextEncode text, EmptyLatentImage
     width/height, checkpoint/lora/sampler combos) are surfaced automatically,
     and every LoadImage becomes an image slot. These are flagged `auto` so the
     front-end can tuck them under an "advanced" group.

UI-format exports (the litegraph "nodes"/"links" shape the user's samples use)
are converted to the flat {id:{class_type,inputs}} API format ComfyUI's /prompt
wants. Conversion reads the widget annotations modern ComfyUI embeds in each
node's `inputs` array, falling back to /object_info ordering when needed.

Nothing here writes to the user's workflow files. Exposure overrides (hide a
param, rename a label) live in a sidecar `<name>.forge.json`.
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import config

# control_after_generate serialises one of these right after a seed-like INT
_CONTROL_VALUES = {"fixed", "increment", "decrement", "randomize"}
_TAG_RE = re.compile(r"\{([^{}:]+?)(?::([^{}]*))?\}")


# ── discovery ────────────────────────────────────────────────────────────────
def scan(settings: Dict[str, Any]) -> List[Dict[str, Any]]:
    d = config.workflows_dir(settings)
    out: List[Dict[str, Any]] = []
    if not d.exists():
        return out
    for p in sorted(d.glob("*.json")):
        if p.name.endswith(".forge.json"):
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append({
            "key": p.stem,
            "name": p.stem,
            "format": "api" if _is_api(data) else "ui",
            "path": str(p),
        })
    return out


def _is_api(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    if "nodes" in data and isinstance(data.get("nodes"), list):
        return False
    # API format: every value is a dict carrying a class_type
    return all(isinstance(v, dict) and "class_type" in v for v in data.values()) and bool(data)


def _load_raw(settings: Dict[str, Any], key: str) -> Any:
    p = config.workflows_dir(settings) / f"{key}.json"
    if not p.exists():
        raise FileNotFoundError(f"workflow {key!r} not found in {p.parent}")
    return json.loads(p.read_text(encoding="utf-8"))


def _sidecar(settings: Dict[str, Any], key: str) -> Dict[str, Any]:
    p = config.workflows_dir(settings) / f"{key}.forge.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_sidecar(settings: Dict[str, Any], key: str, data: Dict[str, Any]) -> None:
    p = config.workflows_dir(settings) / f"{key}.forge.json"
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


# ── UI -> API conversion ─────────────────────────────────────────────────────
def to_api(data: Any, object_info: Optional[Dict[str, Any]] = None
           ) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Return (api_graph, titles) where titles maps node-id -> display title."""
    if _is_api(data):
        titles = {nid: (n.get("_meta", {}) or {}).get("title", n.get("class_type", nid))
                  for nid, n in data.items()}
        api = copy.deepcopy(data)
    else:
        api, titles = _ui_to_api(data, object_info or {})
    if object_info:
        _clean_inputs(api, object_info)
    return api, titles


def _clean_inputs(api: Dict[str, Any], object_info: Dict[str, Any]) -> None:
    """Drop UI-only widgets (e.g. LoadImage's 'upload' button) that aren't real
    node inputs, so ComfyUI doesn't choke on unexpected keys. Only filters nodes
    whose class is known; unknown/custom nodes are left untouched."""
    for node in api.values():
        spec = object_info.get(node.get("class_type"))
        if not spec:
            continue
        allowed = set((spec.get("input", {}).get("required") or {})) | \
                  set((spec.get("input", {}).get("optional") or {}))
        if allowed:
            node["inputs"] = {k: v for k, v in node.get("inputs", {}).items() if k in allowed}


def _ui_to_api(graph: Dict[str, Any], object_info: Dict[str, Any]
               ) -> Tuple[Dict[str, Any], Dict[str, str]]:
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    # link_id -> [id, from_node, from_slot, to_node, to_slot, type]
    links = {l[0]: l for l in graph.get("links", []) if isinstance(l, list) and l}

    skip = {"Note", "MarkdownNote", "Reroute", "PrimitiveNode", "PrimitiveString",
            "PrimitiveInt", "PrimitiveFloat", "GetNode", "SetNode"}

    def resolve(node_id: int, slot: int):
        """Follow Reroute nodes back to a real producer; return [str(id), slot]."""
        node = nodes.get(node_id)
        if node and node.get("type") == "Reroute":
            inp = (node.get("inputs") or [{}])[0]
            link = links.get(inp.get("link"))
            if link:
                return resolve(link[1], link[2])
        return [str(node_id), slot]

    api: Dict[str, Any] = {}
    titles: Dict[str, str] = {}
    for nid, node in nodes.items():
        ntype = node.get("type")
        if ntype in skip or node.get("mode") in (2, 4):  # muted / bypassed
            continue
        inputs: Dict[str, Any] = {}

        # connection inputs
        for inp in node.get("inputs", []) or []:
            link = links.get(inp.get("link"))
            if link is not None:
                inputs[inp["name"]] = resolve(link[1], link[2])

        # widget values
        widget_names = _widget_order(node, ntype, object_info)
        values = node.get("widgets_values", []) or []
        if isinstance(values, dict):  # some exports use a dict keyed by widget name
            for name in widget_names:
                if name in values:
                    inputs[name] = values[name]
        else:
            j = 0
            for name in widget_names:
                if j >= len(values):
                    break
                inputs[name] = values[j]
                j += 1
                if j < len(values) and isinstance(values[j], str) and values[j] in _CONTROL_VALUES:
                    j += 1  # swallow control_after_generate
        api[str(nid)] = {"class_type": ntype, "inputs": inputs,
                         "_meta": {"title": node.get("title") or ntype}}
        titles[str(nid)] = node.get("title") or ntype
    return api, titles


def _widget_order(node: Dict[str, Any], ntype: str, object_info: Dict[str, Any]) -> List[str]:
    """Widget input names, in serialisation order, that are NOT wired to a link."""
    ins = node.get("inputs")
    if ins:  # modern export annotates widgets directly on the inputs array
        names = [i["name"] for i in ins if i.get("widget") and i.get("link") is None]
        if names:
            return names
    # fallback: derive order from /object_info
    info = (object_info.get(ntype) or {}).get("input", {})
    connected = {i["name"] for i in (node.get("inputs") or []) if i.get("link") is not None}
    order: List[str] = []
    for group in ("required", "optional"):
        for name, spec in (info.get(group) or {}).items():
            t = spec[0] if isinstance(spec, list) else spec
            is_widget = isinstance(t, list) or t in ("INT", "FLOAT", "STRING", "BOOLEAN", "COMBO")
            if is_widget and name not in connected:
                order.append(name)
    return order


# ── parameter & image-slot discovery ─────────────────────────────────────────
_AUTO_PARAMS = {
    "KSampler": ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
    "KSamplerAdvanced": ["noise_seed", "steps", "cfg", "sampler_name", "scheduler",
                         "start_at_step", "end_at_step"],
    "CLIPTextEncode": ["text"],
    "EmptyLatentImage": ["width", "height", "batch_size"],
    "EmptySD3LatentImage": ["width", "height", "batch_size"],
    "CheckpointLoaderSimple": ["ckpt_name"],
    "LoraLoader": ["lora_name", "strength_model", "strength_clip"],
    "ControlNetApplyAdvanced": ["strength", "start_percent", "end_percent"],
    "ControlNetApply": ["strength"],
    "VAEEncodeForInpaint": ["grow_mask_by"],
    "ImageScale": ["width", "height"],
}


def build_schema(settings: Dict[str, Any], key: str,
                 object_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    raw = _load_raw(settings, key)
    api, titles = to_api(raw, object_info)
    object_info = object_info or {}
    side = _sidecar(settings, key)

    # label CLIPTextEncode nodes positive/negative by following sampler inputs
    roles: Dict[str, str] = {}
    for node in api.values():
        if "sampler" in node.get("class_type", "").lower():
            for role in ("positive", "negative"):
                ref = node.get("inputs", {}).get(role)
                if isinstance(ref, list) and ref:
                    roles[str(ref[0])] = role

    params: List[Dict[str, Any]] = []
    slots: List[Dict[str, Any]] = []
    seen_param: set = set()

    def add_param(p: Dict[str, Any]):
        if p["id"] in seen_param:
            return
        seen_param.add(p["id"])
        params.append(p)

    for nid, node in api.items():
        ctype = node.get("class_type", "")
        title = titles.get(nid, ctype)
        ins = node.get("inputs", {})

        # 1) inline {tag} controls and {image:slot} markers
        for name, val in ins.items():
            if not isinstance(val, str):
                continue
            for m in _TAG_RE.finditer(val):
                label = m.group(1).strip()
                default_raw = m.group(2)
                if label.lower() == "image":
                    slot_name = (default_raw or title or f"image{len(slots)+1}").strip().strip('"')
                    slots.append({"id": f"{nid}:{name}", "node": nid, "input": name,
                                  "label": slot_name, "source": "tag"})
                    continue
                add_param(_tag_param(nid, name, label, default_raw, title))

        # 2) image slots: every LoadImage feeds an image
        if ctype in ("LoadImage", "LoadImageMask", "VHS_LoadImagePath"):
            input_name = "image"
            if not any(s["node"] == nid for s in slots):
                slots.append({"id": f"{nid}:{input_name}", "node": nid, "input": input_name,
                              "label": title if title != ctype else "Input image",
                              "source": "auto"})

        # 3) auto params for well-known nodes
        for name in _AUTO_PARAMS.get(ctype, []):
            if name not in ins:
                continue
            if isinstance(ins[name], list):  # wired to another node, not a widget
                continue
            pid = f"{nid}:{name}"
            if pid in seen_param:
                continue
            auto_title = title
            if ctype == "CLIPTextEncode":
                r = roles.get(nid)
                auto_title = ("Positive prompt" if r == "positive" else
                              "Negative prompt" if r == "negative" else
                              (title if title != ctype else "Prompt"))
            add_param(_auto_param(nid, name, ins[name], ctype, auto_title, object_info))

    # apply sidecar overrides (hide / relabel / reorder)
    hidden = set(side.get("hidden", []))
    labels = side.get("labels", {})
    params = [p for p in params if p["id"] not in hidden]
    for p in params:
        if p["id"] in labels:
            p["label"] = labels[p["id"]]
    order = side.get("order")
    if order:
        rank = {pid: i for i, pid in enumerate(order)}
        params.sort(key=lambda p: rank.get(p["id"], 1e9))

    return {"key": key, "name": key, "params": params, "imageSlots": slots}


def _tag_param(nid: str, input_name: str, label: str, default_raw: Optional[str],
               title: str) -> Dict[str, Any]:
    pid = f"{nid}:{input_name}:{label}"
    ptype, default = "text", ""
    if default_raw is not None:
        s = default_raw.strip()
        if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
            ptype, default = "text", s[1:-1]
        elif s.lower() in ("true", "false"):
            ptype, default = "bool", s.lower() == "true"
        else:
            try:
                default = float(s)
                ptype = "number"
                if default.is_integer() and "." not in s:
                    default = int(default)
            except ValueError:
                ptype, default = "text", s
    return {"id": pid, "node": nid, "input": input_name, "tag": label,
            "label": label, "type": ptype, "default": default, "value": default,
            "source": "tag", "multiline": ptype == "text" and len(str(default)) > 24}


def _auto_param(nid: str, name: str, current: Any, ctype: str, title: str,
                object_info: Dict[str, Any]) -> Dict[str, Any]:
    spec = (object_info.get(ctype, {}).get("input", {}))
    raw = (spec.get("required", {}).get(name) or spec.get("optional", {}).get(name))
    ptype, options, opts = "text", None, {}
    if isinstance(raw, list) and raw:
        t = raw[0]
        opts = raw[1] if len(raw) > 1 and isinstance(raw[1], dict) else {}
        if isinstance(t, list):
            ptype, options = "combo", t
        elif t == "INT":
            ptype = "int"
        elif t == "FLOAT":
            ptype = "number"
        elif t == "BOOLEAN":
            ptype = "bool"
        elif t == "STRING":
            ptype = "text"
    else:  # no object_info — infer from the current value
        if isinstance(current, bool):
            ptype = "bool"
        elif isinstance(current, int):
            ptype = "int"
        elif isinstance(current, float):
            ptype = "number"
    label = name.replace("_", " ")
    if ctype == "CLIPTextEncode":
        label = title if title and title != ctype else "Prompt"
    p = {"id": f"{nid}:{name}", "node": nid, "input": name, "label": label,
         "type": ptype, "default": current, "value": current, "source": "auto",
         "multiline": ctype == "CLIPTextEncode"}
    if options is not None:
        p["options"] = options
    for k in ("min", "max", "step"):
        if k in opts:
            p[k] = opts[k]
    return p


# ── patching ─────────────────────────────────────────────────────────────────
def patch(api_graph: Dict[str, Any], schema: Dict[str, Any],
          values: Dict[str, Any], image_names: Dict[str, str]) -> Dict[str, Any]:
    """Apply UI values + uploaded image names to a fresh copy of the API graph,
    then strip the {tags} so ComfyUI never sees them."""
    g = copy.deepcopy(api_graph)

    # set exposed params
    for p in schema.get("params", []):
        if p["id"] not in values:
            continue
        v = values[p["id"]]
        node = g.get(p["node"])
        if not node:
            continue
        if p.get("type") in ("number", "int") and isinstance(v, str):
            try:
                v = int(v) if p["type"] == "int" else float(v)
            except ValueError:
                pass
        if p.get("source") == "tag":
            cur = node["inputs"].get(p["input"], "")
            if isinstance(cur, str) and _TAG_RE.search(cur):
                node["inputs"][p["input"]] = _replace_tag(cur, p["tag"], v)
            else:
                node["inputs"][p["input"]] = v
        else:
            node["inputs"][p["input"]] = v

    # set image inputs from uploaded names
    for slot in schema.get("imageSlots", []):
        name = image_names.get(slot["id"])
        if not name:
            continue
        node = g.get(slot["node"])
        if node:
            node["inputs"][slot["input"]] = name

    # final pass: any leftover {tags} -> their literal default text
    for node in g.values():
        for k, v in list(node.get("inputs", {}).items()):
            if isinstance(v, str) and _TAG_RE.search(v):
                node["inputs"][k] = _TAG_RE.sub(_tag_to_default, v)
    return g


def _replace_tag(s: str, label: str, value: Any) -> str:
    def repl(m: re.Match) -> str:
        return str(value) if m.group(1).strip() == label else m.group(0)
    return _TAG_RE.sub(repl, s)


def _tag_to_default(m: re.Match) -> str:
    d = m.group(2)
    if d is None:
        return ""
    d = d.strip()
    if (d.startswith('"') and d.endswith('"')) or (d.startswith("'") and d.endswith("'")):
        return d[1:-1]
    return d
