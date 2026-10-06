// cloudai.js — the Cloud AI nodes' back end: OpenAI (ChatGPT / gpt-image) or Google
// Gemini (Nano Banana), whichever the person picked in ⚙ Settings ▸ Cloud AI.
//
// Everything runs in the browser and calls the provider directly, so it works on
// the published web build too, where there is no Forge server at all. Keys are each
// person's own: they live in THIS browser's localStorage, go only to that provider,
// and never into graph.json, a share link, or the Forge server.
//
// The local ComfyUI nodes (Local AI ▸ …) don't come through here; they need ComfyUI.
import { BTN, BTN_PRIMARY, BTN_DANGER, FIELD, h, modal, title } from './ui.js';
import { openaiImage, OPENAI_MODELS, OPENAI_QUALITIES } from './openai.js';
import { geminiImage, GEMINI_MODELS, GEMINI_SIZES } from './gemini.js';

const LS = {
  provider: 'forge.cloud.provider',     // 'openai' | 'gemini'
  openaiKey: 'forge.openai.key',
  openaiModel: 'forge.openai.model',
  openaiQuality: 'forge.openai.quality',
  geminiKey: 'forge.gemini.key',
  geminiModel: 'forge.gemini.model',
  geminiSize: 'forge.gemini.size',
};

// `typical` is what the busy indicator promises; it's honest-ish, not a measurement
export const PROVIDERS = {
  openai: { name: 'ChatGPT', long: 'ChatGPT (OpenAI)', host: 'api.openai.com', keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys', typical: [20, 60] },
  gemini: { name: 'Gemini', long: 'Gemini / Nano Banana (Google)', host: 'generativelanguage.googleapis.com',
    keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey', typical: [10, 40] },
};

// localStorage can throw (private window, blocked site data) — read that as unset
function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function write(k, v) {
  try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
}

export const cloud = {
  // no choice made yet: whichever provider has a key, else ChatGPT
  get provider() {
    const p = read(LS.provider);
    if (PROVIDERS[p]) return p;
    return !this.openai.key && this.gemini.key ? 'gemini' : 'openai';
  },
  get name() { return PROVIDERS[this.provider].name; },
  get key() { return this[this.provider].key; },
  get model() { return this[this.provider].model; },
  get ready() { return !!this.key; },
  openai: {
    get key() { return (read(LS.openaiKey) || '').trim(); },
    get model() { return (read(LS.openaiModel) || '').trim() || OPENAI_MODELS[0]; },
    get quality() { const q = read(LS.openaiQuality); return OPENAI_QUALITIES.includes(q) ? q : 'medium'; },
  },
  gemini: {
    get key() { return (read(LS.geminiKey) || '').trim(); },
    get model() { return (read(LS.geminiModel) || '').trim() || GEMINI_MODELS[0]; },
    get size() { const s = read(LS.geminiSize); return GEMINI_SIZES.includes(s) ? s : '1K'; },
  },
};

// one-line summary for the editor's ⚙ panel
export function cloudSummary() {
  if (!cloud.key) return cloud.name + ' selected — no API key yet.';
  const extra = cloud.provider === 'gemini' ? cloud.gemini.size : cloud.openai.quality + ' quality';
  return cloud.name + ' · ' + cloud.model + ' · ' + extra;
}

const listeners = new Set();
export function onCloudChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) { try { fn(); } catch (e) {} } }

// ── the settings dialog (editor ⚙ panel and the published page share it) ──────
let openDialog = null;
export function openCloudDialog({ reason } = {}) {
  if (openDialog) return openDialog;
  openDialog = new Promise((resolve) => {
    let saved = false;
    modal((card, close) => {
      title(card, 'Cloud AI', reason
        || 'The Cloud AI nodes (Depth, Generate) make images with ChatGPT or Gemini, using your own API key.');

      let provider = cloud.provider;
      const small = (t) => h('div', 'color:#8a929c;font-size:11px;margin-bottom:5px', t);
      const sections = {};

      // One box per provider: a radio in the header says which one the nodes use,
      // and each keeps its own key + model, so switching back and forth is free.
      const section = (id, key, model, models, extraLabel, extra) => {
        const p = PROVIDERS[id];
        const box = h('div', 'border:1px solid #262b33;border-radius:9px;padding:11px 13px 0;margin-bottom:10px');
        const head = h('label', 'display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px;color:#e6e8ea');
        const radio = h('input', 'width:16px;height:16px;accent-color:#5b8cff;margin:0;flex:0 0 auto');
        radio.type = 'radio'; radio.name = 'forge-cloud-provider'; radio.value = id;
        const badge = h('span', 'margin-left:auto;font-size:11px;color:#8a929c');
        head.append(radio, h('span', 'font-weight:600', 'Use ' + p.long), badge);
        box.appendChild(head);

        box.appendChild(small('API key'));
        const k = h('input', FIELD);
        k.type = 'password'; k.placeholder = p.keyHint; k.value = key;
        k.autocomplete = 'off'; k.spellcheck = false;
        box.appendChild(k);

        const grid = h('div', 'display:flex;gap:10px');
        const col = (t, el) => {
          const c = h('div', 'flex:1;min-width:0');
          c.append(small(t), el); grid.appendChild(c);
        };
        // free text with suggestions, so a newer model works without a code change
        const m = h('input', FIELD);
        m.value = model; m.spellcheck = false;
        const dl = document.createElement('datalist');
        dl.id = 'forge-' + id + '-models';
        for (const v of models) { const o = document.createElement('option'); o.value = v; dl.appendChild(o); }
        m.setAttribute('list', dl.id);
        col('Model', m);
        col(extraLabel, extra);
        box.append(grid, dl);
        card.appendChild(box);

        radio.onchange = () => { provider = id; sync(); };
        // pasting the first key there is: select that provider for you
        k.oninput = () => { if (k.value.trim() && !sections[provider].key.value.trim()) provider = id; sync(); };
        sections[id] = { box, radio, badge, key: k, model: m, extra, models };
      };

      const quality = h('select', FIELD);
      for (const q of OPENAI_QUALITIES) { const o = document.createElement('option'); o.value = o.textContent = q; quality.appendChild(o); }
      quality.value = cloud.openai.quality;
      section('openai', cloud.openai.key, cloud.openai.model, OPENAI_MODELS, 'Quality (cost)', quality);

      const size = h('select', FIELD);
      for (const s of GEMINI_SIZES) { const o = document.createElement('option'); o.value = o.textContent = s; size.appendChild(o); }
      size.value = cloud.gemini.size;
      section('gemini', cloud.gemini.key, cloud.gemini.model, GEMINI_MODELS, 'Resolution', size);

      function sync() {
        for (const [id, s] of Object.entries(sections)) {
          const on = id === provider;
          s.radio.checked = on;
          s.box.style.borderColor = on ? '#5b8cff' : '#262b33';
          s.box.style.background = on ? '#5b8cff12' : 'transparent';
          s.badge.textContent = s.key.value.trim() ? 'key ✓' : 'no key yet';
          s.badge.style.color = s.key.value.trim() ? '#37d0a0' : '#8a929c';
        }
      }
      sync();

      const note = h('div', 'color:#8a929c;font-size:12px;line-height:1.5;margin:2px 0 14px');
      note.innerHTML = 'Keys are stored <b style="color:#c9ced6">only in this browser</b> and sent only to '
        + 'that provider — never to Forge or into a shared link. Each image is billed to your own account. '
        + 'Get a key: <a href="' + PROVIDERS.openai.keyUrl + '" target="_blank" rel="noopener" style="color:#5b8cff">OpenAI</a>'
        + ' · <a href="' + PROVIDERS.gemini.keyUrl + '" target="_blank" rel="noopener" style="color:#5b8cff">Google AI Studio</a>.';
      card.appendChild(note);

      const row = h('div', 'display:flex;gap:8px;align-items:center');
      const forget = h('button', BTN_DANGER, 'Forget keys');
      forget.hidden = !cloud.openai.key && !cloud.gemini.key;
      const cancel = h('button', BTN, 'Cancel');
      const ok = h('button', BTN_PRIMARY, 'Save');
      row.append(forget, h('div', 'flex:1'), cancel, ok);
      card.appendChild(row);

      const modelValue = (s) => { const v = s.model.value.trim(); return v === s.models[0] ? '' : v; };
      const save = () => {
        const o = sections.openai, g = sections.gemini;
        write(LS.provider, provider);
        write(LS.openaiKey, o.key.value.trim());
        write(LS.openaiModel, modelValue(o));
        write(LS.openaiQuality, quality.value);
        write(LS.geminiKey, g.key.value.trim());
        write(LS.geminiModel, modelValue(g));
        write(LS.geminiSize, size.value);
        saved = true; close();
      };
      ok.onclick = save;
      for (const s of Object.values(sections))
        s.key.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
      cancel.onclick = close;
      forget.onclick = () => { write(LS.openaiKey, ''); write(LS.geminiKey, ''); saved = true; close(); };
      setTimeout(() => (cloud.key ? ok : sections[provider].key).focus(), 0);
    }, () => { openDialog = null; if (saved) changed(); resolve(saved); });
  });
  return openDialog;
}

// A node that bakes on its own asks through here: the dialog pops up at most once
// per page load, so an upstream slider being dragged can't open it over and over.
// (A button press — Generate — opens the dialog directly instead.)
let asked = false;
export function askForKey(reason) {
  if (openDialog) return openDialog;
  if (asked) return Promise.resolve(false);
  asked = true;
  return openCloudDialog({ reason });
}

// ── what's running (the busy indicator reads this) ───────────────────────────
// A cloud image takes anywhere from ten seconds to a couple of minutes, with no
// progress reported along the way — so the page says plainly that it's working.
const jobs = new Set();
const busyListeners = new Set();
export function onCloudBusy(fn) { busyListeners.add(fn); return () => busyListeners.delete(fn); }
function busyChanged() { for (const fn of busyListeners) { try { fn([...jobs]); } catch (e) {} } }
async function track(job, fn) {
  job.start = performance.now();
  jobs.add(job); busyChanged();
  try { return await fn(); } finally { jobs.delete(job); busyChanged(); }
}

export const elapsed = (start) => {
  const s = Math.max(0, Math.floor((performance.now() - start) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// A floating "working…" pill: the editor shows it under the top bar, the published
// page at the bottom (a visitor never sees the nodes, so this is all they get).
let indicator = null;
export function mountCloudIndicator({ where = 'top' } = {}) {
  if (indicator) return;
  const st = document.createElement('style');
  st.textContent = `
  .cloud-busy{ position:fixed; left:50%; transform:translateX(-50%); z-index:60; display:flex;
    align-items:center; gap:12px; background:#15181df2; border:1px solid #5b8cff80; border-radius:12px;
    padding:10px 16px 10px 13px; color:#e6e8ea; font:13px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;
    box-shadow:0 8px 28px #000a; width:max-content; max-width:calc(100vw - 32px); pointer-events:none; }
  .cloud-busy[hidden]{ display:none; }
  .cloud-busy .sp{ width:22px; height:22px; flex:0 0 auto; border-radius:50%; border:3px solid #2a3140;
    border-top-color:#5b8cff; animation:cloud-spin .8s linear infinite; }
  .cloud-busy .sub{ color:#8a929c; font-size:11.5px; }
  .cloud-busy .clock{ color:#8a929c; font-variant-numeric:tabular-nums; margin-left:6px; }
  @keyframes cloud-spin{ to{ transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce){ .cloud-busy .sp{ animation-duration:2.5s; } }`;
  document.head.appendChild(st);

  const el = h('div'); el.className = 'cloud-busy'; el.hidden = true;
  el.style[where === 'bottom' ? 'bottom' : 'top'] = where === 'bottom' ? '18px' : '56px';
  const sp = h('div'); sp.className = 'sp';
  const txt = h('div');
  const main = h('div'); main.setAttribute('role', 'status');
  const clock = h('span'); clock.className = 'clock'; clock.setAttribute('aria-hidden', 'true');
  const sub = h('div'); sub.className = 'sub';
  txt.append(main, sub); el.append(sp, txt);
  document.body.appendChild(el);
  indicator = el;

  let timer = 0, list = [];
  const paint = () => {
    if (!list.length) return;
    const first = list.reduce((a, b) => (a.start <= b.start ? a : b));
    const p = PROVIDERS[first.provider];
    const secs = (performance.now() - first.start) / 1000;
    main.textContent = list.length > 1
      ? list.length + ' cloud AI images in progress…'
      : p.name + ' is making ' + first.what + '…';
    main.appendChild(clock);
    clock.textContent = elapsed(first.start);
    sub.textContent = secs > p.typical[1] * 2
      ? 'Taking longer than usual — still waiting on ' + p.host + '.'
      : 'Usually ' + p.typical[0] + '–' + p.typical[1] + ' seconds. Hang tight — it’s working.';
  };
  onCloudBusy((now) => {
    list = now;
    el.hidden = !list.length;
    if (list.length && !timer) timer = setInterval(paint, 500);
    if (!list.length && timer) { clearInterval(timer); timer = 0; }
    paint();
  });
}

// ── turning a request into a picture ────────────────────────────────────────────
// Big renders are capped before upload: 4K PNGs are slow to send, and neither
// provider looks at more than ~2K of detail anyway.
async function shrink(blob, max = 2048) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (s >= 1) { if (bmp.close) bmp.close(); return blob; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height); if (bmp.close) bmp.close();
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

// base64 → canvas (at `width`×`height` if given, else the image's own size) + PNG
async function decode(b64, width, height) {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement('canvas');
  c.width = width || bmp.width; c.height = height || bmp.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  const png = await new Promise((res) => c.toBlob(res, 'image/png'));
  return { canvas: c, blob: png };
}

async function run({ what, prompt, images = [], aspect = 1, width, height }) {
  const provider = cloud.provider, p = PROVIDERS[provider];
  const key = cloud.key, model = cloud.model;
  if (!key) { const e = new Error('no ' + p.name + ' API key set'); e.auth = true; throw e; }
  return track({ provider, what, model }, async () => {
    try {
      const imgs = await Promise.all(images.map((b) => shrink(b)));
      const b64 = provider === 'gemini'
        ? await geminiImage({ key, model, size: cloud.gemini.size, prompt, images: imgs, aspect })
        : await openaiImage({ key, model, quality: cloud.openai.quality, prompt, images: imgs, aspect });
      const out = await decode(b64, width, height);
      return Object.assign(out, { provider, model, name: p.name });
    } catch (e) {
      // a wrong / revoked key: callers offer the key dialog again
      if (e.status === 401 || e.status === 403 || /api[ _-]?key/i.test(e.message)) e.auth = true;
      if (!e.message.startsWith(p.name)) e.message = p.name + ': ' + e.message;
      throw e;
    }
  });
}

// White = near, black = far: the same convention as DepthAnything / MiDaS, so the
// depth shaders don't care which one made the map.
const DEPTH_PROMPT = 'Convert this image into a depth map. Output only the depth map: a '
  + 'grayscale image where the nearest surfaces are white and the farthest are black, with '
  + 'smooth gradients across surfaces and crisp edges at object boundaries. Keep the exact '
  + 'framing and composition — every object at precisely the same position, size and outline '
  + 'as in the input — so the depth map lines up pixel for pixel with the original. No color, '
  + 'no text, no borders, nothing added or removed.';

// Upload `blob` (the node's input), get a depth map back, resized to exactly
// width × height so it lines up with the picture it came from. Returns the canvas
// (for the node's texture), a PNG blob (for the gallery), and who made it.
export function cloudDepth(blob, width, height) {
  return run({ what: 'a depth map', prompt: DEPTH_PROMPT, images: [blob], aspect: width / height, width, height });
}

// A prompt, plus any input pictures to work from, → one image at the provider's
// own resolution, as close to `aspect` (w / h) as it offers.
export function cloudGenerate({ prompt, images = [], aspect = 1 }) {
  return run({ what: 'an image', prompt, images, aspect });
}
