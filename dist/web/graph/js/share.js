// share.js — turn a graph into a link and back.
//
// A shared front-end travels entirely inside the URL's #fragment: the graph JSON is
// deflated and base64url-encoded, so nothing is uploaded and no server is involved.
// Images are NOT embedded — a shareable graph references them through URL Image
// nodes, which keeps the payload to a few kB even for image-heavy scenes.
//
//   play.html#g=<payload>        open the authored front-end
//   play.html#g=<payload>&e=0    ...with the Edit button hidden (creator's choice)
//   index.html#g=<payload>       open the graph in the editor (a fork)
//
// The payload's first character is a scheme tag so we can evolve the format:
//   '1' deflate-raw + base64url   (normal)
//   '0' base64url(JSON)           (fallback when CompressionStream is missing)

const hasCompression = typeof CompressionStream !== 'undefined'
  && typeof DecompressionStream !== 'undefined';

function bytesToB64url(bytes) {
  let bin = '';
  const chunk = 0x8000;                       // avoid apply() arg-count limits
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function streamThrough(Ctor, bytes) {
  const s = new Ctor('deflate-raw');
  const w = s.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(s.readable).arrayBuffer());
}

// ── graph <-> payload ────────────────────────────────────────────────────────
export async function encodeGraph(graph) {
  const json = JSON.stringify(graph);
  const utf8 = new TextEncoder().encode(json);
  if (hasCompression) return '1' + bytesToB64url(await streamThrough(CompressionStream, utf8));
  return '0' + bytesToB64url(utf8);
}

export async function decodeGraph(payload) {
  if (!payload) throw new Error('empty share payload');
  const scheme = payload[0], body = payload.slice(1);
  const bytes = b64urlToBytes(body);
  let utf8;
  if (scheme === '1') {
    if (!hasCompression) throw new Error('this browser cannot read compressed share links');
    utf8 = await streamThrough(DecompressionStream, bytes);
  } else if (scheme === '0') {
    utf8 = bytes;
  } else {
    throw new Error('unrecognized share link');
  }
  return JSON.parse(new TextDecoder().decode(utf8));
}

// ── the #fragment ────────────────────────────────────────────────────────────
// Hand-parsed rather than via URLSearchParams so the (long) payload stays first
// and untouched; only the short flags after it are key=value.
export function readHash(hash) {
  const h = (hash || location.hash).replace(/^#/, '');
  if (!h) return {};
  const params = new URLSearchParams(h);
  return { g: params.get('g'), e: params.get('e') };
}

export async function buildPlayLink(graph, { allowEdit = true, base } = {}) {
  const payload = await encodeGraph(graph);
  const url = new URL('play.html', base || location.href);
  url.hash = 'g=' + payload + (allowEdit ? '' : '&e=0');
  return url.toString();
}

export function buildEditLink(payload, base) {
  const url = new URL('index.html', base || location.href);
  url.hash = 'g=' + payload;
  return url.toString();
}

// ── shareability check (surfaced in the editor's Share dialog) ────────────────
// Browser-imported images live only in the author's IndexedDB and cannot travel in
// a link; URL Image nodes can. Report anything that would arrive broken.
export function inspectShareability(graph) {
  const warnings = [];
  const nodes = (graph && graph.nodes) || [];
  const stuck = nodes.filter(function (n) {
    return (n.type === 'forge/import' || n.type === 'forge/source')
      && n.properties && n.properties.file;
  });
  if (stuck.length) {
    warnings.push(stuck.length + ' image' + (stuck.length > 1 ? 's are' : ' is')
      + ' imported into this browser and won’t travel in the link. '
      + 'Swap to a URL Image node so the picture loads from a public URL.');
  }
  const eu = graph && graph.extra && graph.extra.endUser;
  const hasUI = eu && ((eu.controls && eu.controls.length) || (eu.previews && eu.previews.length));
  if (!hasUI) {
    warnings.push('No front-end authored yet — open “Author UI” and expose a '
      + 'preview and some controls, or the shared page will look empty.');
  }
  return { warnings: warnings, ok: warnings.length === 0 };
}
