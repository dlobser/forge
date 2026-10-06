// raymarch — ray-marches a heightfield terrain built from the input image.
// Image brightness becomes elevation. Connect a height map plus an optional
// color image to render it as a 3D heightfield with an orbiting camera.
export default {
    name: "Raymarch",
    category: "generate",
    inputs: ["color", "heightMap"],
    inputLabels: { color: "surface color", heightMap: "height map" },
    controls: [
        { uniform: "uHeightScale", label: "Height Scale", type: "range", min: 0, max: 3, step: 0.01, value: 0.8 },
        { uniform: "uTerrainSize", label: "Terrain Size",  type: "range", min: 0.5, max: 6, step: 0.05, value: 2 },

        { uniform: "uCamYaw",   label: "Camera Yaw",   type: "range", min: -3.1416, max: 3.1416, step: 0.01, value: 0.6 },
        { uniform: "uCamPitch", label: "Camera Pitch", type: "range", min: -1.4, max: 1.4, step: 0.01, value: 0.55 },
        { uniform: "uCamDist",  label: "Camera Dist",  type: "range", min: 1.5, max: 10, step: 0.05, value: 3.5 },
        { uniform: "uFov",      label: "Field of View", type: "range", min: 0.3, max: 1.8, step: 0.01, value: 0.9 },

        { uniform: "uLightYaw",   label: "Light Yaw",   type: "range", min: -3.1416, max: 3.1416, step: 0.01, value: -0.8 },
        { uniform: "uLightPitch", label: "Light Pitch", type: "range", min: -1.4, max: 1.4, step: 0.01, value: 0.9 },
    ],
};