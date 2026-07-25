// floodFill — iterative connected-region labeling.
//
// Input should be a binary mask or edge map.
//
// Default:
//   bright pixels = barriers / walls
//   dark pixels   = fillable regions
//
// Enable Invert Barrier when:
//   dark pixels   = barriers / walls
//   bright pixels = fillable regions
//
// This node uses Forge's feedback / ping-pong system.
//
// alwaysAdvance:
//   Keeps the propagation running even when the global Play button is paused.
//
// resetOnInputChange:
//   Prevents an animated upstream shader such as Distance from resetting
//   Flood Fill every frame.
//
// After changing the input, threshold, inversion or simulation grid,
// press "reset sim" once.

export default {
  name: "Flood Fill",
  animated: false,
  feedback: true,
  alwaysAdvance: true,
  resetOnInputChange: false,
  simSize: 128,

  inputs: ["color"],

  inputLabels: {
    color: "mask"
  },

  controls: [
    {
      uniform: "uBarrierThreshold",
      label: "Barrier Threshold",
      type: "range",
      min: 0.0,
      max: 1.0,
      step: 0.01,
      value: 0.5
    },
    {
      uniform: "uInvertBarrier",
      label: "Invert Barrier",
      type: "bool",
      value: false
    }
  ],
};