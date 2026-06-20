// depthParallax — animated depth wobble. `animated: true` makes Forge run a
// render loop, show transport controls, and offer "save sequence" → ffmpeg.
export default {
  name: "Depth Parallax",
  animated: true,
  inputs: ["color", "depth"],
  controls: [
    { uniform: "uAmplitude", label: "Amplitude", type: "range", min: 0, max: 0.1,  step: 0.001, value: 0.02 },
    { uniform: "uSpeed",     label: "Speed",     type: "range", min: 0, max: 6,    step: 0.05,  value: 1.5 },
  ],
};
