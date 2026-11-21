// audio.js — sound in the graph: a Synth, an effects chain, and Audio Out.
//
// AUDIO pins carry a live Web Audio connection rather than a value. A node's output
// is a handle on its unit ({ unit, node }); a node with an AUDIO input connects the
// upstream unit's output into its own input the frame it sees a new handle, and
// disconnects when the link goes away. Everything else rides on the usual number
// pins — pitch, volume, pan, cutoff… can all be swapped for pins (right-click ▸
// Input Modes), so the same Curve or Oscillator that moves a picture plays it too.
//
//   Synth ─▶ Chorus ─▶ Echo ─▶ Reverb ─▶ Audio Out ─▶ speakers
//
// How it's made to sound good (borrowed from the Singing Bowls project): band-
// limited oscillators, two slightly detuned voices per ear for width, a gentle
// two-pole tone filter, every change eased with setTargetAtTime so nothing clicks
// or zippers, a procedural reverb whose tail darkens as it fades, equal-power
// dry/wet, and a soft limiter on the master so a stack of synths can't clip.
//
// Recording: a Sequence → Video render steps time far slower than real time, so
// live audio can't simply be recorded alongside it. Instead each audio node logs
// its settings every frame; afterwards the same units are rebuilt in an
// OfflineAudioContext, those settings replayed at the frames' exact times, and the
// result rendered — sample-accurate and in sync, however long the frames took.
import { RT } from './runtime.js';

const LG = window.LiteGraph;
export const AUDIO = 'AUDIO';

// ── context & master bus ────────────────────────────────────────────────────────
let live = null;    // { ctx, master }

function buildMaster(c) {
  const input = c.createGain();
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -4; limiter.knee.value = 6; limiter.ratio.value = 12;
  limiter.attack.value = 0.005; limiter.release.value = 0.25;
  const output = c.createGain();
  input.connect(limiter); limiter.connect(output);
  return { input, limiter, output };
}

export function audioCtx() {
  if (live) return live.ctx;
  const C = window.AudioContext || window.webkitAudioContext;
  // 'playback' asks for a larger output buffer than 'interactive': a few tens of ms
  // more latency (irrelevant for a synth driven by the graph) in exchange for far
  // more headroom before the sound card runs dry and the audio crackles.
  const ctx = new C({ latencyHint: 'playback' });
  const master = buildMaster(ctx);
  master.output.connect(ctx.destination);
  live = { ctx, master };
  // Browsers start audio suspended until the page gets a click or key press.
  const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, resume, true);
  resume();
  return ctx;
}
export const audioRunning = () => !!live && live.ctx.state === 'running';
function masterIn() { audioCtx(); return live.master.input; }

// Silence the speakers while a sequence renders: the graph is being stepped in
// slow motion, so what it would play live is meaningless (the file gets the real
// thing, rendered offline).
function setLiveMuted(on) {
  if (!live) return;
  const g = live.master.output.gain, t = live.ctx.currentTime;
  g.cancelScheduledValues(t); g.setTargetAtTime(on ? 0 : 1, t, 0.05);
}

// ── shared helpers ──────────────────────────────────────────────────────────────
const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (n) => { const r = Math.round(n); return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };
const expMap = (x, lo, hi) => lo * Math.pow(hi / lo, Math.max(0, Math.min(1, x)));
const cutoffHz = (x) => expMap(x, 40, 18000);

// Move a param toward a value: immediately on the first frame, eased afterwards.
function glide(param, value, t, tc, now) {
  if (!isFinite(value)) return;
  if (now) { param.cancelScheduledValues(t); param.setValueAtTime(value, t); }
  else param.setTargetAtTime(value, t, Math.max(0.001, tc));
}

// Each unit's apply() schedules only what changed since its last call, so a still
// knob costs nothing and an automated one leaves one event per frame.

const noiseCache = new WeakMap();
function noiseBuffers(c) {
  let b = noiseCache.get(c);
  if (b) return b;
  const len = Math.floor(c.sampleRate * 6);
  const make = (fill) => {
    const buf = c.createBuffer(1, len, c.sampleRate);
    fill(buf.getChannelData(0));
    return buf;
  };
  const mk = () => ({
    white: make((d) => { for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; }),
    pink: make((d) => {           // Paul Kellet's filter
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      }
    }),
    brown: make((d) => {          // leaky integrated white noise
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    }),
  });
  b = [mk(), mk()];               // one set per ear, so noise is wide, not mono
  noiseCache.set(c, b);
  return b;
}

// Procedural reverb impulse: decaying noise, progressively low-passed so the tail
// darkens as it fades the way a real room does (after the Singing Bowls IR).
function makeIR(c, seconds, bright) {
  const len = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * ((0.2 + 0.6 * bright) - (0.15 + 0.4 * bright) * t);
      d[i] = lp * Math.pow(1 - t, 2.6);
    }
    const fade = Math.min(len, Math.floor(c.sampleRate * 0.004));
    for (let i = 0; i < fade; i++) d[i] *= i / fade;
  }
  return buf;
}

function tanhCurve(n = 2048) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * 1.5) / Math.tanh(1.5); }
  return curve;
}

// equal-power dry/wet
const dryGain = (m) => Math.cos(m * Math.PI / 2);
const wetGain = (m) => Math.sin(m * Math.PI / 2);

// ── units ───────────────────────────────────────────────────────────────────────
// build(ctx, offline) → { inputs: [AudioNode…], output, apply(p, t, first), stop() }.
// The same builder runs live and in the offline render, which is the only way to be
// sure a rendered file sounds like what you heard.

const WAVES = ['sine', 'triangle', 'saw', 'square', 'supersaw', 'white noise', 'pink noise', 'brown noise'];
const OSC_TYPE = { sine: 'sine', triangle: 'triangle', saw: 'sawtooth', square: 'square', supersaw: 'sawtooth' };
// rough loudness matching between waves, so switching doesn't jump in level
const WAVE_LEVEL = { sine: 1, triangle: 0.9, saw: 0.5, square: 0.4, supersaw: 0.5, 'white noise': 0.3, 'pink noise': 0.55, 'brown noise': 0.9 };

function buildSynth(c, offline) {
  const N = 3;
  const noise = noiseBuffers(c);
  const sides = [0, 1].map((s) => {
    const sum = c.createGain();
    const oscs = [], og = [];
    for (let k = 0; k < N; k++) {
      const o = c.createOscillator(), g = c.createGain();
      g.gain.value = 0; o.connect(g); g.connect(sum); o.start(); oscs.push(o); og.push(g);
    }
    const ng = {};
    for (const kind of ['white', 'pink', 'brown']) {
      const src = c.createBufferSource(); src.buffer = noise[s][kind]; src.loop = true;
      const g = c.createGain(); g.gain.value = 0;
      src.connect(g); g.connect(sum);
      // start the two ears at different points so they're decorrelated
      src.start(0, s ? noise[s][kind].duration * 0.37 : 0);
      ng[kind] = { src, g };
    }
    return { sum, oscs, og, ng };
  });
  const merge = c.createChannelMerger(2);
  sides[0].sum.connect(merge, 0, 0); sides[1].sum.connect(merge, 0, 1);
  const f1 = c.createBiquadFilter(), f2 = c.createBiquadFilter();
  f1.type = f2.type = 'lowpass'; f2.Q.value = 0.6;
  const env = c.createGain(); env.gain.value = 0;
  const pan = c.createStereoPanner();
  merge.connect(f1); f1.connect(f2); f2.connect(env); env.connect(pan);

  let last = null, waveSet = false;
  const unit = {
    ctx: c, inputs: [], output: pan,
    apply(p, t, first) {
      const ch = (k) => !last || last[k] !== p[k];
      const wave = WAVES[p.wave | 0] || 'sine';
      // waveform: the oscillators' shape, and which sources are open. An oscillator's
      // shape can't be scheduled, so an offline render keeps the first one it saw;
      // the tone ↔ noise gates still follow every change.
      if (ch('wave')) {
        const type = OSC_TYPE[wave], lvl = WAVE_LEVEL[wave] || 1;
        // The detuned voices are quieter partners, never equal twins: two equal sines
        // a few cents apart cancel completely once per beat, which on a pure tone is
        // heard as a pop every second. At 3:1 the beat is a gentle ~6 dB swell.
        const gains = !type ? [0, 0, 0] : wave === 'supersaw' ? [0.5, 0.28, 0.28] : [0.75, 0.25, 0];
        for (const sd of sides) {
          if (type && (!offline || !waveSet)) for (const o of sd.oscs) o.type = type;
          sd.og.forEach((g, k) => glide(g.gain, gains[k] * lvl, t, 0.01, first));
          for (const kind in sd.ng) glide(sd.ng[kind].g.gain, wave === kind + ' noise' ? lvl : 0, t, 0.01, first);
        }
        if (type) waveSet = true;
      }
      // pitch: the main voice is the same in both ears. Only the quieter second
      // voice moves — shimmer pulls it a few Hz apart between the ears, detune
      // spreads it in cents. It used to split the MAIN voice between the ears,
      // and on speakers the two sides sum in the room and cancel to silence once
      // per beat — a pop every second. Now the deepest a beat can go is ~6 dB.
      if (ch('pitch') || ch('shimmer') || ch('glide')) {
        const f = midiHz(+p.pitch || 57), sh = Math.max(0, +p.shimmer || 0);
        const tc = Math.max(0.004, (+p.glide || 0) / 3);
        sides.forEach((sd, s) => {
          sd.oscs.forEach((o, k) => glide(o.frequency, Math.max(1, k === 1 ? f + (s ? sh / 2 : -sh / 2) : f), t, tc, first));
        });
      }
      if (ch('detune') || ch('wave')) {
        const d = Math.max(0, +p.detune || 0), sup = wave === 'supersaw';
        sides.forEach((sd, s) => {
          const sign = s ? -1 : 1;
          const cents = sup ? [0, 2.2 * d * sign, -1.6 * d * sign] : [0, d * sign, 0];
          sd.oscs.forEach((o, k) => glide(o.detune, cents[k], t, 0.02, first));
        });
      }
      if (ch('tone') || ch('resonance')) {
        const hz = cutoffHz(+p.tone);
        glide(f1.frequency, hz, t, 0.02, first);
        glide(f2.frequency, Math.min(20000, hz * 1.4), t, 0.02, first);
        glide(f1.Q, 0.5 + Math.pow(+p.resonance || 0, 2) * 14, t, 0.02, first);
      }
      // gate + volume through one envelope: attack when it opens, release when it
      // closes, a quick ease for volume moves in between
      if (ch('gate') || ch('volume') || ch('__muted')) {
        const on = !!p.gate && !p.__muted;
        const vol = Math.pow(Math.max(0, +p.volume || 0), 2) * 2;
        const atk = Math.max(0.002, (+p.attack || 0.01) / 3), rel = Math.max(0.003, (+p.release || 0.05) / 3);
        if (first) {
          // A new synth fades in on its attack. So does an offline render that
          // starts from scratch; one picking up "where it is" starts already sounding.
          env.gain.cancelScheduledValues(t);
          const swell = !offline || p.__fresh;
          env.gain.setValueAtTime(on && !swell ? vol : 0, t);
          if (on && swell) env.gain.setTargetAtTime(vol, t, atk);
        } else {
          const wasOn = !!last.gate && !last.__muted;
          env.gain.setTargetAtTime(on ? vol : 0, t, on && !wasOn ? atk : (!on && wasOn ? rel : 0.015));
        }
      }
      if (ch('pan')) glide(pan.pan, Math.max(-1, Math.min(1, +p.pan || 0)), t, 0.015, first);
      last = Object.assign({}, p);
    },
    // a muted synth eases out rather than cutting (see onMuteChange)
    mute(on) { if (last) this.apply(Object.assign({}, last, { __muted: on }), c.currentTime, false); },
    stop() {
      try { env.gain.setTargetAtTime(0, c.currentTime, 0.02); } catch (e) {}
      setTimeout(() => {
        for (const sd of sides) {
          for (const o of sd.oscs) { try { o.stop(); } catch (e) {} }
          for (const k in sd.ng) { try { sd.ng[k].src.stop(); } catch (e) {} }
        }
        try { pan.disconnect(); } catch (e) {}
      }, offline ? 0 : 120);
    },
  };
  return unit;
}

// Sine: one oscillator and a volume — nothing else. With its output unconnected it
// plays straight to the speakers (no limiter, no chain), so it is also the
// simplest possible check of the audio path itself.
function buildSine(c, offline) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; g.gain.value = 0;
  o.connect(g); o.start();
  let last = null, direct = false;
  return {
    ctx: c, inputs: [], output: g,
    apply(p, t, first) {
      const ch = (k) => !last || last[k] !== p[k];
      if (ch('freq')) glide(o.frequency, Math.max(1, Math.min(20000, +p.freq || 220)), t, 0.01, first);
      if (ch('volume') || ch('on')) {
        const v = p.on ? Math.pow(Math.max(0, +p.volume || 0), 2) * 0.5 : 0;
        if (first) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(0, t); }
        g.gain.setTargetAtTime(v, t, 0.02);            // a 20 ms ease: never a step
      }
      last = Object.assign({}, p);
    },
    // straight to the speakers (live) or the render's bus (offline)
    direct(on, dest) {
      if (on === direct) return;
      direct = on;
      try { if (on) g.connect(dest || c.destination); else g.disconnect(dest || c.destination); } catch (e) {}
    },
    stop() {
      try { g.gain.setTargetAtTime(0, c.currentTime, 0.01); } catch (e) {}
      setTimeout(() => { try { o.stop(); } catch (e) {} try { g.disconnect(); } catch (e) {} }, offline ? 0 : 80);
    },
  };
}

function buildEcho(c) {
  const input = c.createGain(), output = c.createGain();
  const dry = c.createGain(), wet = c.createGain();
  const split = c.createChannelSplitter(2), merge = c.createChannelMerger(2);
  const dL = c.createDelay(4), dR = c.createDelay(4);
  const fL = c.createBiquadFilter(), fR = c.createBiquadFilter();
  fL.type = fR.type = 'lowpass'; fL.Q.value = fR.Q.value = 0.5;
  const g = () => { const x = c.createGain(); x.gain.value = 0; return x; };
  const inL = g(), inR = g(), inMono = g(), fbLL = g(), fbRR = g(), fbLR = g(), fbRL = g();
  input.connect(dry); dry.connect(output);
  input.connect(split);
  split.connect(inL, 0); split.connect(inR, 1); split.connect(inMono, 0); split.connect(inMono, 1);
  inL.connect(dL); inR.connect(dR); inMono.connect(dL);
  dL.connect(fL); dR.connect(fR);
  fL.connect(fbLL); fbLL.connect(dL); fR.connect(fbRR); fbRR.connect(dR);
  fL.connect(fbLR); fbLR.connect(dR); fR.connect(fbRL); fbRL.connect(dL);
  fL.connect(merge, 0, 0); fR.connect(merge, 0, 1);
  merge.connect(wet); wet.connect(output);
  let last = null;
  return {
    ctx: c, inputs: [input], output,
    apply(p, t, first) {
      const ch = (k) => !last || last[k] !== p[k];
      if (ch('time')) { const s = Math.max(0.01, Math.min(4, +p.time || 0.3)); glide(dL.delayTime, s, t, 0.05, first); glide(dR.delayTime, s, t, 0.05, first); }
      if (ch('tone')) { const hz = cutoffHz(+p.tone); glide(fL.frequency, hz, t, 0.02, first); glide(fR.frequency, hz, t, 0.02, first); }
      if (ch('mix')) { glide(dry.gain, dryGain(+p.mix || 0), t, 0.02, first); glide(wet.gain, wetGain(+p.mix || 0), t, 0.02, first); }
      if (ch('feedback') || ch('pingpong')) {
        const fb = Math.max(0, Math.min(0.95, +p.feedback || 0)), pp = !!p.pingpong;
        glide(inL.gain, pp ? 0 : 1, t, 0.01, first); glide(inR.gain, pp ? 0 : 1, t, 0.01, first);
        glide(inMono.gain, pp ? 0.5 : 0, t, 0.01, first);
        glide(fbLL.gain, pp ? 0 : fb, t, 0.02, first); glide(fbRR.gain, pp ? 0 : fb, t, 0.02, first);
        glide(fbLR.gain, pp ? fb : 0, t, 0.02, first); glide(fbRL.gain, pp ? fb : 0, t, 0.02, first);
      }
      last = Object.assign({}, p);
    },
    stop() { try { output.disconnect(); } catch (e) {} },
  };
}

function buildReverb(c, offline) {
  const input = c.createGain(), output = c.createGain();
  const dry = c.createGain(), wet = c.createGain();
  const pre = c.createDelay(1), conv = c.createConvolver(), tone = c.createBiquadFilter();
  tone.type = 'lowpass'; tone.Q.value = 0.5;
  input.connect(dry); dry.connect(output);
  input.connect(pre); pre.connect(conv); conv.connect(tone); tone.connect(wet); wet.connect(output);
  let last = null, irKey = '', irTimer = 0;
  const setIR = (size, bright) => {
    const key = size.toFixed(2) + '|' + bright.toFixed(2);
    if (key === irKey) return;
    irKey = key;
    conv.buffer = makeIR(c, size, bright);
  };
  return {
    ctx: c, inputs: [input], output,
    apply(p, t, first) {
      const ch = (k) => !last || last[k] !== p[k];
      const size = Math.max(0.2, Math.min(15, +p.size || 3)), bright = Math.max(0, Math.min(1, +p.tone || 0.5));
      if (ch('size') || ch('tone')) {
        // A new impulse costs a few ms to build; while a knob is being dragged, wait
        // for it to settle. Offline it's built once, from the first frame.
        if (first || offline) { if (!irKey) setIR(size, bright); }
        else { clearTimeout(irTimer); irTimer = setTimeout(() => setIR(size, bright), 180); }
        glide(tone.frequency, expMap(bright, 1200, 16000), t, 0.05, first);
      }
      if (ch('predelay')) glide(pre.delayTime, Math.max(0, Math.min(0.5, +p.predelay || 0)), t, 0.05, first);
      if (ch('mix')) { glide(dry.gain, dryGain(+p.mix || 0), t, 0.03, first); glide(wet.gain, wetGain(+p.mix || 0) * 1.3, t, 0.03, first); }
      last = Object.assign({}, p);
    },
    stop() { clearTimeout(irTimer); try { output.disconnect(); } catch (e) {} },
  };
}

const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];
function buildFilter(c) {
  const f = c.createBiquadFilter();
  let last = null;
  return {
    ctx: c, inputs: [f], output: f,
    apply(p, t, first) {
      const ch = (k) => !last || last[k] !== p[k];
      if (ch('type')) f.type = FILTER_TYPES[p.type | 0] || 'lowpass';
      if (ch('cutoff')) glide(f.frequency, expMap(+p.cutoff, 20, 20000), t, 0.02, first);
      if (ch('resonance')) glide(f.Q, expMap(+p.resonance, 0.3, 24), t, 0.02, first);
      last = Object.assign({}, p);
    },
    stop() { try { f.disconnect(); } catch (e) {} },
  };
}

function buildDrive(c) {
  const input = c.createGain(), output = c.createGain();
  const dry = c.createGain(), wet = c.createGain(), pre = c.createGain(), post = c.createGain();
  const shaper = c.createWaveShaper(); shaper.curve = tanhCurve(); shaper.oversample = '4x';
  const tone = c.createBiquadFilter(); tone.type = 'lowpass';
  input.connect(dry); dry.connect(output);
  input.connect(pre); pre.connect(shaper); shaper.connect(tone); tone.connect(post); post.connect(wet); wet.connect(output);
  let last = null;
  return {
    ctx: c, inputs: [input], output,
    apply(p, t, first) {
      const ch = (k) => !last || last[k] !== p[k];
      if (ch('drive')) { const g = expMap(+p.drive, 1, 40); glide(pre.gain, g, t, 0.02, first); glide(post.gain, 1 / Math.sqrt(g), t, 0.02, first); }
      if (ch('tone')) glide(tone.frequency, cutoffHz(+p.tone), t, 0.02, first);
      if (ch('mix')) { glide(dry.gain, dryGain(+p.mix || 0), t, 0.02, first); glide(wet.gain, wetGain(+p.mix || 0), t, 0.02, first); }
      last = Object.assign({}, p);
    },
    stop() { try { output.disconnect(); } catch (e) {} },
  };
}

function buildChorus(c) {
  const input = c.createGain(), output = c.createGain();
  const dry = c.createGain(), wet = c.createGain();
  const split = c.createChannelSplitter(2), merge = c.createChannelMerger(2);
  const dL = c.createDelay(0.1), dR = c.createDelay(0.1);
  dL.delayTime.value = 0.014; dR.delayTime.value = 0.019;
  const lfo = c.createOscillator(), depL = c.createGain(), depR = c.createGain();
  lfo.type = 'sine'; lfo.start();
  lfo.connect(depL); lfo.connect(depR); depL.connect(dL.delayTime); depR.connect(dR.delayTime);
  input.connect(dry); dry.connect(output);
  input.connect(split); split.connect(dL, 0); split.connect(dR, 1);
  dL.connect(merge, 0, 0); dR.connect(merge, 0, 1); merge.connect(wet); wet.connect(output);
  let last = null;
  return {
    ctx: c, inputs: [input], output,
    apply(p, t, first) {
      const ch = (k) => !last || last[k] !== p[k];
      if (ch('rate')) glide(lfo.frequency, expMap(+p.rate, 0.05, 6), t, 0.05, first);
      if (ch('depth')) { const d = Math.max(0, Math.min(1, +p.depth || 0)) * 0.006; glide(depL.gain, d, t, 0.05, first); glide(depR.gain, -d, t, 0.05, first); }
      if (ch('mix')) { glide(dry.gain, dryGain(+p.mix || 0), t, 0.02, first); glide(wet.gain, wetGain(+p.mix || 0), t, 0.02, first); }
      last = Object.assign({}, p);
    },
    stop() { try { lfo.stop(); } catch (e) {} try { output.disconnect(); } catch (e) {} },
  };
}

// Audio Out: four inputs summed, a volume, and a meter. Live it feeds the master
// bus; offline, the render's own master.
function buildOut(c, offline, bus) {
  const ins = [0, 1, 2, 3].map(() => c.createGain());
  const vol = c.createGain();
  for (const g of ins) g.connect(vol);
  let analyser = null;
  if (!offline) { analyser = c.createAnalyser(); analyser.fftSize = 1024; vol.connect(analyser); }
  vol.connect(bus);
  let last = null;
  return {
    ctx: c, inputs: ins, output: null, analyser,
    apply(p, t, first) {
      if (!last || last.volume !== p.volume) glide(vol.gain, Math.pow(Math.max(0, +p.volume || 0), 2), t, 0.02, first);
      last = Object.assign({}, p);
    },
    stop() { try { vol.disconnect(); } catch (e) {} },
  };
}

// ── node definitions ────────────────────────────────────────────────────────────
// Same shape as a shader manifest's controls, so the shared widget + pin code
// (Input Modes) works on them unchanged.
const range = (uniform, label, min, max, value, step = 0.01) => ({ uniform, label, type: 'range', min, max, step, value });
const DEFS = [
  {
    key: 'sine', name: 'Sine', ins: 0, out: true, build: buildSine,
    controls: [
      { uniform: 'on', label: 'On', type: 'bool', value: true },
      range('freq', 'Frequency (Hz)', 20, 2000, 220, 0.1),
      range('volume', 'Volume', 0, 1, 0.5),
    ],
  },
  {
    key: 'synth', name: 'Synth', ins: 0, out: true, build: buildSynth,
    controls: [
      { uniform: 'wave', label: 'Wave', type: 'select', value: 4, options: WAVES.map((w, i) => ({ value: i, label: w })) },
      { uniform: 'gate', label: 'On', type: 'bool', value: true },
      range('pitch', 'Pitch (note)', 12, 108, 45),
      range('volume', 'Volume', 0, 1, 0.6),
      range('pan', 'Pan', -1, 1, 0),
      range('tone', 'Tone', 0, 1, 0.55),
      range('resonance', 'Resonance', 0, 1, 0.1),
      range('detune', 'Detune (cents)', 0, 50, 6, 0.1),
      range('shimmer', 'Shimmer (Hz)', 0, 12, 0, 0.05),
      range('glide', 'Glide (s)', 0, 3, 0.08),
      range('attack', 'Attack (s)', 0.005, 6, 0.4),
      range('release', 'Release (s)', 0.01, 10, 1.5),
    ],
  },
  {
    key: 'echo', name: 'Echo', ins: 1, out: true, build: buildEcho,
    controls: [
      range('time', 'Time (s)', 0.01, 2, 0.375, 0.005),
      range('feedback', 'Feedback', 0, 0.95, 0.45),
      range('tone', 'Tone', 0, 1, 0.55),
      range('mix', 'Mix', 0, 1, 0.35),
      { uniform: 'pingpong', label: 'Ping-pong', type: 'bool', value: true },
    ],
  },
  {
    key: 'reverb', name: 'Reverb', ins: 1, out: true, build: buildReverb,
    controls: [
      range('size', 'Size (s)', 0.3, 12, 4, 0.1),
      range('tone', 'Brightness', 0, 1, 0.45),
      range('predelay', 'Pre-delay (s)', 0, 0.3, 0.03, 0.005),
      range('mix', 'Mix', 0, 1, 0.4),
    ],
  },
  {
    key: 'filter', name: 'Filter', ins: 1, out: true, build: buildFilter,
    controls: [
      { uniform: 'type', label: 'Type', type: 'select', value: 0, options: FILTER_TYPES.map((v, i) => ({ value: i, label: v })) },
      range('cutoff', 'Cutoff', 0, 1, 0.6),
      range('resonance', 'Resonance', 0, 1, 0.2),
    ],
  },
  {
    key: 'chorus', name: 'Chorus', ins: 1, out: true, build: buildChorus,
    controls: [
      range('rate', 'Rate', 0, 1, 0.3),
      range('depth', 'Depth', 0, 1, 0.5),
      range('mix', 'Mix', 0, 1, 0.5),
    ],
  },
  {
    key: 'drive', name: 'Drive', ins: 1, out: true, build: buildDrive,
    controls: [
      range('drive', 'Drive', 0, 1, 0.35),
      range('tone', 'Tone', 0, 1, 0.6),
      range('mix', 'Mix', 0, 1, 1),
    ],
  },
  {
    key: 'out', name: 'Audio Out', ins: 4, out: false,
    build: (c, offline, bus) => buildOut(c, offline, bus || masterIn()),
    controls: [range('volume', 'Volume', 0, 1, 0.9)],
  },
];

// ── wiring ──────────────────────────────────────────────────────────────────────
function connectInput(node, slot, dest) {
  const h = node.getInputData(slot);
  const want = h && h.unit && h.unit.output && h.unit.ctx === dest.context ? h : null;
  const cur = node._conns[slot] || null;
  if (want === cur) return;
  if (cur) { try { cur.unit.output.disconnect(dest); } catch (e) {} }
  if (want) { try { want.unit.output.connect(dest); } catch (e) { console.warn('audio connect', e); } }
  node._conns[slot] = want;
}

// ── offline recording (Sequence → Video) ────────────────────────────────────────
export const audioRec = {
  active: false, frame: 0, fps: 24, tracks: null, fresh: false,
  begin(fps, fresh) {
    this.active = true; this.fps = fps; this.frame = 0; this.fresh = !!fresh;
    this.tracks = new Map();
    setLiveMuted(true);
  },
  setFrame(i) { this.frame = i; },
  note(node, p) {
    if (!this.active) return;
    let tr = this.tracks.get(node.id);
    if (!tr) this.tracks.set(node.id, tr = { node, frames: [] });
    tr.frames.push([this.frame, Object.assign({}, p)]);
  },
  cancel() { if (this.active) { this.active = false; this.tracks = null; setLiveMuted(false); } },
  // → a WAV Blob of `seconds`, or null when the graph has no Audio Out that ran
  async finish(seconds) {
    const tracks = this.tracks, fps = this.fps, fresh = this.fresh;
    this.cancel();
    const audible = (tr) => tr.node._def.key === 'out' || tr.frames.some(([, p]) => p.__direct);
    if (!tracks || ![...tracks.values()].some(audible)) return null;
    const sr = 48000;
    const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(seconds * sr)), sr);
    const bus = buildMaster(oc); bus.output.connect(oc.destination);
    const units = new Map();
    for (const [id, tr] of tracks) {
      const u = tr.node._def.build(oc, true, bus.input);
      tr.frames.forEach(([i, p], k) => u.apply(k === 0 && fresh ? Object.assign({}, p, { __fresh: true }) : p, i / fps, k === 0));
      if (u.direct && tr.frames.some(([, p]) => p.__direct)) u.direct(true, bus.input);
      units.set(id, u);
    }
    // the connections as they stood at the end of the render (a muted effect's
    // consumers are already wired past it, so it simply isn't in the chain)
    for (const [id, tr] of tracks) {
      const u = units.get(id);
      (tr.node._conns || []).forEach((h, slot) => {
        const up = h && units.get(h.node.id);
        if (up && up.output && u.inputs[slot]) up.output.connect(u.inputs[slot]);
      });
    }
    const buf = await oc.startRendering();
    return encodeWav(buf);
  },
};

// 16-bit stereo PCM WAV (after the Singing Bowls exporter)
export function encodeWav(buffer) {
  const nch = Math.min(2, buffer.numberOfChannels), len = buffer.length;
  const bytes = 44 + len * nch * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nch, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * nch * 2, true);
  view.setUint16(32, nch * 2, true); view.setUint16(34, 16, true); str(36, 'data');
  view.setUint32(40, len * nch * 2, true);
  const chans = [];
  for (let ch = 0; ch < nch; ch++) chans.push(buffer.getChannelData(ch));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < nch; ch++) {
      const s = Math.max(-1, Math.min(1, chans[ch][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

export const graphHasAudio = (graph) => ((graph && graph._nodes) || []).some((n) => n.type === 'audio/out' || n.type === 'audio/sine');

// ── node factory ────────────────────────────────────────────────────────────────
const FACE_H = 22;   // status / meter strip under the widgets

function makeAudioNode(def, H) {
  const pinnable = H.pinnableControls(def);
  function Node() {
    for (let i = 0; i < def.ins; i++) this.addInput(def.ins > 1 ? 'in ' + (i + 1) : 'in', AUDIO);
    if (def.out) this.addOutput('out', AUDIO);
    this.properties = { params: {}, pinModes: {} };
    H.addShaderWidgets(this, def);
    this._def = def; this._conns = [];
    this._resize();
  }
  Node.title = def.name;
  const P = Node.prototype;
  P._resize = function () {
    this.size = this.computeSize();
    if (this.size[0] < 220) this.size[0] = 220;
    this.size[1] += FACE_H;
  };
  P.onConfigure = function () { H.syncShaderWidgets(this); H.restorePins(this, pinnable); };
  P._params = function () {
    const p = {};
    for (const c of def.controls) p[c.uniform] = this.properties.params[c.uniform] !== undefined ? this.properties.params[c.uniform] : c.value;
    return H.applyPins(this, pinnable, p);
  };
  P._ensureUnit = function () {
    if (!this._unit) {
      const c = audioCtx();
      this._unit = def.build(c, false);
      this._handle = { unit: this._unit, node: this };
      this._first = true;
    }
    return this._unit;
  };
  P.evaluate = function () {
    const u = this._ensureUnit();
    for (let i = 0; i < def.ins; i++) connectInput(this, i, u.inputs[i]);
    const p = this._params();
    u.apply(p, u.ctx.currentTime, this._first);
    this._first = false;
    this._p = p;
    if (u.direct) {
      // nothing plugged into its output → it plays by itself (not live while a
      // sequence renders; the render gets it instead)
      const alone = !(this.outputs && this.outputs[0] && this.outputs[0].links && this.outputs[0].links.length);
      u.direct(alone && !audioRec.active);
      if (alone) p.__direct = true;
    }
    if (audioRec.active) audioRec.note(this, p);
    if (def.out) this.setOutputData(0, this._handle);
    if (u.analyser) {
      // meter: peak with a slow fall; the canvas repaints only while it moves
      const a = u.analyser, buf = this._buf || (this._buf = new Float32Array(a.fftSize));
      a.getFloatTimeDomainData(buf);
      let pk = 0; for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
      const prev = this._pk || 0;
      this._pk = Math.max(pk, prev * 0.92);
      if (this._pk > 1e-4 || prev > 1e-4) RT.redraw();
    }
  };
  // Muted: a synth keeps its connection but eases to silence (no click); an effect
  // is bypassed by the evaluator (its input handle passes straight on); Audio Out
  // lets go of its inputs.
  P.mutedOutput = function () { return def.key === 'synth' ? this._handle : undefined; };
  P.onMuteChange = function (on) {
    if (!this._unit) return;
    if (this._unit.mute) this._unit.mute(on);
    if (on && this._unit.direct) this._unit.direct(false);
    if (on && def.key === 'out') {
      this._conns.forEach((h, i) => { if (h) { try { h.unit.output.disconnect(this._unit.inputs[i]); } catch (e) {} } });
      this._conns = [];
    }
  };
  P.onRemoved = function () {
    if (!this._unit) return;
    this._conns.forEach((h, i) => { if (h) { try { h.unit.output.disconnect(this._unit.inputs[i]); } catch (e) {} } });
    this._conns = [];
    this._unit.stop();
    this._unit = null;
  };
  P._togglePinMode = function (i) { H.togglePin(this, pinnable[i]); };
  P.getExtraMenuOptions = function () { const m = H.pinMenuItem(this, pinnable); return m ? [m] : []; };
  P.onDrawForeground = function (ctx) {
    if (this.flags.collapsed) return;
    const y = this.size[1] - FACE_H + 4, w = this.size[0] - 16;
    ctx.font = '10px sans-serif'; ctx.fillStyle = '#8a929c';
    if (!audioRunning()) { ctx.fillStyle = '#ffcc66'; ctx.fillText('click anywhere to start audio', 8, y + 10); return; }
    if (def.key === 'out' && this._unit && this._unit.analyser) {
      const db = 20 * Math.log10(Math.max(1e-5, this._pk || 0)), lvl = Math.max(0, Math.min(1, (db + 48) / 48));
      ctx.fillStyle = '#0a0c0f'; ctx.fillRect(8, y, w, 10);
      ctx.fillStyle = db > -1 ? '#ff5d6c' : db > -9 ? '#ffcc66' : '#37d0a0'; ctx.fillRect(8, y, w * lvl, 10);
    } else if (def.key === 'sine' && this._p) {
      const p = this._p, alone = !!p.__direct;
      ctx.fillText((+p.freq).toFixed(1) + ' Hz' + (p.on ? '' : ' · off') + (alone ? ' · → speakers' : ' · → out pin'), 8, y + 10);
    } else if (def.key === 'synth' && this._p) {
      const p = this._p;
      ctx.fillText(noteName(+p.pitch) + ' · ' + midiHz(+p.pitch).toFixed(1) + ' Hz' + (p.gate ? '' : ' · off'), 8, y + 10);
    }
  };
  LG.registerNodeType('audio/' + def.key, Node);
}

export function registerAudioNodes(H) {
  const LGC = window.LGraphCanvas;
  if (LGC) {
    const col = '#d9a74a';
    LGC.link_type_colors = LGC.link_type_colors || {};
    LGC.link_type_colors[AUDIO] = col;
    const proto = LGC.prototype;
    if (proto.default_connection_color_byType) proto.default_connection_color_byType[AUDIO] = col;
    if (proto.default_connection_color_byTypeOff) proto.default_connection_color_byTypeOff[AUDIO] = '#6b5a3a';
  }
  for (const def of DEFS) makeAudioNode(def, H);
}
