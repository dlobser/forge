// smoothstep — remap each channel through smoothstep(edge0, edge1, x). Good for
// thresholding, contrast, or turning a gradient/SDF into a soft mask.
export default {
  name: "Smoothstep",
  inputs: ["color"],
  controls: [
    { uniform: "uEdge0", label: "Edge 0", type: "range", min: 0, max: 1, step: 0.005, value: 0.25 },
    { uniform: "uEdge1", label: "Edge 1", type: "range", min: 0, max: 1, step: 0.005, value: 0.75 },
  ],
};
