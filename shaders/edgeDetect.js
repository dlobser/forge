// edgeDetect — realtime Sobel edge detection.
//
// Image slot → source image.
// Strength controls edge brightness.
// Threshold removes weak edges.
// Invert switches between white edges on black and black edges on white.
// Grayscale outputs a monochrome edge mask.
// Preserve Color keeps the original image color around detected edges.

export default {
  name: "Edge Detect",
  animated: false,
  inputs: ["color"],
  inputLabels: { color: "image" },
  controls: [
    { uniform: "uStrength",      label: "Strength",       type: "range", min: 0.1, max: 10.0, step: 0.1, value: 2.0 },
    { uniform: "uThreshold",     label: "Threshold",      type: "range", min: 0.0, max: 1.0, step: 0.01, value: 0.15 },
    { uniform: "uThickness",     label: "Thickness",      type: "range", min: 0.5, max: 5.0, step: 0.1, value: 1.0 },
    { uniform: "uSoftness",      label: "Softness",       type: "range", min: 0.001, max: 0.5, step: 0.001, value: 0.05 },
    { uniform: "uInvert",        label: "Invert",         type: "bool", value: false },
    { uniform: "uPreserveColor", label: "Preserve Color", type: "bool", value: false },
  ],
};