// hexagonalMosaic — realtime hexagonal mosaic effect.
//
// Color slot → source image.
// Tile Size controls the size of each hexagon.
// Edge controls whether hex boundaries are visible.
// Edge Width controls boundary thickness.

export default {
  name: "Hexagonal Mosaic",
  animated: false,
  inputs: ["color"],
  inputLabels: { color: "image" },
  controls: [
    { uniform: "uTileSize",  label: "Tile Size",  type: "range", min: 8,   max: 120, step: 1,    value: 32 },
    { uniform: "uEdge",      label: "Show Edge",  type: "bool",  value: true },
    { uniform: "uEdgeWidth", label: "Edge Width", type: "range", min: 0.0, max: 0.15, step: 0.005, value: 0.035 },
    { uniform: "uMix",       label: "Mix",        type: "range", min: 0.0, max: 1.0,  step: 0.01,  value: 1.0 },
  ],
};