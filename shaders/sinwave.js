// sinwave — drive a sine wave with a black & white image:
//   out = sin(luma * freq * 2pi + time * speed) * Multiply + Add
// Multiply/Add are free numbers (set them as large as you like). The defaults
// Multiply .5 / Add .5 map the wave to 0..1 instead of -1..1.
export default {
  name: "Sine Wave",
  category: "generate",
  animated: true,
  inputs: ["color"],
  inputLabels: { color: "image" },
  controls: [
    { uniform: "uFreq",  label: "Frequency", type: "range",  min: 0, max: 40, step: 0.1,  value: 6 },
    { uniform: "uSpeed", label: "Speed",     type: "range",  min: -8, max: 8, step: 0.05, value: 1 },
    { uniform: "uMult",  label: "Multiply",  type: "number", step: 0.1, value: 0.5 },
    { uniform: "uAdd",   label: "Add",       type: "number", step: 0.1, value: 0.5 },
  ],
};
