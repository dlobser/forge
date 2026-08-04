// GPU Particles — a texture-backed particle simulation. Each texel stores one
// particle as position.xy + velocity.xy. The update pass advances the state in an
// RGBA32F ping-pong buffer; the render pass draws one GL point per texel.
export default {
    name: "GPU Particles",
    category: "generate",
    animated: true,
    particleSystem: true,
    inputs: [],

    simSize: 64,
    simSizes: [32, 64, 128, 256],

    updateVert: "gpuParticlesUpdate.vert",
    updateFrag: "gpuParticlesUpdate.frag",
    renderVert: "gpuParticlesRender.vert",
    renderFrag: "gpuParticlesRender.frag",

    controls: [
        { uniform: "uSpeed", label: "Speed", type: "range", min: 0, max: 1, step: 0.01, value: 0.18 },
        { uniform: "uSpread", label: "Spread", type: "range", min: 0, max: 8, step: 0.05, value: 1 },
        { uniform: "uPointSize", label: "Size", type: "range", min: 1, max: 20, step: 0.25, value: 4 },
        { uniform: "uParticleColor", label: "Color", type: "color", value: [1, 1, 1] },
        { uniform: "uAdditive", label: "Additive", type: "bool", value: true },
    ],
};