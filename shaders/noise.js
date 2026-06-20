// noise — animated classic Perlin (gradient) noise with fbm octaves. A generator
// (no color/depth), but it takes an optional "distort" input that warps the noise
// UVs — feed noise into noise for domain-warped patterns. Time scrolls the 3rd
// dimension so it evolves smoothly rather than just sliding.
export default {
  name: "Noise",
  animated: true,
  inputs: ["distort"],
  inputLabels: { distort: "distort" },
  controls: [
    { uniform: "uScale",      label: "Scale",       type: "range", min: 0.5, max: 16, step: 0.1,  value: 4 },
    { uniform: "uOctaves",    label: "Octaves",     type: "range", min: 1, max: 8,    step: 1,    value: 5 },
    { uniform: "uLacunarity", label: "Lacunarity",  type: "range", min: 1.5, max: 3,  step: 0.01, value: 2 },
    { uniform: "uGain",       label: "Gain",        type: "range", min: 0.2, max: 0.8, step: 0.01, value: 0.5 },
    { uniform: "uSpeed",      label: "Speed",       type: "range", min: 0, max: 2,    step: 0.01, value: 0.3 },
    { uniform: "uScrollX",    label: "Scroll X",    type: "range", min: -2, max: 2,   step: 0.01, value: 0 },
    { uniform: "uScrollY",    label: "Scroll Y",    type: "range", min: -2, max: 2,   step: 0.01, value: 0 },
    { uniform: "uDistortAmt", label: "Distort In",  type: "range", min: -1, max: 1,   step: 0.005, value: 0 },
    { uniform: "uRadial",     label: "Radial",      type: "bool",  value: true },
    { uniform: "uCenterX",    label: "Distort Cx",  type: "range", min: 0, max: 1,    step: 0.005, value: 0.5 },
    { uniform: "uCenterY",    label: "Distort Cy",  type: "range", min: 0, max: 1,    step: 0.005, value: 0.5 },
    { uniform: "uContrast",   label: "Contrast",    type: "range", min: 0.5, max: 3,  step: 0.01, value: 1 },
    { uniform: "uRidged",     label: "Ridged",      type: "bool",  value: false },
    { uniform: "uColorA",     label: "Low Color",   type: "color", value: [0, 0, 0] },
    { uniform: "uColorB",     label: "High Color",  type: "color", value: [1, 1, 1] },
  ],
};
