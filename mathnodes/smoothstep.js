export default {
  name: "Smoothstep",
  inputs: [{ name: "edge0", value: 0 }, { name: "edge1", value: 1 }, { name: "x", value: 0 }],
  outputs: ["out"],
  compute: (i) => {
    const t = Math.max(0, Math.min(1, (i.x - i.edge0) / ((i.edge1 - i.edge0) || 1e-6)));
    return { out: t * t * (3 - 2 * t) };
  },
};
