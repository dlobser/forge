// blur — Gaussian blur with an optional per-pixel mask.
//
//   Color slot → the image to blur.
//   Depth slot → optional B&W mask (white = blur, black = keep sharp).
//
// Radius sets the blur spread. When a mask is connected the blur amount at each
// pixel is modulated by the mask's luminance, giving a smooth depth-of-field /
// selective-focus effect. Invert flips the mask sense.
export default {
  name: "Blur",
  animated: false,
  inputs: ["color", "depth"],
  inputLabels: { color: "image", depth: "mask" },
  controls: [
    { uniform: "uRadius",  label: "Radius",      type: "range", min: 0, max: 40, step: 0.5, value: 6 },
    { uniform: "uQuality", label: "Quality",      type: "range", min: 2, max: 16, step: 1, value: 8 },
    { uniform: "uUseMask", label: "Use Mask",     type: "bool", value: false },
    { uniform: "uInvert",  label: "Invert Mask",  type: "bool", value: false },
  ],
};
