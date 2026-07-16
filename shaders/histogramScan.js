// histogramScan — grayscale histogram scan / threshold shaping.
//
// Image slot → grayscale or color input.
//
// Position decides where the scan threshold sits.
// Contrast controls how hard/soft the transition is.
//
// Binary Output:
//   false → smooth grayscale transition
//   true  → strict black / white mask, suitable for Flood Fill
//
// Invert flips black and white.
//
// Best used on grayscale inputs such as:
//   Distance → Histogram Scan
//
// For connected-region workflows:
//   Distance → Histogram Scan (Binary Output ON) → Flood Fill

export default {
  name: "Histogram Scan",
  animated: false,

  inputs: ["color"],

  inputLabels: {
    color: "image"
  },

  controls: [
    {
      uniform: "uPosition",
      label: "Position",
      type: "range",
      min: 0.0,
      max: 1.0,
      step: 0.01,
      value: 0.5
    },
    {
      uniform: "uContrast",
      label: "Contrast",
      type: "range",
      min: 0.0,
      max: 64.0,
      step: 0.1,
      value: 8.0
    },
    {
      uniform: "uBinary",
      label: "Binary Output",
      type: "bool",
      value: true
    },
    {
      uniform: "uInvert",
      label: "Invert",
      type: "bool",
      value: false
    }
  ],
};