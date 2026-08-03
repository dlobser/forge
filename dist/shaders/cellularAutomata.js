// Cellular Automata — four self-organising pattern engines on one ping-pong grid.
// `feedback: true` runs it as a GPU simulation (seed / step / display passes) on a
// square `simSize` grid that the display pass upscales smoothly.
//
// Image A steers the *rules*, not just the speed — brightness and edge energy
// shift each cell's thresholds, so different regions of the picture settle into
// different regimes and the image emerges as structure rather than as a tint.
// Image B (optional) is a freeze mask: where it is dark the sim stops.
//
// Modes, and what each is good for:
//   SmoothLife   — gliders and dividing blobs. Raise Radius for bigger creatures,
//                  Sharpness for crisper edges. Seed with "Blobs".
//   Multi-Scale Turing — the richest one. Spots nested in mazes nested in
//                  continents. Radius sets the finest scale; give it a few
//                  hundred frames to settle, the coarse scales converge slowly.
//   Gray-Scott   — coral, mitosis, worms. Feed/Kill pick the regime; Image Drive
//                  spreads a whole map of regimes across the picture.
//   Contour Flow — filaments streaming along the image's contour lines.
//
// Changing mode does not reseed (only Reset / a sim-size change does), so hit the
// node's reset after switching if the field looks like leftovers from the last one.
export default {
  name: "Cellular Automata",
  category: "cellular",
  animated: true,
  feedback: true,
  simSize: 256,
  inputs: ["color", "depth"],
  inputLabels: { color: "Image A → rules", depth: "Image B → freeze mask" },
  controls: [
    { uniform: "uMode", label: "Automata Mode", type: "select", value: 1,
      options: [
        { label: "SmoothLife", value: 0 },
        { label: "Multi-Scale Turing", value: 1 },
        { label: "Gray-Scott Reaction-Diffusion", value: 2 },
        { label: "Contour Flow", value: 3 },
      ]
    },
    { uniform: "uRadius",        label: "Radius / Scale",     type: "range", min: 3,    max: 12,  step: 0.5,   value: 6 },
    { uniform: "uDt",            label: "Time Step",          type: "range", min: 0.01, max: 0.5, step: 0.005, value: 0.15 },
    { uniform: "uSharp",         label: "Rule Sharpness",     type: "range", min: 0,    max: 1,   step: 0.01,  value: 0.7 },
    { uniform: "uImageDrive",    label: "Image A → Rules",    type: "range", min: 0,    max: 1,   step: 0.01,  value: 0.35 },
    { uniform: "uContrastDrive", label: "Edges → Activity",   type: "range", min: 0,    max: 3,   step: 0.05,  value: 0.8 },
    { uniform: "uMaskB",         label: "Image B → Freeze",   type: "range", min: 0,    max: 1,   step: 0.01,  value: 0 },
    { uniform: "uSpark",         label: "Agitation",          type: "range", min: 0,    max: 1,   step: 0.01,  value: 0.05 },
    { uniform: "uDecay",         label: "Decay",              type: "range", min: 0,    max: 0.2, step: 0.005, value: 0 },

    { uniform: "uBirthMin",      label: "Life · Birth Min",   type: "range", min: 0.05, max: 0.6, step: 0.001, value: 0.278 },
    { uniform: "uBirthMax",      label: "Life · Birth Max",   type: "range", min: 0.1,  max: 0.8, step: 0.001, value: 0.365 },
    { uniform: "uSurvMin",       label: "Life · Surv Min",    type: "range", min: 0.05, max: 0.6, step: 0.001, value: 0.267 },
    { uniform: "uSurvMax",       label: "Life · Surv Max",    type: "range", min: 0.1,  max: 0.9, step: 0.001, value: 0.445 },

    { uniform: "uFeedRate",      label: "Gray-Scott · Feed",  type: "range", min: 0.005, max: 0.09,  step: 0.001, value: 0.037 },
    { uniform: "uKillRate",      label: "Gray-Scott · Kill",  type: "range", min: 0.03,  max: 0.075, step: 0.001, value: 0.06 },

    { uniform: "uFlow",          label: "Flow · Advection",   type: "range", min: 0, max: 3, step: 0.01, value: 1.0 },
    { uniform: "uCurl",          label: "Flow · Self Curl",   type: "range", min: 0, max: 2, step: 0.01, value: 0.6 },
    { uniform: "uAntiDiff",      label: "Flow · Filaments",   type: "range", min: 0, max: 1, step: 0.01, value: 0.4 },

    { uniform: "uSeedMode", label: "Seed Source", type: "select", value: 3,
      options: [
        { label: "Image Luminance", value: 0 },
        { label: "Image Edges + Noise", value: 1 },
        { label: "Random Noise", value: 2 },
        { label: "Blobs", value: 3 },
      ]
    },
    { uniform: "uDisplayMode", label: "Display Style", type: "select", value: 2,
      options: [
        { label: "Image Tint", value: 0 },
        { label: "Monochrome", value: 1 },
        { label: "Relief (shaded)", value: 2 },
        { label: "Neon", value: 3 },
        { label: "Composite Overlay", value: 4 },
        { label: "Contour Lines", value: 5 },
      ]
    },
    { uniform: "uSharpness", label: "Display Contrast", type: "range", min: 0, max: 1, step: 0.01, value: 0.3 },
    { uniform: "uMix",       label: "Mix Result",       type: "range", min: 0, max: 1, step: 0.01, value: 1.0 },
  ],
};
