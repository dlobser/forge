"""
comfy.py — ComfyUI HTTP client.

Patterns borrowed from the Zoom project's ZoomServer/comfy.py: one keep-alive
Session, POST the API-format graph to /prompt, poll /history/{id} for completion.
Adds the pieces Forge needs that Zoom didn't: image upload (/upload/image),
output retrieval (/view), and a cached /object_info fetch used both to populate
combo widgets in the UI and to pick a depth preprocessor that actually exists.
"""

from __future__ import annotations

import io
import time
from typing import Any, Dict, List, Optional, Tuple

import requests


class ComfyError(RuntimeError):
    pass


class ComfyClient:
    def __init__(self, host: str, port: int, client_id: str = "forge"):
        self.base = f"http://{host}:{port}"
        self.client_id = client_id
        self._http = requests.Session()
        self._object_info: Optional[Dict[str, Any]] = None
        self._object_info_at: float = 0.0

    # ── health ───────────────────────────────────────────────────────────────
    def ping(self) -> bool:
        try:
            self._http.get(f"{self.base}/system_stats", timeout=3).raise_for_status()
            return True
        except Exception:
            return False

    # ── node catalog (cached 60s) ────────────────────────────────────────────
    def object_info(self, force: bool = False) -> Dict[str, Any]:
        now = time.time()
        if not force and self._object_info is not None and now - self._object_info_at < 60:
            return self._object_info
        try:
            r = self._http.get(f"{self.base}/object_info", timeout=30)
            r.raise_for_status()
            self._object_info = r.json()
            self._object_info_at = now
        except requests.RequestException as e:
            if self._object_info is None:
                raise ComfyError(f"object_info failed: {e}")
        return self._object_info or {}

    def has_node(self, class_type: str) -> bool:
        try:
            return class_type in self.object_info()
        except ComfyError:
            return False

    # ── upload an input image, returns the name ComfyUI will LoadImage by ─────
    def upload_image(self, data: bytes, filename: str, overwrite: bool = True) -> str:
        files = {"image": (filename, io.BytesIO(data), "image/png")}
        form = {"type": "input", "overwrite": "true" if overwrite else "false"}
        r = self._http.post(f"{self.base}/upload/image", files=files, data=form, timeout=60)
        if r.status_code != 200:
            raise ComfyError(f"/upload/image {r.status_code}: {r.text[:300]}")
        j = r.json()
        name = j.get("name", filename)
        sub = j.get("subfolder", "")
        return f"{sub}/{name}" if sub else name

    # ── queue a graph ────────────────────────────────────────────────────────
    def queue(self, graph: Dict[str, Any]) -> str:
        r = self._http.post(
            f"{self.base}/prompt",
            json={"prompt": graph, "client_id": self.client_id},
            timeout=60,
        )
        if r.status_code != 200:
            raise ComfyError(f"/prompt {r.status_code}: {r.text[:600]}")
        pid = r.json().get("prompt_id")
        if not pid:
            raise ComfyError("no prompt_id in /prompt response")
        return pid

    def interrupt(self) -> None:
        try:
            self._http.post(f"{self.base}/interrupt", timeout=5)
        except requests.RequestException:
            pass

    # ── wait for completion, return the history record ───────────────────────
    def wait(self, prompt_id: str, should_stop=None, poll: float = 0.4,
             timeout: float = 1800.0) -> Dict[str, Any]:
        t0 = time.time()
        while True:
            if should_stop and should_stop():
                raise ComfyError("stopped")
            try:
                r = self._http.get(f"{self.base}/history/{prompt_id}", timeout=10)
                if r.status_code == 200:
                    hist = r.json()
                    rec = hist.get(prompt_id)
                    if rec:
                        status = rec.get("status", {})
                        if status.get("completed") or status.get("status_str") == "success":
                            return rec
                        if status.get("status_str") == "error":
                            raise ComfyError(f"comfy execution error: {self._explain(status)}")
            except requests.RequestException:
                pass
            if time.time() - t0 > timeout:
                raise ComfyError("timeout waiting for prompt completion")
            time.sleep(poll)

    @staticmethod
    def _explain(status: Dict[str, Any]) -> str:
        for kind, *rest in status.get("messages", []) or []:
            if kind == "execution_error":
                info = rest[0] if rest else {}
                return f'{info.get("node_type")}: {info.get("exception_message")}'
        return str(status)

    # ── pull the saved/preview images out of a finished prompt ───────────────
    def outputs(self, record: Dict[str, Any]) -> List[Dict[str, str]]:
        """Flatten every image referenced in a history record's outputs."""
        imgs: List[Dict[str, str]] = []
        for node_out in (record.get("outputs") or {}).values():
            for img in node_out.get("images", []) or []:
                imgs.append(img)
        return imgs

    def view(self, image: Dict[str, str]) -> bytes:
        params = {
            "filename": image.get("filename", ""),
            "subfolder": image.get("subfolder", ""),
            "type": image.get("type", "output"),
        }
        r = self._http.get(f"{self.base}/view", params=params, timeout=60)
        if r.status_code != 200:
            raise ComfyError(f"/view {r.status_code}: {r.text[:200]}")
        return r.content

    # ── output selection ─────────────────────────────────────────────────────
    @staticmethod
    def _ancestors(graph: Dict[str, Any], nid, seen=None) -> set:
        """Set of class_types feeding `nid` (inclusive), walked via [id,slot] refs."""
        seen = set() if seen is None else seen
        nid = str(nid)
        if nid in seen:
            return set()
        seen.add(nid)
        node = graph.get(nid)
        if not node:
            return set()
        classes = {node.get("class_type")}
        for v in (node.get("inputs") or {}).values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], (str, int)):
                classes |= ComfyClient._ancestors(graph, v[0], seen)
        return classes

    def pick_image(self, record: Dict[str, Any], graph: Dict[str, Any]) -> Optional[Dict[str, str]]:
        """Choose the *generated* image when a graph has several image outputs.

        A depth/control workflow previews its preprocessor map alongside the real
        result; taking the last output grabbed the depth map. Prefer the output
        that traces back to a VAEDecode (the generation), then SaveImage over
        PreviewImage, then saved 'output' over temp."""
        outs = []
        for nid, node_out in (record.get("outputs") or {}).items():
            for img in node_out.get("images", []) or []:
                outs.append((str(nid), img))
        if not outs:
            return None

        decoders = {"VAEDecode", "VAEDecodeTiled", "VAEDecodeAudio"}

        def score(item):
            nid, img = item
            s = 0
            if self._ancestors(graph, nid) & decoders:
                s += 100
            cls = (graph.get(nid) or {}).get("class_type", "")
            s += 10 if cls == "SaveImage" else 1 if cls == "PreviewImage" else 0
            if img.get("type") == "output":
                s += 5
            return s

        outs.sort(key=score)
        return outs[-1][1]

    # ── one-shot: queue, wait, download the generated image ──────────────────
    def run_and_fetch(self, graph: Dict[str, Any], should_stop=None,
                      timeout: float = 1800.0) -> Tuple[bytes, str]:
        pid = self.queue(graph)
        rec = self.wait(pid, should_stop=should_stop, timeout=timeout)
        img = self.pick_image(rec, graph)
        if not img:
            raise ComfyError("workflow produced no image outputs (needs a SaveImage/PreviewImage)")
        return self.view(img), img.get("filename", "output.png")
