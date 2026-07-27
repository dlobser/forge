export default {
    name: "Vector Field Visualizer",
    category: "utility",
    inputs: ["color"],
    inputLabels: {
        color: "Field (RG → XY)"
    },
    controls: [
        {
            uniform: "uMagnitudeScale",
            label: "Magnitude Scale",
            type: "range",
            min: 0.1,
            max: 8.0,
            step: 0.1,
            value: 1.0
        },
        {
            uniform: "uGridDensity",
            label: "Grid Density",
            type: "range",
            min: 4,
            max: 32,
            step: 1,
            value: 12
        },
        {
            uniform: "uArrowSize",
            label: "Arrow Size",
            type: "range",
            min: 0.6,
            max: 2.0,
            step: 0.05,
            value: 1.35
        },
        {
            uniform: "uArrowThickness",
            label: "Arrow Thickness",
            type: "range",
            min: 0.01,
            max: 0.10,
            step: 0.005,
            value: 0.045
        },
    ]
};