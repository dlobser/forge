// Cellular Automata — Contrast-driven self-organizing fractal & dither automata.
// High-contrast edges in Image A catalyze continuous life, dither crystallization,
// or Turing pattern emergence.
export default {
  name: "Cellular Automata",
  category: "cellular",
  animated: true,
  feedback: true,
  simSize: 256,
  inputs: ["color", "depth"],
  inputLabels: { color: "Image A (Contrast & Feed)", depth: "Image B (Mask)" },
  controls: [
    { uniform: "uMode", label: "Automata Mode", type: "select", value: 0,
      options: [
        { label: "Continuous Life (SmoothLife)", value: 0 },
        { label: "Dither Crystallizer", value: 1 },
        { label: "Turing Reaction-Diffusion", value: 2 },
        { label: "Contour Advection", value: 3 },
      ]
    },
    { uniform: "uContrastDrive", label: "Contrast Drive", type: "range", min: 0, max: 3, step: 0.05, value: 1.2 },
    { uniform: "uDitherStrength", label: "Dither Lattice", type: "range", min: 0, max: 1, step: 0.01, value: 0.3 },
    { uniform: "uDt", label: "Time Step (dt)", type: "range", min: 0.01, max: 0.3, step: 0.01, value: 0.1 },
    { uniform: "uInnerRad", label: "Inner Radius", type: "range", min: 1, max: 3, step: 1, value: 1 },
    { uniform: "uOuterRad", label: "Outer Radius", type: "range", min: 2, max: 6, step: 1, value: 3 },
    { uniform: "uBirthMin", label: "Birth Min", type: "range", min: 0.05, max: 0.5, step: 0.01, value: 0.2 },
    { uniform: "uBirthMax", label: "Birth Max", type: "range", min: 0.2, max: 0.6, step: 0.01, value: 0.4 },
    { uniform: "uSurvMin", label: "Surv Min", type: "range", min: 0.1, max: 0.6, step: 0.01, value: 0.25 },
    { uniform: "uSurvMax", label: "Surv Max", type: "range", min: 0.4, max: 0.9, step: 0.01, value: 0.75 },
    { uniform: "uFeed", label: "Image Feed", type: "range", min: 0, max: 1, step: 0.01, value: 0.3 },
    { uniform: "uDecay", label: "Decay Rate", type: "range", min: 0, max: 0.2, step: 0.005, value: 0.02 },
    { uniform: "uSharpness", label: "Sharpness", type: "range", min: 0, max: 1, step: 0.01, value: 0.5 },
    { uniform: "uSeedMode", label: "Seed Source", type: "select", value: 1,
      options: [
        { label: "Image Luminance", value: 0 },
        { label: "Image Edges + Noise", value: 1 },
        { label: "Random Noise", value: 2 },
      ]
    },
    { uniform: "uDisplayMode", label: "Display Style", type: "select", value: 0,
      options: [
        { label: "Image Colorized", value: 0 },
        { label: "Neon Cyberpunk", value: 1 },
        { label: "Monochrome Dither", value: 2 },
        { label: "Composite Overlay", value: 3 },
      ]
    },
    { uniform: "uMix", label: "Mix Result", type: "range", min: 0, max: 1, step: 0.01, value: 1.0 },
  ],
};
