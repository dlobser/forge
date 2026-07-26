// erosion — grow the white pixels of a B&W image outward in a darkening
// gradient until they fill the frame. Put the B&W image in the COLOR slot.
//
// The engine is single-pass, so rather than iterating frame-to-frame this does
// a radial distance search per pixel: brightness falls off with distance to the
// nearest white seed (each ring "a little darker"), reaching black at Spread.
// Bands quantises that falloff into discrete darkening steps. Invert flips the
// seed so the BLACK pixels grow into white instead.
export default {
  name: "Erosion",
  category: "effect",
  animated: false,
  inputs: ["color"],
  controls: [
    { uniform: "uThreshold", label: "Seed Threshold", type: "range", min: 0, max: 1,   step: 0.01, value: 0.5 },
    { uniform: "uSpread",    label: "Spread",          type: "range", min: 0.02, max: 1, step: 0.01, value: 0.4 },
    { uniform: "uSteps",     label: "Quality",         type: "range", min: 4, max: 64,  step: 1,    value: 28 },
    { uniform: "uFalloff",   label: "Falloff",         type: "range", min: 0.25, max: 3, step: 0.01, value: 1 },
    { uniform: "uBands",     label: "Bands (0=smooth)",type: "range", min: 0, max: 24,  step: 1,    value: 0 },
    { uniform: "uInvert",    label: "Erode Black",     type: "bool",  value: false },
    { uniform: "uTint",      label: "Tint",            type: "color", value: [1, 1, 1] },
  ],
};
