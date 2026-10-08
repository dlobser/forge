# Forge — a node-free image studio

Forge turns a single image into a playground: import it, generate a depth map,
push it through GPU shader effects or ComfyUI workflows, and chain those together
so one output feeds the next. Everything you make lands in one per-project gallery
that every shader and workflow can draw from.

Built to sit next to the **Zoom** project and reuse its ComfyUI patterns. It does
**not** touch any existing code — only the new `forge_server/`, `web/`, `shaders/`,
and `projects/` directories, plus a couple of root files.

## Run it

```
start.bat                     :: first run makes a venv, installs deps, serves :8191
```

Then open <http://127.0.0.1:8191> — the node editor. ComfyUI is expected separately on
`127.0.0.1:8188` (change host/port in ⚙ Settings). Shaders work with no ComfyUI;
only depth maps and AI generation need it.

- Backend: FastAPI, `python -m forge_server.server [--port N]` (default 8191).
- Front-end is plain ES modules + WebGL2 — edit & refresh, no build step.
  **Backend changes need a server restart.**

## Layout

```
forge_server/      FastAPI backend
  config.py        settings.json (app) + per-project project.json load/save + paths
  comfy.py         ComfyUI client: upload, object_info, queue, wait, fetch outputs
  workflows.py     scan dir, UI→API convert, {tag} + auto param discovery, patch
  projects.py      import (+optional crop/scale), save outputs, gallery, thumbnails
  depth.py         depth-map recipes (DepthAnythingV2 / WAS MiDaS / controlnet_aux)
  video.py         frame sequences → ffmpeg mp4
  server.py        routes + static mounts
web/               front-end (index.html, css/, js/)
shaders/           effect triplets — scanned (see "Adding a shader")
projects/<Name>/   sourceimages/  sequences/<name>/  videos/  project.json  .thumbs/
Workflows/         the ComfyUI workflows that auto-populate the AI tab (configurable)
```

Images are saved with the project name prepended, e.g. `MyProj_portrait.png`,
`MyProj__Color Grade.png` (shader), `MyProj__txt2img.png` (AI). Each image gets a
sidecar `<file>.json` recording where it came from (inputs + params) so a render
can be read back later. Importing with **reformat** off keeps the original size &
format; on, it center-crops to a square at the chosen power-of-two size.

## The four tabs

- **Shaders** — an expandable array of shader-effect instances. Each has a name,
  a color + (optional) depth input picked from the gallery, auto-generated control
  sliders, an output size (powers of two), and **Render → gallery**. Animated
  effects get transport + **Render sequence** → **Make video** (the resolved
  ffmpeg command is shown and copyable). The selected effect previews live on the
  right; moving a slider updates it immediately.
- **AI** — one card per workflow in the `Workflows/` folder. Exposed parameters and
  image-input slots are discovered automatically (see below); **Generate → gallery**
  patches the graph, runs it in ComfyUI, and saves the result.
- **Chain** — pick a source image and an ordered list of any shader/AI effects; Run
  processes them one at a time, each output feeding the next. Intermediates are
  saved to the gallery.
- **Gallery** — thumbnails of every image, badged by origin (import / shader / ai /
  depth). Click for full screen; ✕ deletes.

## Adding a shader

Drop three files sharing a basename into `shaders/` (the `.vert` is optional —
it falls back to the shared fullscreen-triangle `_fullscreen.vert`):

```
myEffect.frag    #version 300 es fragment shader
myEffect.vert    (optional) custom vertex shader
myEffect.js      manifest: name, category, animated, inputs, controls
```

The manifest is an ES module default-export:

```js
export default {
  name: "My Effect",
  category: "effect",              // which Add-node menu it files under (see below)
  animated: false,                 // true → render loop + sequence/video
  history: false,                  // true → gets its own previous output as uPrev
  inputs: ["color", "depth"],      // textures it uses
  inputDefaults: { depth: "gray" },// solid to use when an input is unconnected
  outputs: ["out"],                // more than one → several output pins (see below)
  controls: [
    { uniform: "uAmount", label: "Amount", type: "range", min: 0, max: 1, step: 0.01, value: 0.5 },
    { uniform: "uTint",   label: "Tint",   type: "color", value: [1, 1, 1] },
    { uniform: "uOn",     label: "Enable", type: "bool",  value: true },
  ],
};
```

Every `controls[].uniform` is set on the program each frame. The engine always
provides `uColor` (unit 0), `uDepth` (unit 1, grey if unset), `uResolution`
(vec2), `uTime` (float, seconds) and `uFrame`. Files starting with `_` are
ignored. Restart not required — the front-end re-scans on load.

`category` is the whole node type: a manifest saying `category: "effect"`
registers as `effect/myEffect`, and litegraph's Add-node menu is built from those
prefixes. Use one of **input · image · effect · generate · feedback · cellular ·
depth**, or invent one — a new category just appears in the menu. Graphs saved
before categories existed name their nodes `forge/shader/<key>`; those names are
resolved to the new ones on load (see `LEGACY` in nodes.js) and rewritten on the
next save.

**Several outputs.** `outputs: ["selected", "R", "G", "B", "A"]` gives the node one
IMAGE pin per name. The node renders the same program once per pin with `uOutput`
set to that pin's index, so the shader branches on it — see splitChannels.frag. The
first pin is what the node's thumbnail and fullscreen show. Not available on a
stateful shader (one draw per pin would step its simulation N times a frame).

Three kinds of statefulness, and they are not interchangeable:

| flag              | state kept                                    | for |
| ----------------- | --------------------------------------------- | --- |
| *(none)*          | none — re-renders when inputs/params change   | ordinary effects |
| `animated: true`  | none; gets a live `uTime` + an animate toggle | time-driven looks |
| `history: true`   | its own last output as `uPrev`, at full res   | trails, video feedback, random walk |
| `feedback: true`  | a square `simSize` RGBA32F grid, 3 `uPass` phases | cellular simulations |

A `history`/`feedback` shader steps once per frame while the transport is playing
and is frozen by pause. Its state survives changes to its inputs — swapping the
image feeding a Kuramoto field steers the running simulation instead of reseeding
it; only ↺ reset, a sim-grid change, or a resolution change starts over.

A `feedback` shader may also widen its state and its step, which is what a real
solver needs (fluid.frag uses both):

```js
simSizes: [128, 256, 512, 1024],          // what the "sim grid" combo offers
simBuffers: 2,                            // N ping-pong RGBA32F grids, written by MRT
simPasses: [1, 2, 3, { stage: 4, repeat: "uPressureIters" }, 5],
```

`simBuffers: N` means the shader declares `layout(location = i) out vec4` per buffer
and reads `uState0 … uStateN-1` (with N = 1 it stays the plain `uState`). Every pass
writes every buffer, so a pass that only touches one copies the others through.
`simPasses` runs more than one step pass per frame, in order, with `uStage` set to
each entry's number and `uIter` to the repeat index; a `repeat` may name a control
uniform, which is how a pressure solve takes its iteration count from a slider.

**Sampling.** Every texture is point-filtered (`NEAREST`), so a long chain doesn't
accumulate a little bilinear softness at every hop. Shaders that genuinely need
sub-pixel sampling do their own bilinear fetch — see `bilinear()` in
videoFeedback.frag — and the **Anti-alias** node (FXAA) is the smoothing pass to
put at the end of a chain.

## Tagging a ComfyUI workflow

Workflows in `Workflows/` may be either ComfyUI **API** format or a normal **UI**
export — Forge converts UI exports to API on the fly (reading the widget
annotations modern ComfyUI embeds, swallowing `control_after_generate`, resolving
Reroutes). Which controls appear in the UI:

1. **Inline tags** in any string widget value — the convention you asked for:

   ```
   {positive prompt:"a grassy hill"}     → text control, default "a grassy hill"
   {denoise:0.5}                         → number control, default 0.5
   {strength}                            → number control, default 0
   {image:portrait}                      → marks a LoadImage slot named "portrait"
   ```

   A tag can sit inside a longer string; only the `{...}` is replaced at run time.
   Text widgets (prompts) can be tagged right inside ComfyUI; numeric widgets are
   easiest to tag by editing the saved JSON (Forge substitutes the value before
   submitting, so a string in a float slot is fine).

2. **Auto-detection** — even with zero tags, the common knobs surface
   automatically: KSampler seed/steps/cfg/denoise/sampler/scheduler, CLIPTextEncode
   text (labeled Positive/Negative by following the sampler), EmptyLatentImage
   width/height, checkpoint/lora/sampler combos. Every `LoadImage` becomes an
   image-input slot. Prompts and tagged params show up top; the rest sit under
   **Advanced**.

Exposure overrides (hide / relabel / reorder params) are stored in a sidecar
`Workflows/<name>.forge.json` — your workflow files themselves are never modified.

## Depth maps

`depth.py` tries, in order: **DepthAnything_V2** (kijai loader + estimator),
**MiDaS Depth Approximation** (WAS Node Suite), then any single preprocessor from
`settings.depth.preprocessors` (controlnet_aux). The status pill shows which one
is active (or "no depth"). The "⚙ gen" button on a shader's depth slot generates a
depth map from its color image and saves it to the gallery.

## Local AI vs Cloud AI

The graph's AI nodes come in two categories:

- **local ai** — runs through ComfyUI on this machine: every workflow in
  `Workflows/` (`AI: …`) and **Depth (ComfyUI)**, the DepthAnything bake above.
- **cloud ai** — runs on **ChatGPT** (OpenAI `gpt-image-2` by default) or **Gemini**
  (Nano Banana, `gemini-nano-banana-2.1` by default), whichever ⚙ Settings ▸
  *Cloud AI* selects. **Depth (Cloud AI)** sends its input with a depth prompt and
  gets a white-near / black-far map back, resized to the input. **Generate (Cloud
  AI)** turns a prompt into an image; connect a picture to its `image` input and it is
  sent along with the prompt (an edit). Generate never runs on its own — only on
  **✦ Generate** — since every call is billed.

The Cloud AI dialog holds a key, model and quality/resolution per provider, plus a
radio for which one the nodes use. It all runs in the browser (`cloudai.js`, with
`openai.js` / `gemini.js` as the two adapters): keys live in that browser's
localStorage and go only to that provider — never to the Forge server, graph.json or a
share link. So cloud nodes work on the static/published build too, where a graph with
one gets a **✦ AI** button for visitors to enter their own key. While a cloud call is
in flight the node shows a spinner and clock, and the page shows a "ChatGPT is making
an image… 0:23" pill — calls take ten seconds to a couple of minutes.

Graphs saved before the split name their nodes `ai/depth` and `ai/<workflow>`; they
load as the local versions.

A Depth node records a 16×16 signature of the input its map was made from
(`properties.srcSig`), so reopening a graph or loading the published page reuses the
saved map instead of re-baking (and re-billing); only a different input re-bakes, or
the node's **↻ regenerate** button.

## ffmpeg / video

Animated shaders render a frame sequence to `projects/<Name>/sequences/<effect>/`,
then ffmpeg encodes `projects/<Name>/videos/<effect>.mp4`. The command template
lives in Settings (placeholders `{fps} {start} {frames_in} {out}`); the resolved
command is shown in the effect card and copyable.

The web build has no ffmpeg, so there the **Sequence → Video** node encodes in the
browser instead (`web/graph/js/videoexport.js`) and downloads the result. Its
`export` combo reads *mp4* (WebCodecs H.264, muxed by the vendored
`web/graph/vendor/mp4-muxer.js`), *zipped frames* (`<name>/frame_00000.png` …, the
desktop's sequence folder layout), or
*zip: frames + mp4* — the same three stored values as the desktop's *video*,
*frames* and *frames + video*, so a graph means the same thing in both builds.

In the graph, the **Sequence → Video** node's `start` decides where a render
begins. *where it is* (the default) records from the graph's current state and
time: frame 0 is the frame on screen, and simulations, particles, trails and
drawing clips carry on from there, as does the clock afterwards. *reset first*
reseeds all of those and starts the clock at 0.

## Ports & conventions

- Forge 8191, ComfyUI 8188. Sibling Zoom uses 8189/8190/8200 — no collision.
- `.claude/launch.json` defines the `forge` server for the preview tooling.
- User is an artist (David Lobser); prefers concise answers and a dark, QLab-style
  UI; iterates feature-by-feature with quick visual verification.
