// sdf — a signed-distance gradient from a movable centre. Pick a shape and a
// dropoff (how fast the brightness fades from the edge). A generator (no input).
// Feed it into the Distort node (or noise's distort) to push UVs along the field.
export default {
  name: "SDF",
  inputs: ["distort"],
  inputLabels: { distort: "distort" },
  controls: [
    { uniform: "uShape", label: "Shape", type: "select", value: 0,
      options: [{ label: "Circle", value: 0 }, { label: "Square", value: 1 }, { label: "Triangle", value: 2 }, { label: "Torus", value: 3 }] },
    { uniform: "uDistortAmt", label: "Distort In", type: "range", min: -20, max: 20, step: 0.005, value: 0 },
    { uniform: "uCenterX", label: "Center X",    type: "range", min: 0, max: 1, step: 0.005, value: 0.5 },
    { uniform: "uCenterY", label: "Center Y",    type: "range", min: 0, max: 1, step: 0.005, value: 0.5 },
    { uniform: "uScale",   label: "Scale",       type: "range", min: 0.05, max: 2, step: 0.005, value: 0.4 },
    { uniform: "uDropoff", label: "Dropoff",     type: "range", min: 0.1, max: 16, step: 0.05, value: 4 },
    { uniform: "uRing",    label: "Ring Radius", type: "range", min: 0, max: 1.5, step: 0.005, value: 0.5 },
    { uniform: "uInvert",  label: "Invert",      type: "bool", value: false },
  ],
};
