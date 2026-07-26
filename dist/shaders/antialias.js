// Anti-alias — put this last in a chain. Forge point-samples every texture so a
// long chain stays crisp, which leaves hard stair-stepped edges on anything a
// shader generated (SDFs, raymarch, kaleidoscope seams, keys). FXAA finds those
// edges and blurs only along them, so detail elsewhere is untouched.
export default {
  name: "Anti-alias",
  category: "image",
  animated: false,
  inputs: ["color"],
  controls: [
    { uniform: "uMode",      label: "Mode", type: "select", value: 0,
      options: [
        { label: "FXAA",    value: 0 },
        { label: "Box 3×3", value: 1 },
        { label: "Sharpen", value: 2 },
      ] },
    { uniform: "uAmount",    label: "Amount",    type: "range", min: 0, max: 1, step: 0.01, value: 1 },
    { uniform: "uThreshold", label: "Edge Threshold", type: "range", min: 0.01, max: 0.5, step: 0.005, value: 0.06 },
    { uniform: "uSharpen",   label: "Sharpen Strength", type: "range", min: 0, max: 3, step: 0.01, value: 1 },
  ],
};
