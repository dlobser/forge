// kaleidoscope — realtime mirrored rotational pattern.
//
// Color slot → source image.
// Segments controls how many repeated slices.
// Zoom controls sampling scale.
// Rotation rotates the kaleidoscope sampling.
// Center X / Y move the symmetry center.

export default {
  name: "Kaleidoscope",
  category: "effect",
  animated: false,
  inputs: ["color"],
  inputLabels: { color: "image" },
  controls: [
    { uniform: "uSegments", label: "Segments", type: "range", min: 2, max: 32, step: 1, value: 8 },
    { uniform: "uZoom",     label: "Zoom",     type: "range", min: 0.2, max: 5.0, step: 0.05, value: 1.2 },
    { uniform: "uRotation", label: "Rotation", type: "range", min: -3.1416, max: 3.1416, step: 0.01, value: 0.0 },
    { uniform: "uCenterX",  label: "Center X", type: "range", min: 0.0, max: 1.0, step: 0.01, value: 0.5 },
    { uniform: "uCenterY",  label: "Center Y", type: "range", min: 0.0, max: 1.0, step: 0.01, value: 0.5 },
    { uniform: "uMirror",   label: "Mirror",   type: "bool", value: true },
  ],
};