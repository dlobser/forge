// distortion — push the COLOR image along the gradient ("normals") of a
// black-and-white field supplied in the DEPTH slot.
//
//   Color slot → the image that gets deformed.
//   Depth slot → the B&W control field. Its luminance gradient is the push
//                direction. A radial field (white centre → black edge) points
//                inward, so pixels are shoved OUTWARD from the bright centre
//                (positive Strength). Negative Strength pulls them inward.
export default {
  name: "Distortion",
  animated: false,
  inputs: ["color", "depth"],
  controls: [
    { uniform: "uStrength",     label: "Strength",       type: "range", min: -0.3, max: 0.3, step: 0.001, value: 0.12 },
    { uniform: "uSampleRadius", label: "Field Smoothing", type: "range", min: 1, max: 8, step: 1, value: 2 },
    { uniform: "uMode",         label: "View",           type: "select", value: 0,
      options: [{ value: 0, label: "Deformed" }, { value: 1, label: "Gradient" }, { value: 2, label: "Field" }] },
  ],
};
