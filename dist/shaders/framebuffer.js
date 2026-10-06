// Framebuffer — 1-frame delay buffer, feedback loop, and temporal difference node.
// Uses `history: true` to store the previous frame buffer at full render resolution.
export default {
  name: "Framebuffer",
  category: "feedback",
  animated: true,
  history: true,
  inputs: ["color", "hold"],
  inputLabels: { color: "image", hold: "freeze mask" },
  inputDefaults: { hold: "black" },
  controls: [
    { uniform: "uMode", label: "Mode", type: "select", value: 1,
      options: [
        { label: "Frame Difference (|A - B|)", value: 1 },
        { label: "Signed Difference (A - B)", value: 2 },
        { label: "Motion Mask", value: 3 },
        { label: "Delayed 1 Frame", value: 0 },
        { label: "Temporal Blend / Feedback", value: 4 },
        { label: "Freeze Snapshot Compare", value: 5 },
      ]
    },
    { uniform: "uFreeze", label: "Freeze Snapshot", type: "bool", value: false },
    { uniform: "uDecay", label: "Decay / Persistence", type: "range", min: 0, max: 1, step: 0.005, value: 0.95 },
    { uniform: "uMix", label: "Feedback Mix", type: "range", min: 0, max: 1, step: 0.01, value: 0.5 },
    { uniform: "uGain", label: "Diff Sensitivity", type: "range", min: 1, max: 10, step: 0.1, value: 2.0 },
    { uniform: "uThreshold", label: "Motion Threshold", type: "range", min: 0, max: 0.5, step: 0.005, value: 0.05 },
    { uniform: "uColorStyle", label: "Color Style", type: "select", value: 0,
      options: [
        { label: "RGB Color", value: 0 },
        { label: "Grayscale", value: 1 },
        { label: "Heatmap", value: 2 },
      ]
    },
    { uniform: "uInvert", label: "Invert Output", type: "bool", value: false },
  ],
};
