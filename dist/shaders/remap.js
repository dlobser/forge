// remap — sample a texture with UVs derived from a black & white "image":
//   U = the image's brightness, V = the direction (tangent) of its luminance gradient.
// Tile the sampled texture in X/Y (numbers, set them large), and mirror per axis to
// force seamless wrapping. Wire the same image into both inputs for a self-remap.
export default {
  name: "Remap",
  inputs: ["image", "texture"],
  inputLabels: { image: "image", texture: "texture" },
  controls: [
    { uniform: "uTileX",   label: "Tile X",   type: "number", step: 0.1, value: 1 },
    { uniform: "uTileY",   label: "Tile Y",   type: "number", step: 0.1, value: 1 },
    { uniform: "uMirrorX", label: "Mirror X", type: "bool", value: false },
    { uniform: "uMirrorY", label: "Mirror Y", type: "bool", value: false },
    { uniform: "uVAmt",    label: "V Amount", type: "range", min: 0, max: 1, step: 0.01, value: 1 },
  ],
};
