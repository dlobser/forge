// Split Channels — pull one channel out of an image as black-and-white.
//
// Five outputs. **Selected** follows the Channel control (and is what the node's
// thumbnail previews, so you can flick through R/G/B/A and watch); **R G B A** are
// always themselves, so a single node can drive four separate chains — e.g. feed a
// fluid's mask from A while a blur reads G.
//
// Gain/Offset are a levels pass on the way out, which is usually what you want when
// a channel is nearly flat (alpha especially). **To Alpha** copies the value into
// the alpha channel as well, turning the result into a mask rather than a picture.
export default {
  name: "Split Channels",
  category: "image",
  inputs: ["color"],
  inputLabels: { color: "image" },
  outputs: ["selected", "R", "G", "B", "A"],
  controls: [
    { uniform: "uChannel", label: "Channel (→ selected)", type: "select", value: 0,
      options: [
        { label: "Red", value: 0 },
        { label: "Green", value: 1 },
        { label: "Blue", value: 2 },
        { label: "Alpha", value: 3 },
        { label: "Luminance", value: 4 },
      ] },
    { uniform: "uGain",    label: "Gain",     type: "range", min: 0,  max: 8, step: 0.01, value: 1 },
    { uniform: "uOffset",  label: "Offset",   type: "range", min: -1, max: 1, step: 0.01, value: 0 },
    { uniform: "uInvert",  label: "Invert",   type: "bool", value: false },
    { uniform: "uToAlpha", label: "To Alpha", type: "bool", value: false },
  ],
};
