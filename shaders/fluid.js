// Fluid — an incompressible Navier-Stokes solver that turns the incoming image
// into coloured smoke or liquid. The output has a real alpha channel (the dye's
// density), so it composites straight over whatever is downstream.
//
// Three inputs, all optional:
//   Image     the dye's colour. Every emitted particle takes the colour of the
//             pixel it was born on, so the picture literally dissolves into fluid.
//   Mask      where emission is allowed — white emits, black doesn't. Leave it
//             unconnected and the whole frame emits.
//   Obstacle  solid cells the fluid flows around. White = wall (flip with
//             "Obstacle · Invert" if your shape is dark on light).
//
// Where to start:
//   • Fountain (the default) — Emit Angle 90 with gravity pulling back down.
//   • Falling paint — Emit Speed 0, Gravity Y −6, Dissipation 0.
//   • Rising smoke — Gravity Y 0, Buoyancy 3, Dissipation 0.15, Detail 0.5.
//   • The image dissolves — Emit Mode "Seed only", then stir with Noise Force.
//
// Two knobs decide how it looks vs. how fast it runs: **Sim Grid** (the solver's
// resolution — 512 is four times the work of 256) and **Solver Quality** (pressure
// iterations; below ~10 the fluid gets visibly springy and compressible).
// **Detail** is vorticity confinement: it feeds the small eddies back in after
// advection smears them, and is the difference between "coloured fog" and "smoke".
export default {
  name: "Fluid (Navier-Stokes)",
  category: "cellular",
  animated: true,
  feedback: true,
  simSize: 256,
  simSizes: [128, 256, 512, 1024],
  simBuffers: 2,                 // 0: velocity/pressure/divergence · 1: premultiplied dye
  // one frame of the solver; stage 4 repeats as many times as the slider says
  simPasses: [1, 2, 3, { stage: 4, repeat: "uPressureIters" }, 5],
  inputs: ["color", "mask", "obstacle"],
  inputLabels: { color: "Image → dye colour", mask: "Mask → where it emits", obstacle: "Obstacle → walls" },
  inputDefaults: { mask: "white", obstacle: "black" },
  controls: [
    { uniform: "uEmitMode", label: "Emit Mode", type: "select", value: 0,
      options: [
        { label: "Continuous", value: 0 },
        { label: "Seed only (image becomes the fluid)", value: 1 },
        { label: "Pulse", value: 2 },
      ] },
    { uniform: "uEmitRate",      label: "Emit · Rate",        type: "range", min: 0,   max: 8,   step: 0.05, value: 2.0 },
    { uniform: "uEmitThreshold", label: "Emit · Mask Cutoff", type: "range", min: 0,   max: 1,   step: 0.01, value: 0.25 },
    { uniform: "uEmitSoft",      label: "Emit · Mask Softness", type: "range", min: 0.001, max: 1, step: 0.01, value: 0.15 },
    { uniform: "uImageGate",     label: "Emit · Image Gates", type: "range", min: 0,   max: 1,   step: 0.01, value: 0 },
    { uniform: "uEmitSpeed",     label: "Emit · Jet Speed",   type: "range", min: 0,   max: 60,  step: 0.5,  value: 22 },
    { uniform: "uEmitAngle",     label: "Emit · Jet Angle",   type: "range", min: 0,   max: 360, step: 1,    value: 90 },
    { uniform: "uEmitSpread",    label: "Emit · Jet Spread",  type: "range", min: 0,   max: 1,   step: 0.01, value: 0.15 },
    { uniform: "uPulseRate",     label: "Emit · Pulse Rate",  type: "range", min: 0.05, max: 6,  step: 0.05, value: 1 },

    { uniform: "uTint",     label: "Dye · Tint",       type: "color", value: [1, 1, 1] },
    { uniform: "uSaturate", label: "Dye · Saturation", type: "range", min: 0, max: 3, step: 0.01, value: 1.3 },
    { uniform: "uRainbow",  label: "Dye · Rainbow",    type: "range", min: 0, max: 1, step: 0.01, value: 0 },

    { uniform: "uGravityX",   label: "Gravity X",     type: "range", min: -12, max: 12, step: 0.1,  value: 0 },
    { uniform: "uGravityY",   label: "Gravity Y",     type: "range", min: -12, max: 12, step: 0.1,  value: -1 },
    { uniform: "uBuoyancy",   label: "Buoyancy",      type: "range", min: -8,  max: 8,  step: 0.1,  value: 0 },
    { uniform: "uVorticity",  label: "Detail (curl)", type: "range", min: 0,   max: 3,  step: 0.01, value: 0.35 },
    { uniform: "uNoiseForce", label: "Noise · Force", type: "range", min: 0,   max: 20, step: 0.1,  value: 0 },
    { uniform: "uNoiseScale", label: "Noise · Scale", type: "range", min: 0.5, max: 16, step: 0.1,  value: 3 },
    { uniform: "uSwirlSpeed", label: "Noise · Speed", type: "range", min: 0,   max: 3,  step: 0.01, value: 0.3 },

    { uniform: "uDt",           label: "Time Step",      type: "range", min: 0.02, max: 0.5, step: 0.005, value: 0.15 },
    { uniform: "uVelDamp",      label: "Viscosity",      type: "range", min: 0,    max: 2,   step: 0.005, value: 0.05 },
    { uniform: "uDissipation",  label: "Dye Fade",       type: "range", min: 0,    max: 2,   step: 0.005, value: 0.02 },
    { uniform: "uPressureIters", label: "Solver Quality", type: "range", min: 1,   max: 60,  step: 1,     value: 20 },
    { uniform: "uEdgeMode", label: "Edges", type: "select", value: 0,
      options: [
        { label: "Walls (fluid bounces)", value: 0 },
        { label: "Open (flows off frame)", value: 1 },
        { label: "Wrap (torus)", value: 2 },
      ] },
    { uniform: "uObstacleThresh", label: "Obstacle · Cutoff", type: "range", min: 0, max: 1, step: 0.01, value: 0.5 },
    { uniform: "uObstacleInvert", label: "Obstacle · Invert", type: "bool", value: false },

    { uniform: "uDisplayMode", label: "Display", type: "select", value: 0,
      options: [
        { label: "Dye + alpha", value: 0 },
        { label: "Dye over image", value: 1 },
        { label: "Dye on black", value: 2 },
        { label: "Velocity field", value: 3 },
        { label: "Pressure", value: 4 },
        { label: "Curl", value: 5 },
      ] },
    { uniform: "uGain",       label: "Display · Gain",        type: "range", min: 0,   max: 4, step: 0.01, value: 1 },
    { uniform: "uAlphaGain",  label: "Display · Alpha Gain",  type: "range", min: 0,   max: 6, step: 0.01, value: 1 },
    { uniform: "uAlphaGamma", label: "Display · Alpha Gamma", type: "range", min: 0.1, max: 4, step: 0.01, value: 1 },
  ],
};
