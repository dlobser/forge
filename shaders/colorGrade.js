// colorGrade — hue/saturation/contrast/brightness with an optional depth mask.
export default {
  name: "Color Grade",
  animated: false,
  inputs: ["color", "depth"],
  // the 2nd input is a mask (smoothstep'd luma), not literally depth — label it so
  inputLabels: { color: "Color", depth: "Mask" },
  controls: [
    { uniform: "uHue",        label: "Hue Offset",  type: "range", min: -0.5, max: 0.5, step: 0.001, value: 0 },
    { uniform: "uSat",        label: "Saturation",  type: "range", min: 0, max: 2, step: 0.01, value: 1 },
    { uniform: "uContrast",   label: "Contrast",    type: "range", min: 0, max: 2, step: 0.01, value: 1 },
    { uniform: "uBright",     label: "Brightness",  type: "range", min: 0, max: 2, step: 0.01, value: 1 },
    { uniform: "uTint",       label: "Tint",        type: "color", value: [1, 1, 1] },
    { uniform: "uTintAmt",    label: "Tint Amt",    type: "range", min: 0, max: 1, step: 0.01, value: 0 },
    { uniform: "uUseDepthMask", label: "Use Mask", type: "bool", value: false },
    { uniform: "uMaskLo",     label: "Mask Low",    type: "range", min: 0, max: 1, step: 0.01, value: 0.2 },
    { uniform: "uMaskHi",     label: "Mask High",   type: "range", min: 0, max: 1, step: 0.01, value: 0.8 },
    { uniform: "uMaskInvert", label: "Invert Mask", type: "bool", value: false },
  ],
};
