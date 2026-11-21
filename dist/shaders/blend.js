// blend — composite two images with a selectable blend mode.
//
//   A    → the base image   (sampled as uColor)
//   B    → blended on top   (sampled as uDepth)
//   Mask → where the blend applies (sampled as uMask): white blends, black keeps
//          the base, grey is in between. Unconnected reads white, so the whole
//          frame blends.
//
// Alpha-aware, like a layer in a paint program: B is laid over A with the chosen
// mode, and wherever either one is transparent you just see the other. An
// unconnected A or B is transparent (not grey), so a Blend with only A connected
// passes A through untouched in every mode.
//
// Mix is B's opacity; Swap flips which image is the base (matters for the
// non-symmetric modes like Overlay and Subtract). Invert Mask blends where the
// mask is dark instead.
export default {
  name: "Blend",
  category: "image",
  animated: false,
  inputs: ["color", "depth", "mask"],
  inputLabels: { color: "A", depth: "B", mask: "Mask" },
  inputDefaults: { color: "transparent", depth: "transparent", mask: "white" },
  controls: [
    { uniform: "uMode", label: "Mode", type: "select", value: 0, options: [
      { value: 0, label: "Add" },
      { value: 1, label: "Multiply" },
      { value: 2, label: "Difference" },
      { value: 3, label: "Overlay" },
      { value: 4, label: "Screen" },
      { value: 5, label: "Normal (B over A)" },
      { value: 6, label: "Subtract (A − B)" },
      { value: 7, label: "Lighten" },
      { value: 8, label: "Darken" },
    ] },
    { uniform: "uMix",  label: "Mix",  type: "range", min: 0, max: 1, step: 0.01, value: 1 },
    { uniform: "uSwap", label: "Swap A/B", type: "bool", value: false },
    { uniform: "uMaskInvert", label: "Invert Mask", type: "bool", value: false },
  ],
};
