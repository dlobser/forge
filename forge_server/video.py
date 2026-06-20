"""
video.py — collect shader animation frames and turn them into an mp4 with ffmpeg.

The browser renders the animated shader frame by frame and POSTs each PNG; we
write them as sequences/<name>/frame_#####.png. make_video() resolves the editable
ffmpeg template from settings and runs it (shell=True, like the Zoom project, so
quoted Windows paths survive). The resolved command is returned to the UI so it
can be shown/copied.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Dict, List

from . import config

PAD = 5


def seq_dir(settings: Dict[str, Any], project: str, name: str) -> Path:
    d = config.project_paths(settings, project)["sequences"] / config.slug(name)
    d.mkdir(parents=True, exist_ok=True)
    return d


def clear_sequence(settings: Dict[str, Any], project: str, name: str) -> None:
    d = seq_dir(settings, project, name)
    for f in d.glob("frame_*.png"):
        try:
            f.unlink()
        except OSError:
            pass


def save_frame(settings: Dict[str, Any], project: str, name: str, index: int,
               data: bytes) -> str:
    d = seq_dir(settings, project, name)
    f = d / f"frame_{int(index):0{PAD}d}.png"
    f.write_bytes(data)
    return f.name


def list_sequences(settings: Dict[str, Any], project: str) -> List[Dict[str, Any]]:
    root = config.project_paths(settings, project)["sequences"]
    out: List[Dict[str, Any]] = []
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        if d.is_dir():
            frames = sorted(d.glob("frame_*.png"))
            out.append({"name": d.name, "frames": len(frames)})
    return out


def resolve_command(settings: Dict[str, Any], project: str, name: str,
                    fps: int | None = None) -> Dict[str, str]:
    d = seq_dir(settings, project, name)
    frames = sorted(d.glob("frame_*.png"))
    start = int(frames[0].stem.split("_")[1]) if frames else 0
    out_path = config.project_paths(settings, project)["videos"] / f"{config.slug(name)}.mp4"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fps = fps or settings.get("video", {}).get("fps", 24)
    cmd = settings.get("video", {}).get("command", config.DEFAULT_SETTINGS["video"]["command"])
    cmd = cmd.format(
        fps=fps, start=start,
        frames_in=str(d / f"frame_%0{PAD}d.png"),
        out=str(out_path),
    )
    return {"command": cmd, "out": str(out_path), "frames": str(len(frames))}


def make_video(settings: Dict[str, Any], project: str, name: str,
               fps: int | None = None) -> Dict[str, Any]:
    info = resolve_command(settings, project, name, fps)
    try:
        proc = subprocess.run(info["command"], shell=True, capture_output=True,
                              text=True, timeout=600)
        ok = proc.returncode == 0 and Path(info["out"]).exists()
        log = (proc.stderr or proc.stdout or "")[-4000:]
    except (subprocess.SubprocessError, OSError) as e:
        ok, log = False, str(e)
    return {"ok": ok, "command": info["command"], "out": info["out"], "log": log}
