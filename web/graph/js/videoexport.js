// videoexport.js — Sequence → Video in the web build, where there is no ffmpeg.
//
// The Sequence node renders frames exactly as it does on the desktop. There, each
// frame is written into the project folder and ffmpeg turns the folder into a
// video. Here every frame goes straight into one of these, in the browser, and the
// result is downloaded when the render finishes:
//
//   'video'           an .mp4 — WebCodecs' VideoEncoder (H.264, or VP9 / AV1 where
//                     a browser has no H.264 encoder), muxed by the vendored mp4-muxer
//   'frames'          a .zip of PNGs laid out like the desktop's sequence folder:
//                     <name>/frame_00000.png, frame_00001.png, …
//   'frames + video'  one .zip holding both — a single download, because browsers
//                     ask before letting a page start a second one
//
// The modes are the node's existing `export` values, so a graph means the same
// thing in both builds; only the labels on the node differ.
import { ArrayBufferTarget, Muxer } from '../vendor/mp4-muxer.js';

export const WEB_EXPORT_LABELS = {
  video: 'mp4',
  frames: 'zipped frames',
  'frames + video': 'zip: frames + mp4',
};

export const canEncodeVideo = () => typeof window.VideoEncoder === 'function';

const PAD = 5;                                   // forge_server/video.py's frame_%05d.png
const even = (n) => n + (n & 1);                 // 4:2:0 video needs even dimensions
const safeFile = (s) => String(s || 'sequence').replace(/[^A-Za-z0-9._-]+/g, '_');

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ── codec choice ─────────────────────────────────────────────────────────────
// H.264 first: it plays everywhere. The level has to cover the frame size (a
// 2048² render is beyond level 4.0), so it is picked from the macroblock count.
// isConfigSupported is the only reliable answer to "can this browser do it".
async function pickCodec(width, height, fps, bitrate) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const px = width * height;
  const avc = mbs <= 8192 ? '28' : mbs <= 22080 ? '32' : mbs <= 36864 ? '33' : '3C';
  const vp9 = px <= 2228224 ? '40' : px <= 8912896 ? '51' : '61';
  const av1 = px <= 2228224 ? '08' : px <= 8912896 ? '13' : '16';
  const candidates = [
    ['avc', 'avc1.6400' + avc],                  // High
    ['avc', 'avc1.4D00' + avc],                  // Main
    ['avc', 'avc1.42E0' + avc],                  // Constrained Baseline (software encoders)
    ['avc', 'avc1.4200' + avc],                  // Baseline
    ['vp9', 'vp09.00.' + vp9 + '.08'],
    ['av1', 'av01.0.' + av1 + 'M.08'],
  ];
  for (const [muxer, codec] of candidates) {
    const config = { codec, width, height, bitrate, framerate: fps };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return { muxer, config };
    } catch (e) { /* a malformed string for this browser — try the next */ }
  }
  return null;
}

// ── a minimal .zip writer ────────────────────────────────────────────────────
// Stored, not deflated: PNGs are already compressed, so deflate would only cost
// time. Each frame is kept as the Blob it arrived as, so the zip never holds a
// second copy of the pixels; only the CRC needs its bytes, once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

class ZipWriter {
  constructor() {
    this.parts = []; this.central = []; this.offset = 0; this.count = 0;
    const d = new Date();
    this.time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    this.date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }

  async add(name, blob) {
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const nm = new TextEncoder().encode(name);
    const size = blob.size;
    if (this.offset + 30 + nm.length + size > 0xFFFFFFFF || this.count >= 0xFFFF)
      throw new Error('too big for a zip — render fewer frames or a smaller size');

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true);
    local.setUint16(4, 20, true);                // version needed
    local.setUint16(6, 0x0800, true);            // UTF-8 names
    local.setUint16(8, 0, true);                 // stored
    local.setUint16(10, this.time, true);
    local.setUint16(12, this.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nm.length, true);
    this.parts.push(local, nm, blob);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014B50, true);
    cen.setUint16(4, 20, true);                  // version made by
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, this.time, true);
    cen.setUint16(14, this.date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, size, true);
    cen.setUint32(24, size, true);
    cen.setUint16(28, nm.length, true);
    cen.setUint32(42, this.offset, true);        // where the local header starts
    this.central.push(cen, nm);

    this.offset += 30 + nm.length + size;
    this.count++;
  }

  finish() {
    const cenSize = this.central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end], { type: 'application/zip' });
  }
}

// ── the exporter the Sequence node drives ────────────────────────────────────
export class SequenceExport {
  constructor({ name, fps, mode }) {
    this.name = safeFile(name);
    this.fps = fps;
    this.wantVideo = mode !== 'frames';
    this.wantFrames = mode !== 'video';
    this.error = null;
  }

  // Called with the first frame's size. Fails here, before any frames are drawn,
  // if this browser can't encode video at all.
  async begin(width, height) {
    if (this.wantFrames) this.zip = new ZipWriter();
    if (!this.wantVideo) return;
    if (!canEncodeVideo()) throw new Error('this browser can’t encode video — use Chrome, Edge, Safari or a recent Firefox, or export zipped frames');
    this.w = even(width); this.h = even(height);
    // odd sizes are drawn into an even canvas; the extra row/column stays black
    if (this.w !== width || this.h !== height) {
      this.pad = document.createElement('canvas');
      this.pad.width = this.w; this.pad.height = this.h;
    }
    const bitrate = Math.min(60e6, Math.max(2e6, Math.round(this.w * this.h * this.fps * 0.2)));
    const pick = await pickCodec(this.w, this.h, this.fps, bitrate);
    if (!pick) throw new Error(`this browser has no video encoder for ${this.w}×${this.h} — try a smaller render size, or export zipped frames`);
    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: pick.muxer, width: this.w, height: this.h, frameRate: this.fps },
      fastStart: 'in-memory',
    });
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => { this.error = e; },
    });
    this.encoder.configure(pick.config);
    this.codec = pick.config.codec;
  }

  // `canvas` holds the frame's pixels; it is reused for the next frame, so
  // everything that reads it finishes before this returns.
  async add(canvas, i) {
    if (this.error) throw this.error;
    if (this.wantFrames) {
      const png = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      await this.zip.add(`${this.name}/frame_${String(i).padStart(PAD, '0')}.png`, png);
    }
    if (this.wantVideo) {
      let src = canvas;
      if (this.pad) { this.pad.getContext('2d').drawImage(canvas, 0, 0); src = this.pad; }
      const us = 1e6 / this.fps;
      const frame = new VideoFrame(src, { timestamp: Math.round(i * us), duration: Math.round(us) });
      this.encoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(this.fps * 2)) === 0 });
      frame.close();
      // don't let a fast render outrun the encoder and pile frames up in memory
      // (the timeout covers browsers whose encoder has no 'dequeue' event)
      while (this.encoder.encodeQueueSize > 4 && !this.error) {
        await new Promise((r) => { setTimeout(r, 15); this.encoder.addEventListener('dequeue', r, { once: true }); });
      }
    }
  }

  // Encode what is left, package it, download it. Returns what was saved.
  async finish() {
    let mp4 = null;
    if (this.wantVideo) {
      await this.encoder.flush();
      if (this.error) throw this.error;
      this.encoder.close();
      this.muxer.finalize();
      mp4 = new Blob([this.muxer.target.buffer], { type: 'video/mp4' });
    }
    if (this.wantFrames) {
      if (mp4) await this.zip.add(this.name + '.mp4', mp4);
      const file = this.name + (mp4 ? '.zip' : '_frames.zip');
      download(this.zip.finish(), file);
      return file;
    }
    download(mp4, this.name + '.mp4');
    return this.name + '.mp4';
  }

  abort() {
    try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch (e) {}
  }
}
