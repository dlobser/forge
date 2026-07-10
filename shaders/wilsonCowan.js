// Wilson-Cowan V1 — hypercolumn simulation with orientation column tiling
//
//   Image A (Color) -> Spatial External Drive
//   Image B (Depth) -> Spatial modulation of lateral connections
//
// Implements local orientation convolution, long-range lateral coupling,
// and perpendicular coupling on a packed 4x4 orientation tile layout.
export default {
  name: "Wilson-Cowan V1",
  animated: true,
  feedback: true,
  simSize: 256,
  inputs: ["color", "depth"],
  inputLabels: { color: "Image A (Drive)", depth: "Image B (Nu Mod)" },
  controls: [
    // Simulation parameters
    { uniform: "uDt",           label: "Time step (dt)",     type: "range",  min: 0.005, max: 0.16, step: 0.005, value: 0.04 },
    { uniform: "uAlpha",        label: "Passive decay (α)",  type: "range",  min: 0,     max: 3,    step: 0.01,  value: 1.0 },
    { uniform: "uMu",           label: "Local coupling (μ)", type: "range",  min: -4,    max: 6,    step: 0.05,  value: 2.2 },
    { uniform: "uNu",           label: "Lateral coupling (ν)",type: "range",  min: -3,    max: 4,    step: 0.05,  value: 0.75 },
    { uniform: "uRho",          label: "Perp coupling (ρ)",  type: "range",  min: -3,    max: 4,    step: 0.05,  value: 0.3 },
    { uniform: "uDrive",        label: "Base drive",         type: "range",  min: -1,    max: 1,    step: 0.01,  value: -0.04 },
    { uniform: "uDriveImage",   label: "Image A → Drive",    type: "range",  min: 0,     max: 2,    step: 0.05,  value: 0.5 },
    { uniform: "uNuDepth",      label: "Image B → Mod",      type: "range",  min: 0,     max: 1,    step: 0.05,  value: 0.0 },
    { uniform: "uNoise",        label: "Noise level",        type: "range",  min: 0,     max: 1,    step: 0.01,  value: 0.1 },
    { uniform: "uBeta",         label: "Steepness (β)",      type: "range",  min: 0.5,   max: 24,   step: 0.1,   value: 8.0 },
    { uniform: "uTheta",        label: "Threshold (θ)",      type: "range",  min: -1,    max: 1.5,  step: 0.01,  value: 0.18 },

    // Local orientation kernel
    { uniform: "uLocalExcAmp",   label: "Local Exc Amp",      type: "range",  min: 0,     max: 4,    step: 0.05,  value: 1.2 },
    { uniform: "uLocalExcWidth", label: "Local Exc Width (°)",type: "range",  min: 2,     max: 60,   step: 1,     value: 13 },
    { uniform: "uLocalInhAmp",   label: "Local Inh Amp",      type: "range",  min: 0,     max: 4,    step: 0.05,  value: 0.68 },
    { uniform: "uLocalInhWidth", label: "Local Inh Width (°)",type: "range",  min: 4,     max: 90,   step: 1,     value: 55 },
    { uniform: "uLocalShift",    label: "Local Shift (°)",    type: "range",  min: -45,   max: 45,   step: 0.5,   value: 0 },

    // Lateral kernel
    { uniform: "uLateralExcAmp",  label: "Lat Exc Amp",        type: "range",  min: 0,     max: 3,    step: 0.05,  value: 0.78 },
    { uniform: "uLateralExcSigma",label: "Lat Exc Sigma",      type: "range",  min: 0.5,   max: 8,    step: 0.1,   value: 2.2 },
    { uniform: "uLateralInhAmp",  label: "Lat Inh Amp",        type: "range",  min: 0,     max: 3,    step: 0.05,  value: 0.34 },
    { uniform: "uLateralInhSigma",label: "Lat Inh Sigma",      type: "range",  min: 1,     max: 18,   step: 0.1,   value: 7.0 },
    { uniform: "uLateralRadius",  label: "Lat Radius (cells)",  type: "range",  min: 2,     max: 18,   step: 1,     value: 10 },
    { uniform: "uLateralShift",   label: "Lat Shift (cells)",   type: "range",  min: -8,    max: 8,    step: 0.1,   value: 0 },

    // Perpendicular kernel
    { uniform: "uPerpExcAmp",     label: "Perp Exc Amp",       type: "range",  min: 0,     max: 3,    step: 0.05,  value: 0.6 },
    { uniform: "uPerpExcSigma",   label: "Perp Exc Sigma",     type: "range",  min: 0.5,   max: 8,    step: 0.1,   value: 1.8 },
    { uniform: "uPerpInhAmp",     label: "Perp Inh Amp",       type: "range",  min: 0,     max: 3,    step: 0.05,  value: 0.28 },
    { uniform: "uPerpInhSigma",   label: "Perp Inh Sigma",     type: "range",  min: 1,     max: 18,   step: 0.1,   value: 5.5 },
    { uniform: "uPerpRadius",     label: "Perp Radius (cells)", type: "range",  min: 2,     max: 18,   step: 1,     value: 8 },
    { uniform: "uPerpShift",      label: "Perp Shift (cells)",  type: "range",  min: -8,    max: 8,    step: 0.1,   value: 0 },

    // Display / Visualization
    { uniform: "uExposure",      label: "Display Exposure",   type: "range",  min: 0.25,  max: 8,    step: 0.05,  value: 2.1 },
    { uniform: "uOsiScale",      label: "OSI Saturation",     type: "range",  min: 0.1,   max: 5.0,  step: 0.1,   value: 1.5 },
    { uniform: "uDisplayMode",   label: "Display Mode",       type: "select", value: 1,
      options: [
        { label: "Heatmap (Firing)", value: 0 },
        { label: "V1 Orientation Map", value: 1 },
        { label: "Debug (4x4 Texture)", value: 2 },
      ]
    }
  ]
};
