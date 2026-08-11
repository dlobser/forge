export default {
    name: "Line Integral Convolution",
    category: "effect",
    inputs: ["color"],
    inputLabels: {
        color: "Field (RG → XY)"
    },
    controls: [
        {
            uniform: "uSteps",
            label: "Steps",
            type: "range",
            min: 4,
            max: 32,
            step: 1,
            value: 16
        },
        {
            uniform: "uStepSize",
            label: "Step Size",
            type: "range",
            min: 0.5,
            max: 3.0,
            step: 0.1,
            value: 1.0
        },
        {
            uniform: "uContrast",
            label: "Contrast",
            type: "range",
            min: 0.5,
            max: 4.0,
            step: 0.1,
            value: 1.8
        },
    ]
};