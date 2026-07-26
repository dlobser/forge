// gradient — linear or radial gradient with position sliders, multi-color stops & alpha.
export default {
  name: "Gradient",
  category: "generate",
  inputs: ["distort"],
  inputLabels: { distort: "distort" },
  controls: [
    { uniform: "uType",       label: "Type",       type: "select", value: 0, options: [
      { label: "Linear", value: 0 },
      { label: "Radial", value: 1 },
    ] },
    { uniform: "uNumStops",   label: "Stops",      type: "select", value: 0, options: [
      { label: "2 Colors", value: 0 },
      { label: "3 Colors", value: 1 },
      { label: "4 Colors", value: 2 },
    ] },
    { uniform: "uPoint1X",   label: "Pos 1 X",    type: "range", min: 0, max: 1, step: 0.001, value: 0.0 },
    { uniform: "uPoint1Y",   label: "Pos 1 Y",    type: "range", min: 0, max: 1, step: 0.001, value: 0.0 },
    { uniform: "uPoint2X",   label: "Pos 2 X",    type: "range", min: 0, max: 1, step: 0.001, value: 1.0 },
    { uniform: "uPoint2Y",   label: "Pos 2 Y",    type: "range", min: 0, max: 1, step: 0.001, value: 1.0 },

    { uniform: "uColor1",    label: "Color 1",    type: "color", value: [0, 0, 0] },
    { uniform: "uAlpha1",    label: "Alpha 1",    type: "range", min: 0, max: 1, step: 0.01, value: 1.0 },
    { uniform: "uPos1",      label: "Stop 1",     type: "range", min: 0, max: 1, step: 0.01, value: 0.0 },

    { uniform: "uColor2",    label: "Color 2",    type: "color", value: [1, 1, 1] },
    { uniform: "uAlpha2",    label: "Alpha 2",    type: "range", min: 0, max: 1, step: 0.01, value: 1.0 },
    { uniform: "uPos2",      label: "Stop 2",     type: "range", min: 0, max: 1, step: 0.01, value: 1.0 },

    { uniform: "uColor3",    label: "Color 3",    type: "color", value: [0.2, 0.6, 1.0] },
    { uniform: "uAlpha3",    label: "Alpha 3",    type: "range", min: 0, max: 1, step: 0.01, value: 1.0 },
    { uniform: "uPos3",      label: "Stop 3",     type: "range", min: 0, max: 1, step: 0.01, value: 0.5 },

    { uniform: "uColor4",    label: "Color 4",    type: "color", value: [1.0, 0.3, 0.6] },
    { uniform: "uAlpha4",    label: "Alpha 4",    type: "range", min: 0, max: 1, step: 0.01, value: 1.0 },
    { uniform: "uPos4",      label: "Stop 4",     type: "range", min: 0, max: 1, step: 0.01, value: 0.75 },

    { uniform: "uExtend",    label: "Extend Mode", type: "select", value: 0, options: [
      { label: "Clamp",  value: 0 },
      { label: "Repeat", value: 1 },
      { label: "Mirror", value: 2 },
    ] },
    { uniform: "uAspect",    label: "Correct Aspect", type: "bool", value: true },
    { uniform: "uDistortAmt", label: "Distort In",  type: "range", min: -20, max: 20, step: 0.005, value: 0.0 },
  ],
};
