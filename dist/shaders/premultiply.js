// premultiply — multiply colour by alpha (rgb × a), the form compositing and
// additive blending expect: transparent areas go to black instead of carrying
// whatever colour sat behind the alpha. Unpremultiply undoes it (rgb ÷ a).
export default {
  name: "Premultiply",
  category: "image",
  animated: false,
  inputs: ["color"],
  inputLabels: { color: "image" },
  controls: [
    { uniform: "uMode", label: "Mode", type: "select", value: 0, options: [
      { value: 0, label: "Premultiply (rgb × alpha)" },
      { value: 1, label: "Unpremultiply (rgb ÷ alpha)" },
    ] },
    { uniform: "uAlphaOut", label: "Alpha out", type: "select", value: 0, options: [
      { value: 0, label: "Keep" },
      { value: 1, label: "Opaque (flatten onto black)" },
    ] },
  ],
};
