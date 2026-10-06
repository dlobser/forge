// openai.js — the OpenAI (ChatGPT / gpt-image) adapter for the Cloud AI nodes.
//
// Called straight from the browser: api.openai.com answers CORS, so no proxy is
// needed, which is what lets it work on the published web build too. Settings, the
// key dialog and the busy indicator live in cloudai.js; this file only knows how to
// turn a prompt (and optional input pictures) into one image.
export const OPENAI_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'];
export const OPENAI_QUALITIES = ['low', 'medium', 'high'];
const BASE = 'https://api.openai.com/v1/images/';

// gpt-image-2 takes any WxH (multiples of 16, ratio up to 3:1), so ask for the wanted
// aspect at about a megapixel; older models only offer three fixed sizes.
function requestSize(model, aspect) {
  const r = Math.min(3, Math.max(1 / 3, aspect || 1));
  if (/^gpt-image-2/.test(model)) {
    const area = 1024 * 1024;
    const q = (v) => Math.max(16, Math.round(v / 16) * 16);
    return q(Math.sqrt(area * r)) + 'x' + q(Math.sqrt(area / r));
  }
  return r > 1.2 ? '1536x1024' : r < 1 / 1.2 ? '1024x1536' : '1024x1024';
}

async function call(path, init, key) {
  init.headers = Object.assign({ Authorization: 'Bearer ' + key }, init.headers || {});
  const r = await fetch(BASE + path, Object.assign({ method: 'POST' }, init));
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) {
    const err = new Error((j && j.error && j.error.message) || ('OpenAI error ' + r.status));
    err.status = r.status;
    throw err;
  }
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return b64;
}

// With pictures it's an image edit (multipart), without it's a plain generation
// (JSON). Returns the result as base64 PNG.
export async function openaiImage({ key, model, quality, prompt, images = [], aspect = 1 }) {
  const fields = { model, prompt, size: requestSize(model, aspect), quality, output_format: 'png' };
  const send = () => {
    if (!images.length) {
      return call('generations', { headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ n: 1 }, fields)) }, key);
    }
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    // keep the input's detail (faces, layout) instead of loosely re-imagining it
    if (/^gpt-image-1(\.5)?$/.test(model)) fd.append('input_fidelity', 'high');
    if (images.length === 1) fd.append('image', images[0], 'image.png');
    else images.forEach((b, i) => fd.append('image[]', b, 'image' + i + '.png'));
    return call('edits', { body: fd }, key);
  };
  try { return await send(); }
  catch (e) {
    // a model that won't take our size: let it choose — callers resize afterwards
    if (e.status !== 400 || !/size/i.test(e.message) || fields.size === 'auto') throw e;
    fields.size = 'auto';
    return send();
  }
}
