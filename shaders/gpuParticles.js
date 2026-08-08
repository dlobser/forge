export default {
    name: "GPU Particles",
    category: "generate",
    inputs: ["image", "properties", "direction", "force"],
    inputLabels: {
        image: "Image → spawn + colour",
        properties: "Properties RGB → size / speed / emission",
        direction: "Direction → initial direction",
        force: "Force → vector field",
    },
    inputDefaults: {
        image: "white",
        properties: "white",
        direction: "gray",
        force: "gray",
    },

    particleSystem: true,

    simSize: 64,
    simSizes: [32, 64, 128, 256],
    stateBuffers: 3,

    sizeLabel: "particle grid",
    resetLabel: "↺ reset particles",

    updateVert: "gpuParticlesUpdate.vert",
    updateFrag: "gpuParticlesUpdate.frag",
    renderVert: "gpuParticlesRender.vert",
    renderFrag: "gpuParticlesRender.frag",

    primitive: "points",
    blend: "additive",
    blendControl: "uAdditive",

    controls: [
        { uniform: "uSpeed", label: "Speed", type: "range", min: 0, max: 2, step: 0.01, value: 0.18 },
        { uniform: "uAngle", label: "Direction · Angle", type: "range", min: 0, max: 360, step: 1, value: 90 },
        { uniform: "uSpread", label: "Direction · Spread", type: "range", min: 0, max: 1, step: 0.01, value: 0.15 },
        { uniform: "uEmission", label: "Emission", type: "range", min: 0, max: 1, step: 0.01, value: 1 },
        { uniform: "uLifetime", label: "Lifetime", type: "range", min: 0.1, max: 20, step: 0.1, value: 4 },
        { uniform: "uLifetimeVariation", label: "Lifetime · Variation", type: "range", min: 0, max: 1, step: 0.01, value: 0.25 },
        { uniform: "uDrag", label: "Drag", type: "range", min: 0, max: 5, step: 0.01, value: 0.15 },
        { uniform: "uForceStrength", label: "Force · Strength", type: "range", min: 0, max: 10, step: 0.05, value: 1 },

        { uniform: "uPointSize", label: "Size", type: "range", min: 1, max: 20, step: 0.25, value: 6 },
        { uniform: "uSizeStart", label: "Size · Start", type: "range", min: 0, max: 2, step: 0.01, value: 1 },
        { uniform: "uSizeEnd", label: "Size · End", type: "range", min: 0, max: 2, step: 0.01, value: 0.25 },

        { uniform: "uTint", label: "Colour · Tint", type: "color", value: [1, 1, 1] },
        { uniform: "uColorStart", label: "Colour · Start", type: "color", value: [1, 1, 1] },
        { uniform: "uColorEnd", label: "Colour · End", type: "color", value: [1, 1, 1] },
        { uniform: "uAlphaStart", label: "Alpha · Start", type: "range", min: 0, max: 1, step: 0.01, value: 1 },
        { uniform: "uAlphaEnd", label: "Alpha · End", type: "range", min: 0, max: 1, step: 0.01, value: 0 },

        { uniform: "uAdditive", label: "Additive", type: "bool", value: true },
    ],
};
