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

Then open <http://127.0.0.1:8191>. ComfyUI is expected separately on
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
myEffect.js      manifest: name, animated, inputs, controls
```

The manifest is an ES module default-export:

```js
export default {
  name: "My Effect",
  animated: false,                 // true → render loop + sequence/video
  inputs: ["color", "depth"],      // textures it uses
  controls: [
    { uniform: "uAmount", label: "Amount", type: "range", min: 0, max: 1, step: 0.01, value: 0.5 },
    { uniform: "uTint",   label: "Tint",   type: "color", value: [1, 1, 1] },
    { uniform: "uOn",     label: "Enable", type: "bool",  value: true },
  ],
};
```

Every `controls[].uniform` is set on the program each frame. The engine always
provides `uColor` (unit 0), `uDepth` (unit 1, grey if unset), `uResolution`
(vec2), and `uTime` (float, seconds). Files starting with `_` are ignored.
Restart not required — the front-end re-scans on load. Ships with **depthEdges**
(Laplacian on depth, mixed over color), **colorGrade** (hue/sat/contrast/bright +
smoothstep depth mask), and **depthParallax** (animated depth wobble).

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

## ffmpeg / video

Animated shaders render a frame sequence to `projects/<Name>/sequences/<effect>/`,
then ffmpeg encodes `projects/<Name>/videos/<effect>.mp4`. The command template
lives in Settings (placeholders `{fps} {start} {frames_in} {out}`); the resolved
command is shown in the effect card and copyable.

## Ports & conventions

- Forge 8191, ComfyUI 8188. Sibling Zoom uses 8189/8190/8200 — no collision.
- `.claude/launch.json` defines the `forge` server for the preview tooling.
- User is an artist (David Lobser); prefers concise answers and a dark, QLab-style
  UI; iterates feature-by-feature with quick visual verification.
