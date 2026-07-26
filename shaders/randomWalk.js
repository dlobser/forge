// Random Walk — every pixel takes a random step each frame; the mask decides how
// far each one is allowed to wander (black = still, white = full step).
//
//   image → the picture that dissolves
//   mask  → per-pixel randomness amount
//
// Animate ON accumulates the walk in the history buffer (a true random walk that
// keeps going while the transport plays). Animate OFF does the whole walk in one
// pass with `Static Steps` hops — the same look, frozen, and cheap to step out to a
// frame sequence. An unconnected mask reads white, so the whole frame walks.
export default {
  name: "Random Walk",
  category: "feedback",
  animated: true,
  history: true,
  inputs: ["color", "mask"],
  inputLabels: { color: "image", mask: "mask (amount)" },
  inputDefaults: { mask: "white" },
  controls: [
    { uniform: "uAnimate",  label: "Animate",       type: "bool",  value: true },
    // Step and bleed pull against each other: the walk carries pixels away, the
    // bleed keeps pulling the original back. A little bleed means the picture stays
    // recognisable while its surface crawls; zero bleed lets it dissolve completely.
    { uniform: "uStep",     label: "Step Size",     type: "range", min: 0, max: 0.05, step: 0.0002, value: 0.01 },
    { uniform: "uReinject", label: "Source Bleed",  type: "range", min: 0, max: 1,    step: 0.005,  value: 0.02 },
    { uniform: "uSteps",    label: "Static Steps",  type: "range", min: 1, max: 64,   step: 1,      value: 16 },
    { uniform: "uBias",     label: "Follow Mask",   type: "range", min: 0, max: 1,    step: 0.01,   value: 0 },
    { uniform: "uSeed",     label: "Seed",          type: "range", min: 0, max: 20,   step: 0.01,   value: 0 },
    { uniform: "uMaskGain", label: "Mask Gain",     type: "range", min: 0, max: 4,    step: 0.01,   value: 1 },
    { uniform: "uEdge",     label: "Edges",         type: "select", value: 0,
      options: [
        { label: "Clamp",  value: 0 },
        { label: "Wrap",   value: 1 },
        { label: "Mirror", value: 2 },
      ] },
  ],
};
