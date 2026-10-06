// gemini.js — the Google Gemini ("Nano Banana") adapter for the Cloud AI nodes.
//
// Same deal as openai.js: called straight from the browser (the Gemini API answers
// CORS), with the visitor's own key in the x-goog-api-key header — never in the URL.
// Uses models.generateContent with image output; one request handles both a plain
// prompt and a prompt plus input pictures.
export const GEMINI_MODELS = [
  'gemini-nano-banana-2.1',        // Nano Banana 2.1
  'gemini-3.1-flash-image',        // Nano Banana 2
  'gemini-3-pro-image',            // Nano Banana Pro
  'gemini-3.1-flash-lite-image',   // Nano Banana 2 Lite
  'gemini-2.5-flash-image',        // Nano Banana (original)
];
export const GEMINI_SIZES = ['1K', '2K', '4K'];
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
// the aspect ratios Gemini accepts; we send whichever is closest to the one wanted
const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function nearestRatio(aspect) {
  let best = '1:1', err = Infinity;
  for (const r of RATIOS) {
    const [a, b] = r.split(':').map(Number);
    const e = Math.abs(Math.log((a / b) / (aspect || 1)));
    if (e < err) { err = e; best = r; }
  }
  return best;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
    fr.onerror = () => reject(fr.error || new Error('could not read image'));
    fr.readAsDataURL(blob);
  });
}

// Returns the result as base64 (PNG or JPEG — the caller decodes either).
export async function geminiImage({ key, model, size, prompt, images = [], aspect = 1 }) {
  const parts = [{ text: prompt }];
  for (const b of images) parts.push({ inlineData: { mimeType: b.type || 'image/png', data: await blobToBase64(b) } });
  const imageConfig = { aspectRatio: nearestRatio(aspect) };
  // the original Nano Banana has one fixed resolution and rejects imageSize
  if (size && !/^gemini-2\.5/.test(model)) imageConfig.imageSize = size;

  const send = async () => {
    const r = await fetch(BASE + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig },
      }),
    });
    let j = null;
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const err = new Error((j && j.error && j.error.message) || ('Gemini error ' + r.status));
      err.status = r.status;
      throw err;
    }
    return j;
  };

  let j;
  try { j = await send(); }
  catch (e) {
    // a model that doesn't offer this resolution: drop it and take its default
    if (e.status !== 400 || !imageConfig.imageSize || !/size/i.test(e.message)) throw e;
    delete imageConfig.imageSize;
    j = await send();
  }

  const cand = j && j.candidates && j.candidates[0];
  const out = ((cand && cand.content && cand.content.parts) || []);
  const img = out.find((p) => (p.inlineData || p.inline_data) && (p.inlineData || p.inline_data).data);
  if (img) return (img.inlineData || img.inline_data).data;
  // No picture: Gemini says why in text, or flags the prompt as blocked.
  const said = out.map((p) => p.text).filter(Boolean).join(' ').trim();
  const blocked = j && j.promptFeedback && j.promptFeedback.blockReason;
  const why = said || (blocked && 'prompt blocked (' + blocked + ')')
    || (cand && cand.finishReason && cand.finishReason !== 'STOP' && 'stopped: ' + cand.finishReason);
  throw new Error('Gemini returned no image' + (why ? ' — ' + why.slice(0, 200) : ''));
}
