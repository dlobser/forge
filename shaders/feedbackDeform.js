// feedbackDeform — like Distortion, but the deformation is applied repeatedly so
// the image flows along the field instead of shifting once.
//
//   Color slot → the image being deformed.
//   Depth slot → the B&W distortion field driving the flow.
//
// True frame-to-frame feedback needs a ping-pong buffer the single-pass engine
// doesn't have, so each fragment instead marches through the field for several
// iterations, blending the original colour back in at every step (uFeedback) —
// the same "deform, mix, repeat" loop, resolved per pixel.
//
// The flow direction is rotated by "Flow Angle", which is a plain value in turns —
// pin an Oscillator, Sine or Slider node to it and THAT node owns the animation, so
// you can see it, re-time it, or share one phase across several effects. "Auto Spin"
// is the old built-in time-driven rotation, kept for existing graphs, and defaults
// to 0. For real frame-to-frame feedback (trails, echo, infinite zoom) use the
// Video Feedback node instead: this one resolves its whole loop inside one frame.
export default {
  name: "Feedback Deform",
  category: "feedback",
  animated: true,
  inputs: ["color", "depth"],
  controls: [
    { uniform: "uStrength",     label: "Step Strength",   type: "range", min: 0, max: 0.06, step: 0.001, value: 0.02 },
    { uniform: "uIterations",   label: "Iterations",      type: "range", min: 1, max: 48,   step: 1,     value: 16 },
    { uniform: "uFeedback",     label: "Feedback Mix",    type: "range", min: 0, max: 1,    step: 0.01,  value: 0.6 },
    { uniform: "uDecay",        label: "Step Decay",      type: "range", min: 0.8, max: 1,  step: 0.005, value: 0.97 },
    { uniform: "uAngle",        label: "Flow Angle",      type: "range", min: -1, max: 1,   step: 0.001, value: 0 },
    { uniform: "uSwirl",        label: "Auto Spin",       type: "range", min: -3, max: 3,   step: 0.01,  value: 0 },
    { uniform: "uSampleRadius", label: "Field Smoothing", type: "range", min: 1, max: 8,    step: 1,     value: 2 },
  ],
};
