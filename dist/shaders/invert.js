// invert — color, luminance, and HSV inversion effect node for Forge.
export default {
  name: "Invert",
  category: "image",
  animated: false,
  inputs: ["color"],
  controls: [
    { uniform: "uMix", label: "Mix", type: "range", min: 0, max: 1, step: 0.01, value: 1 },
    { uniform: "uMode", label: "Mode", type: "select", value: 0, options: [
      { value: 0, label: "RGB Channels" },
      { value: 1, label: "Luminance" },
      { value: 2, label: "HSV Value" },
    ] },
    { uniform: "uInvertR", label: "Invert R", type: "bool", value: true },
    { uniform: "uInvertG", label: "Invert G", type: "bool", value: true },
    { uniform: "uInvertB", label: "Invert B", type: "bool", value: true },
    { uniform: "uInvertAlpha", label: "Invert Alpha", type: "bool", value: false },
  ],
};
