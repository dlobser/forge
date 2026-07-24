// Kuramoto Field — a self-organising phase-oscillator simulation (ping-pong).
// `feedback: true` tells the engine to run it as a GPU simulation: each frame it
// reads the previous phase field and writes the next one, then displays it.
// `simSize` is the oscillator grid resolution (output size upscales it smoothly).
// Two images drive it: Image A's brightness -> natural frequency, Image B's ->
// local coupling. Try: assign a depth map to A, a photo to B, raise the two
// "Image ->" sliders, and lower dt for slower, smoother evolution.
export default {
  name: "Kuramoto Field",
  animated: true,
  feedback: true,
  simSize: 256,
  inputs: ["color", "depth"],
  inputLabels: { color: "Image A → freq", depth: "Image B → coupling" },
  controls: [
    { uniform: "uK",          label: "Coupling (K)",     type: "range", min: 0, max: 12, step: 0.1, value: 4 },
    { uniform: "uAlpha",      label: "Phase lag (α)",    type: "range", min: 0, max: 1.57, step: 0.01, value: 0.2 },
    { uniform: "uDt",         label: "Time step (dt)",   type: "range", min: 0.01, max: 0.3, step: 0.005, value: 0.1 },
    { uniform: "uNoise",      label: "Freq spread",      type: "range", min: 0, max: 3, step: 0.01, value: 0.2 },
    { uniform: "uFreqA",      label: "Image A → freq",   type: "range", min: 0, max: 4, step: 0.01, value: 0 },
    { uniform: "uCoupB",      label: "Image B → coupling", type: "range", min: 0, max: 1, step: 0.01, value: 0 },
    { uniform: "uSeedA",      label: "Seed phase from A", type: "bool", value: true },
    { uniform: "uDisplayMode", label: "Display", type: "select", value: 0,
      options: [
        { label: "Hue (phase)", value: 0 },
        { label: "Grayscale wave", value: 1 },
        { label: "Sync (order)", value: 2 },
      ] },
  ],
};
