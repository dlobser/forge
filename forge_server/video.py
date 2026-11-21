"""
video.py — collect shader animation frames and turn them into a video with ffmpeg.

The browser renders the animated shader frame by frame and POSTs each PNG; we
write them as sequences/<name>/frame_#####.png. A soundtrack, when the graph has
one, arrives as sequences/<name>/audio.wav (rendered offline in the browser, so it
lines up with the frames exactly).

Two ways to build the ffmpeg command:

* With encode options (what the graph's Sequence node sends): quality / codec /
  chroma / audio are turned into a command here — see build_command().
* Without them (the older Shaders tab): the editable template from settings, with
  {fps} {start} {frames_in} {out} filled in.

Either way it runs with shell=True, like the Zoom project, so quoted Windows paths
survive, and the resolved command is returned to the UI so it can be shown/copied.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config

PAD = 5
AUDIO_NAME = "audio.wav"

# libx264 / libx265 effort and constant-quality per preset (lower CRF = better).
QUALITY = {
    "draft":    {"preset": "veryfast", "crf264": 23, "crf265": 26},
    "standard": {"preset": "medium",   "crf264": 18, "crf265": 21},
    "high":     {"preset": "slow",     "crf264": 14, "crf265": 16},
    "max":      {"preset": "slower",   "crf264": 9,  "crf265": 10},
}
CODECS = ("h264", "h265", "prores", "prores4444")


def seq_dir(settings: Dict[str, Any], project: str, name: str) -> Path:
    d = config.project_paths(settings, project)["sequences"] / config.slug(name)
    d.mkdir(parents=True, exist_ok=True)
    return d


def clear_sequence(settings: Dict[str, Any], project: str, name: str) -> None:
    d = seq_dir(settings, project, name)
    for f in list(d.glob("frame_*.png")) + [d / AUDIO_NAME]:
        try:
            if f.exists():
                f.unlink()
        except OSError:
            pass


def save_frame(settings: Dict[str, Any], project: str, name: str, index: int,
               data: bytes) -> str:
    d = seq_dir(settings, project, name)
    f = d / f"frame_{int(index):0{PAD}d}.png"
    f.write_bytes(data)
    return f.name


def save_audio(settings: Dict[str, Any], project: str, name: str, data: bytes) -> str:
    f = seq_dir(settings, project, name) / AUDIO_NAME
    f.write_bytes(data)
    return str(f)


def list_sequences(settings: Dict[str, Any], project: str) -> List[Dict[str, Any]]:
    root = config.project_paths(settings, project)["sequences"]
    out: List[Dict[str, Any]] = []
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        if d.is_dir():
            frames = sorted(d.glob("frame_*.png"))
            out.append({"name": d.name, "frames": len(frames), "audio": (d / AUDIO_NAME).exists()})
    return out


def build_command(frames_in: str, start: int, fps: int, out_path: Path, *,
                  quality: str = "high", codec: str = "h264", chroma: str = "420",
                  audio_in: Optional[Path] = None) -> str:
    """ffmpeg command for the graph's Sequence node.

    Colour: the PNG frames are sRGB, and players assume BT.709 for video, so the
    RGB→YUV conversion is done with the BT.709 matrix and the stream is tagged as
    such — without that, ffmpeg converts with BT.601 and colours come out shifted.
    4:2:0 needs even dimensions, so odd sizes are padded by a pixel.
    """
    q = QUALITY.get(quality, QUALITY["high"])
    codec = codec if codec in CODECS else "h264"
    full = chroma == "444"
    tags = "-colorspace bt709 -color_primaries bt709 -color_trc bt709"
    conv = "scale=out_color_matrix=bt709:out_range=tv"
    args = ["ffmpeg -y", f"-framerate {fps} -start_number {start}", f'-i "{frames_in}"']
    if audio_in:
        args.append(f'-i "{audio_in}"')

    if codec in ("h264", "h265"):
        if codec == "h264":
            pix = "yuv444p" if full else "yuv420p"
            enc = f"-c:v libx264 -preset {q['preset']} -crf {q['crf264']}"
            if quality in ("high", "max"):
                enc += " -x264-params aq-mode=3"   # spend bits on dark gradients (less banding)
            if full:
                enc += " -profile:v high444"
        else:
            pix = "yuv444p10le" if full else "yuv420p10le"
            enc = f"-c:v libx265 -preset {q['preset']} -crf {q['crf265']} -tag:v hvc1"
        pad = "" if full else "pad=ceil(iw/2)*2:ceil(ih/2)*2,"
        args += [enc, f'-vf "{pad}{conv},format={pix}"', tags, "-movflags +faststart"]
        acodec = "-c:a aac -b:a 320k"
    else:
        if codec == "prores4444":
            enc, pix = "-c:v prores_ks -profile:v 4 -qscale:v 4", "yuva444p10le"
        else:
            enc, pix = "-c:v prores_ks -profile:v 3", "yuv422p10le"
        args += [enc, "-vendor apl0", f'-vf "{conv},format={pix}"', tags]
        acodec = "-c:a pcm_s16le"

    if audio_in:
        args += ["-map 0:v:0 -map 1:a:0", acodec, "-shortest"]
    args.append(f'"{out_path}"')
    return " ".join(args)


def resolve_command(settings: Dict[str, Any], project: str, name: str,
                    fps: int | None = None, opts: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    opts = opts or {}
    d = seq_dir(settings, project, name)
    frames = sorted(d.glob("frame_*.png"))
    start = int(frames[0].stem.split("_")[1]) if frames else 0
    fps = fps or settings.get("video", {}).get("fps", 24)
    frames_in = str(d / f"frame_%0{PAD}d.png")
    videos = config.project_paths(settings, project)["videos"]
    videos.mkdir(parents=True, exist_ok=True)
    wav = d / AUDIO_NAME

    if opts.get("quality") or opts.get("codec"):
        codec = opts.get("codec") or "h264"
        ext = "mov" if codec.startswith("prores") else "mp4"
        out_path = videos / f"{config.slug(name)}.{ext}"
        audio_in = wav if (opts.get("audio") and wav.exists()) else None
        cmd = build_command(frames_in, start, fps, out_path,
                            quality=opts.get("quality") or "high", codec=codec,
                            chroma=str(opts.get("chroma") or "420"), audio_in=audio_in)
    else:
        out_path = videos / f"{config.slug(name)}.mp4"
        cmd = settings.get("video", {}).get("command", config.DEFAULT_SETTINGS["video"]["command"])
        cmd = cmd.format(fps=fps, start=start, frames_in=frames_in, out=str(out_path))
    return {"command": cmd, "out": str(out_path), "frames": str(len(frames)),
            "audio": str(wav) if wav.exists() else ""}


def make_video(settings: Dict[str, Any], project: str, name: str,
               fps: int | None = None, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    opts = opts or {}
    info = resolve_command(settings, project, name, fps, opts)
    try:
        proc = subprocess.run(info["command"], shell=True, capture_output=True,
                              text=True, timeout=1800)
        ok = proc.returncode == 0 and Path(info["out"]).exists()
        log = (proc.stderr or proc.stdout or "")[-4000:]
    except (subprocess.SubprocessError, OSError) as e:
        ok, log = False, str(e)
    # the soundtrack as its own file, next to the video
    wav_out = ""
    src = seq_dir(settings, project, name) / AUDIO_NAME
    if opts.get("keep_wav") and src.exists():
        dst = Path(info["out"]).with_suffix(".wav")
        try:
            shutil.copyfile(src, dst)
            wav_out = str(dst)
        except OSError:
            pass
    return {"ok": ok, "command": info["command"], "out": info["out"], "log": log, "wav": wav_out}
