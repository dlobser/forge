// key — Chroma and Luma keying with sample picking, threshold/softness, expand/choke, and despill.
export default {
  name: "Key",
  category: "image",
  inputs: ["color", "bg"],
  inputLabels: { color: "image", bg: "background" },
  controls: [
    { uniform: "uMode",        label: "Mode",          type: "select", value: 0, options: [
      { label: "Chroma (RGB)",     value: 0 },
      { label: "Chroma (Screen)",  value: 1 },
      { label: "Luma Key",         value: 2 },
    ] },
    { uniform: "uOutput",      label: "Output",        type: "select", value: 0, options: [
      { label: "Keyed RGBA",       value: 0 },
      { label: "Alpha Mask",       value: 1 },
      { label: "Composite",        value: 2 },
    ] },
    { uniform: "uUsePickPos",  label: "Use Pick Pos",  type: "bool",   value: true },
    { uniform: "uPickX",       label: "Pick X",        type: "range",  min: 0, max: 1, step: 0.001, value: 0.5 },
    { uniform: "uPickY",       label: "Pick Y",        type: "range",  min: 0, max: 1, step: 0.001, value: 0.5 },
    { uniform: "uKeyColor",    label: "Key Color",     type: "color",  value: [0, 1, 0] },
    { uniform: "uThreshold",   label: "Threshold",     type: "range",  min: 0, max: 1, step: 0.001, value: 0.15 },
    { uniform: "uSoftness",    label: "Softness",      type: "range",  min: 0, max: 1, step: 0.001, value: 0.1 },
    { uniform: "uExpand",      label: "Expand/Choke",  type: "range",  min: -10, max: 10, step: 0.1, value: 0 },
    { uniform: "uDespill",     label: "Despill",       type: "range",  min: 0, max: 1, step: 0.01,  value: 0.5 },
    { uniform: "uInvert",      label: "Invert Mask",   type: "bool",   value: false },
    { uniform: "uBgColor",     label: "BG Solid",      type: "color",  value: [0, 0, 0] },
  ],
};
