"""graphs.py — graph documents and their version history.

A project is a *workspace*: it owns the image gallery. A graph is a *document*
inside that workspace, which is what makes Save As meaningful — saving under a
new name keeps you in the same project, so Source/Import nodes referencing
gallery images keep resolving.

Layout:

    <project>/
      graphs/
        <name>.json                    the documents
        _current                       name of the document last opened
        _versions/<name>/<stamp>.json  snapshots written by explicit saves
      graph.json                       mirror of the current document

`graph.json` predates documents and is still read directly by two consumers that
know nothing about them: the published player (via GET /api/graph) and
export_static.py's player mode. Rather than teach both about documents, every
write to the current document is mirrored back into graph.json, so those paths
keep working untouched.

Version snapshots are written by explicit saves only. The editor's 500ms autosave
writes the document (so nothing is ever lost) but does not snapshot, otherwise the
history would fill with keystrokes instead of the states worth returning to.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config

MAX_VERSIONS = 50          # per document; oldest pruned beyond this
DEFAULT_NAME = "Untitled"


# ── naming ───────────────────────────────────────────────────────────────────
def safe_name(name: str) -> str:
    """A document name that is safe as a filename but still readable.

    Keeps spaces and unicode (so 'My Sketch 2' stays itself) and strips only what
    a filesystem objects to, plus leading dots so a name can't become hidden or
    escape the directory.
    """
    name = (name or "").strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name)
    name = name.strip(". ")
    return name[:80] or DEFAULT_NAME


def graphs_dir(s: Dict[str, Any], project: str) -> Path:
    return config.project_dir(s, project) / "graphs"


def _doc_path(s: Dict[str, Any], project: str, name: str) -> Path:
    return graphs_dir(s, project) / (safe_name(name) + ".json")


def _versions_dir(s: Dict[str, Any], project: str, name: str) -> Path:
    return graphs_dir(s, project) / "_versions" / safe_name(name)


def _current_file(s: Dict[str, Any], project: str) -> Path:
    return graphs_dir(s, project) / "_current"


def _legacy_path(s: Dict[str, Any], project: str) -> Path:
    return config.project_dir(s, project) / "graph.json"


# ── migration ────────────────────────────────────────────────────────────────
def _read_json(p: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def ensure_migrated(s: Dict[str, Any], project: str) -> None:
    """Bring graph.json and the document store into agreement, cheaply, on read.

    Two cases:

    1. First run against a pre-documents project — copy graph.json into
       graphs/Untitled.json. The original is left in place rather than deleted:
       it doubles as the current-document mirror (see the module docstring), and
       leaving it means an older build still finds a graph where it expects one.

    2. Something outside this module wrote graph.json — an older build of Forge,
       or a second server pointed at the same projects folder. Because every save
       mirrors the current document into graph.json byte for byte, "content
       differs AND graph.json is the newer file" only happens when a foreign
       writer touched it. Adopt that content instead of silently shadowing it
       with a stale document, which would look to the user like lost work.
    """
    gdir = graphs_dir(s, project)
    legacy = _legacy_path(s, project)
    if not legacy.exists():
        return

    if not (gdir.exists() and any(gdir.glob("*.json"))):
        data = _read_json(legacy)
        if not data:
            return
        gdir.mkdir(parents=True, exist_ok=True)
        _doc_path(s, project, DEFAULT_NAME).write_text(
            json.dumps(data, indent=2), encoding="utf-8")
        _set_current_name(s, project, DEFAULT_NAME)
        return

    name = current_raw(s, project)
    doc = _doc_path(s, project, name)
    if not doc.exists():
        return
    try:
        if legacy.stat().st_mtime <= doc.stat().st_mtime:
            return
    except OSError:
        return
    outside, mine = _read_json(legacy), _read_json(doc)
    if outside and outside != mine:
        doc.write_text(json.dumps(outside, indent=2), encoding="utf-8")


# ── documents ────────────────────────────────────────────────────────────────
def list_graphs(s: Dict[str, Any], project: str) -> List[Dict[str, Any]]:
    ensure_migrated(s, project)
    gdir = graphs_dir(s, project)
    if not gdir.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(gdir.glob("*.json")):
        try:
            st = p.stat()
        except OSError:
            continue
        name = p.stem
        out.append({
            "name": name,
            "mtime": st.st_mtime,
            "size": st.st_size,
            "versions": len(list_versions(s, project, name)),
        })
    out.sort(key=lambda d: d["mtime"], reverse=True)
    return out


def exists(s: Dict[str, Any], project: str, name: str) -> bool:
    return _doc_path(s, project, name).exists()


def unique_name(s: Dict[str, Any], project: str, name: str) -> str:
    """'Sketch' -> 'Sketch 2' -> 'Sketch 3' … so Save As never silently clobbers."""
    base = safe_name(name)
    if not exists(s, project, base):
        return base
    n = 2
    while exists(s, project, f"{base} {n}"):
        n += 1
    return f"{base} {n}"


def current(s: Dict[str, Any], project: str) -> str:
    ensure_migrated(s, project)
    f = _current_file(s, project)
    if f.exists():
        try:
            name = f.read_text(encoding="utf-8").strip()
            if name and exists(s, project, name):
                return name
        except OSError:
            pass
    docs = list_graphs(s, project)
    return docs[0]["name"] if docs else DEFAULT_NAME


def _set_current_name(s: Dict[str, Any], project: str, name: str) -> None:
    """Record the current document without mirroring (used during migration, where
    the mirror is the file we just read from)."""
    gdir = graphs_dir(s, project)
    gdir.mkdir(parents=True, exist_ok=True)
    try:
        _current_file(s, project).write_text(safe_name(name), encoding="utf-8")
    except OSError:
        pass


def set_current(s: Dict[str, Any], project: str, name: str) -> None:
    _set_current_name(s, project, name)
    _mirror(s, project, name)


def load(s: Dict[str, Any], project: str, name: Optional[str] = None) -> Dict[str, Any]:
    ensure_migrated(s, project)
    name = name or current(s, project)
    p = _doc_path(s, project, name)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    # fall back to the legacy slot so a project that predates documents, and
    # somehow skipped migration, still opens instead of coming up blank
    legacy = _legacy_path(s, project)
    if legacy.exists():
        try:
            return json.loads(legacy.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _mirror(s: Dict[str, Any], project: str, name: str) -> None:
    """Copy a document into graph.json when it is the current one (see module doc)."""
    if safe_name(name) != safe_name(current_raw(s, project)):
        return
    src = _doc_path(s, project, name)
    if not src.exists():
        return
    try:
        shutil.copyfile(src, _legacy_path(s, project))
    except OSError:
        pass


def current_raw(s: Dict[str, Any], project: str) -> str:
    """current() without the migration/existence checks, to avoid recursing."""
    f = _current_file(s, project)
    if f.exists():
        try:
            return f.read_text(encoding="utf-8").strip() or DEFAULT_NAME
        except OSError:
            pass
    return DEFAULT_NAME


def save(s: Dict[str, Any], project: str, name: str, graph: Dict[str, Any],
         snapshot: bool = False, label: str = "") -> Dict[str, Any]:
    """Write a document. With snapshot=True also append a version."""
    name = safe_name(name)
    gdir = graphs_dir(s, project)
    gdir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(graph, indent=2)
    _doc_path(s, project, name).write_text(text, encoding="utf-8")
    made = None
    if snapshot:
        made = _write_version(s, project, name, text, label)
    _mirror(s, project, name)
    return {"ok": True, "name": name, "version": made}


def delete(s: Dict[str, Any], project: str, name: str) -> None:
    name = safe_name(name)
    p = _doc_path(s, project, name)
    if p.exists():
        p.unlink()
    vdir = _versions_dir(s, project, name)
    if vdir.exists():
        shutil.rmtree(vdir, ignore_errors=True)
    if safe_name(current_raw(s, project)) == name:
        docs = list_graphs(s, project)
        if docs:
            set_current(s, project, docs[0]["name"])


def rename(s: Dict[str, Any], project: str, name: str, new_name: str) -> str:
    name, new_name = safe_name(name), unique_name(s, project, new_name)
    src = _doc_path(s, project, name)
    if not src.exists():
        raise FileNotFoundError(name)
    src.rename(_doc_path(s, project, new_name))
    vsrc, vdst = _versions_dir(s, project, name), _versions_dir(s, project, new_name)
    if vsrc.exists():
        vsrc.rename(vdst)
    if safe_name(current_raw(s, project)) == name:
        set_current(s, project, new_name)
    return new_name


# ── versions ─────────────────────────────────────────────────────────────────
def _write_version(s: Dict[str, Any], project: str, name: str,
                   text: str, label: str = "") -> Dict[str, Any]:
    vdir = _versions_dir(s, project, name)
    vdir.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    stamp = now.strftime("%Y%m%d-%H%M%S")
    # Two saves inside the same second must not overwrite each other. The counter
    # is zero-padded so ids stay in chronological order when sorted as text
    # ('-02' before '-10'); everything below orders versions by stem for the same
    # reason — sorting whole filenames would compare '-' against '.' and put the
    # suffixed file on the wrong side of the unsuffixed one.
    vid, n = stamp, 2
    while (vdir / f"{vid}.json").exists():
        vid = f"{stamp}-{n:02d}"
        n += 1
    payload = {"saved": now.isoformat(timespec="seconds"), "label": label,
               "graph": json.loads(text)}
    (vdir / f"{vid}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    _prune(vdir)
    return {"id": vid, "saved": payload["saved"], "label": label}


def _prune(vdir: Path) -> None:
    files = sorted(vdir.glob("*.json"), key=lambda p: p.stem)
    for old in files[:-MAX_VERSIONS]:
        try:
            old.unlink()
        except OSError:
            pass


def list_versions(s: Dict[str, Any], project: str, name: str) -> List[Dict[str, Any]]:
    vdir = _versions_dir(s, project, name)
    if not vdir.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(vdir.glob("*.json"), key=lambda q: q.stem, reverse=True):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        g = d.get("graph") or {}
        out.append({
            "id": p.stem,
            "saved": d.get("saved", ""),
            "label": d.get("label", ""),
            "nodes": len(g.get("nodes") or []),
        })
    return out


def load_version(s: Dict[str, Any], project: str, name: str, vid: str) -> Dict[str, Any]:
    p = _versions_dir(s, project, name) / (safe_name(vid) + ".json")
    if not p.exists():
        raise FileNotFoundError(vid)
    return (json.loads(p.read_text(encoding="utf-8")) or {}).get("graph") or {}


def restore_version(s: Dict[str, Any], project: str, name: str,
                    vid: str) -> Dict[str, Any]:
    """Load a snapshot back over the document, snapshotting what it replaces.

    The pre-restore state is saved first so restoring is itself undoable — you
    can never lose current work by looking through history.
    """
    graph = load_version(s, project, name, vid)
    cur = load(s, project, name)
    if cur:
        _write_version(s, project, name, json.dumps(cur, indent=2),
                       label="before restore")
    save(s, project, name, graph)
    return graph
