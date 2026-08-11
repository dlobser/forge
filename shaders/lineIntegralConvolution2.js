// Line Integral Convolution 2 — smears an image along a flow field.
//
//   image → the picture that gets smeared (this is also the Signal by default)
//   field → an optional vector field; unconnected it reads flat, so the default
//           Field Source derives one from the image instead
//
// The original LIC node could only convolve its own white noise and sampled the
// point-filtered textures directly, which beat the step lattice against the
// pixel grid into heavy moiré. This one convolves whatever is on the image
// input, fetches bilinearly, integrates the streamline with RK2, and jitters
// each pixel's sampling phase — drop Jitter to 0 and the fringes come back.
//
// Starting points:
//   • any image, defaults as they are → smooths along the image's own contours
//     and leaves the edges alone, because a streamline that runs along a contour
//     never crosses one
//   • Signal "Image × Noise" → the same flow etched into the picture as
//     brushwork; this is the one worth trying first
//   • Field Source "Field RG → XY" with a Sine Wave / Gradient / Fluid node on
//     the field input, Signal "Image" → the image dragged along that field
//   • Signal "Noise", Contrast ~1.8 → the classic LIC vector-field plot
//
// Cost is dominated by the field: the gradient modes take a Sobel per hop
// (~14ms at 1024² with the default length), a texture field about 3ms.
export default {
  name: "Line Integral Convolution 2",
  category: "effect",
  animated: false,
  inputs: ["color", "field"],
  inputLabels: { color: "image", field: "field (RG → XY)" },
  inputDefaults: { field: "gray" },
  controls: [
    { uniform: "uFieldMode", label: "Field Source", type: "select", value: 0, options: [
      { value: 0, label: "Image contours (⟂ gradient)" },
      { value: 1, label: "Image gradient" },
      { value: 2, label: "Field RG → XY (0.5 = zero)" },
      { value: 3, label: "Field RG → XY (signed)" },
      { value: 4, label: "Field R → angle" },
    ] },
    // Gradient modes only: the radius the Sobel is taken over. At 1px it chases
    // grain and fine detail; wind it up and the flow follows the big shapes.
    { uniform: "uFieldBlur", label: "Field Scale (px)", type: "range", min: 0.5, max: 16, step: 0.1, value: 3 },
    // 0 follows the field, ±90° crosses it. Handy on the gradient modes, where
    // it sweeps between "along the contour" and "across the edge".
    { uniform: "uRotate",   label: "Field Rotate",  type: "range", min: -3.1416, max: 3.1416, step: 0.01, value: 0 },

    // Length × Step is the kernel in pixels. Keep Step under a pixel: it is the
    // spacing of the taps, not the size of the effect, and coarse steps are the
    // other half of where the fringing came from.
    { uniform: "uSteps",    label: "Length (steps)", type: "range", min: 2, max: 48, step: 1, value: 24 },
    { uniform: "uStepSize", label: "Step (px)",      type: "range", min: 0.2, max: 2, step: 0.05, value: 0.7 },
    { uniform: "uJitter",   label: "Jitter",         type: "range", min: 0, max: 1, step: 0.01, value: 1 },

    // 0 = every pixel smears the same distance; 1 = weak field means short
    // streaks, so still regions of the field stay sharp.
    { uniform: "uMagSpeed", label: "Speed ← Magnitude", type: "range", min: 0, max: 1, step: 0.01, value: 0 },
    // On for anything ± ambiguous (gradients, structure tensors): keeps each hop
    // on the same side as the last one instead of letting the line double back.
    { uniform: "uAlign",    label: "Line Field",     type: "bool", value: true },

    { uniform: "uSignal",   label: "Signal", type: "select", value: 0, options: [
      { value: 0, label: "Image" },
      { value: 1, label: "Noise" },
      { value: 2, label: "Image × Noise" },
    ] },
    { uniform: "uNoiseAmount", label: "Noise Amount", type: "range", min: 0, max: 1, step: 0.01, value: 0.6 },
    { uniform: "uNoiseScale",  label: "Noise Grain (px)", type: "range", min: 0.5, max: 16, step: 0.1, value: 1 },
    { uniform: "uSeed",        label: "Seed", type: "range", min: 0, max: 20, step: 0.01, value: 0 },

    // The convolution is a blur, so it eats contrast along the flow. Detail adds
    // back the difference against a narrower kernel — the streaks get their
    // relief without the effect spreading across the flow.
    { uniform: "uSharpen",  label: "Streak Detail", type: "range", min: 0, max: 2, step: 0.01, value: 0.35 },
    { uniform: "uContrast", label: "Contrast",      type: "range", min: 0.2, max: 4, step: 0.05, value: 1 },
    { uniform: "uMix",      label: "Blend",         type: "range", min: 0, max: 1, step: 0.01, value: 1 },
    { uniform: "uEdge",     label: "Edges", type: "select", value: 0, options: [
      { label: "Clamp",  value: 0 },
      { label: "Wrap",   value: 1 },
      { label: "Mirror", value: 2 },
    ] },
  ],
};
