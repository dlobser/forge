// distort — warp the colour input by the GRADIENT of the distort input's luminance
// (push UVs uphill/downhill in brightness, not just by the raw value). Feed an SDF
// or noise into "distort". Unconnected distort → flat grey → no warp.
export default {
  name: "Distort",
  inputs: ["color", "distort"],
  inputLabels: { color: "color", distort: "distort" },
  controls: [
    { uniform: "uAmount", label: "Amount", type: "range", min: -0.5, max: 0.5, step: 0.002, value: 0 },
    { uniform: "uSample", label: "Sample", type: "range", min: 0.5, max: 8, step: 0.1, value: 2 },
  ],
};
