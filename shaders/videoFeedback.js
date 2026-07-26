// Video Feedback — a real frame-to-frame feedback loop (trails / echo / infinite
// zoom), as opposed to Feedback Deform, which fakes it inside a single frame.
//
//   image → the live picture coming in
//   mask  → white where the incoming image replaces the feedback outright
//   warp  → r/g displacement field for the feedback; 0.5,0.5 is neutral,
//           0 pushes negative, 1 pushes positive
//
// `history: true` asks the engine for this node's own previous output as `uPrev`,
// kept at the node's full render resolution (unlike `feedback: true`, which runs a
// small square simulation grid). Trails only advance while the transport is
// playing; pausing freezes the loop where it is.
//
// Starting points:
//   • Trails         decay 0.9, gain 1, blend Add, transform all zero
//   • Infinite zoom  decay 0.97, scale 1.01, rotate 0.3
//   • Flow           feed a Noise or Gradient node into `warp`, warp amount 0.01
export default {
  name: "Video Feedback",
  category: "feedback",
  animated: true,
  history: true,
  inputs: ["color", "mask", "warp"],
  inputLabels: { color: "image", mask: "mask (replace)", warp: "warp (r/g)" },
  inputDefaults: { mask: "black", warp: "gray" },
  controls: [
    { uniform: "uDecay",      label: "Feedback Decay",  type: "range", min: 0,    max: 1.02, step: 0.005, value: 0.92 },
    { uniform: "uGain",       label: "Image Amount",    type: "range", min: 0,    max: 2,    step: 0.01,  value: 1 },
    // Max by default, not Add. Additive feedback converges on image/(1-decay) —
    // at decay 0.92 that is 12× the input, so Add blows the frame out to white
    // within a second unless you also pull the gain right down. Max leaves trails
    // that fade cleanly and can never saturate. Add is still there when you want
    // that runaway glow, and pairs with a low Image Amount.
    { uniform: "uBlendMode",  label: "Blend",           type: "select", value: 2,
      options: [
        { label: "Add",        value: 0 },
        { label: "Screen",     value: 1 },
        { label: "Max",        value: 2 },
        { label: "Over",       value: 3 },
        { label: "Difference", value: 4 },
      ] },
    { uniform: "uWarpAmount", label: "Warp Amount",     type: "range", min: 0,    max: 0.2,  step: 0.001, value: 0.01 },
    { uniform: "uTransX",     label: "Translate X",     type: "range", min: -0.1, max: 0.1,  step: 0.0005, value: 0 },
    { uniform: "uTransY",     label: "Translate Y",     type: "range", min: -0.1, max: 0.1,  step: 0.0005, value: 0 },
    { uniform: "uRotate",     label: "Rotate (°/frame)", type: "range", min: -10, max: 10,   step: 0.01,  value: 0 },
    { uniform: "uScale",      label: "Scale /frame",    type: "range", min: 0.9,  max: 1.1,  step: 0.0005, value: 1 },
    { uniform: "uHueShift",   label: "Hue Drift /frame", type: "range", min: -0.1, max: 0.1, step: 0.001, value: 0 },
    { uniform: "uMaskGain",   label: "Mask Gain",       type: "range", min: 0,    max: 4,    step: 0.01,  value: 1 },
    { uniform: "uMaskInvert", label: "Invert Mask",     type: "bool",  value: false },
    { uniform: "uEdge",       label: "Edges",           type: "select", value: 0,
      options: [
        { label: "Clamp",  value: 0 },
        { label: "Wrap",   value: 1 },
        { label: "Mirror", value: 2 },
        { label: "Black",  value: 3 },
      ] },
  ],
};
