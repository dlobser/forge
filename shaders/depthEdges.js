// depthEdges — manifest for the Laplacian depth-edge effect.
//
// A Forge shader effect is a triplet that shares a basename:
//   <name>.frag   required  — the fragment shader
//   <name>.vert   optional  — defaults to shaders/_fullscreen.vert
//   <name>.js     this file — display name, which textures it uses, and the
//                             controls that become uniforms + UI sliders.
//
// `controls[].uniform` is set on the program every frame. Types: range (float),
// color (vec3, value is [r,g,b] 0..1), bool (float 0/1), select (float).
export default {
  name: "Depth Edges",
  category: "depth",
  animated: false,
  inputs: ["color", "depth"],
  inputLabels: { color: "image", depth: "depth" },
  controls: [
    { uniform: "uEdgeMix",   label: "Edge / Color Mix", type: "range", min: 0, max: 1,  step: 0.01, value: 0.5 },
    { uniform: "uEdgeScale", label: "Edge Strength",    type: "range", min: 0, max: 25, step: 0.1,  value: 8 },
    { uniform: "uThreshold", label: "Threshold",        type: "range", min: 0, max: 1,  step: 0.01, value: 0.04 },
    { uniform: "uEdgeColor", label: "Edge Color",       type: "color", value: [1, 1, 1] },
  ],
};
