// blend — composite two images with a selectable blend mode.
//
//   Color slot → image A (the base).
//   Depth slot → image B (blended on top).
//
// Mix fades between the base and the blended result; Swap flips which image is
// the base (matters for the non-symmetric modes like Overlay).
export default {
  name: "Blend",
  category: "image",
  animated: false,
  inputs: ["color", "depth"],
  controls: [
    { uniform: "uMode", label: "Mode", type: "select", value: 0, options: [
      { value: 0, label: "Add" },
      { value: 1, label: "Multiply" },
      { value: 2, label: "Difference" },
      { value: 3, label: "Overlay" },
      { value: 4, label: "Screen" },
    ] },
    { uniform: "uMix",  label: "Mix",  type: "range", min: 0, max: 1, step: 0.01, value: 1 },
    { uniform: "uSwap", label: "Swap A/B", type: "bool", value: false },
  ],
};
