// depthParallax — depth parallax controlled by separate x and y offsets.
// X/Y offsets default to pins so they can be driven by oscillators.
export default {
  name: "Depth Parallax",
  animated: true,
  inputs: ["color", "depth"],
  controls: [
    { uniform: "uAmplitude", label: "Amplitude", type: "range", min: 0, max: 0.1, step: 0.001, value: 0.02 },
    { uniform: "uOffsetX",   label: "X Offset",  type: "range", min: -1, max: 1,   step: 0.01,  value: 0, defaultPin: true },
    { uniform: "uOffsetY",   label: "Y Offset",  type: "range", min: -1, max: 1,   step: 0.01,  value: 0, defaultPin: true },
  ],
};
