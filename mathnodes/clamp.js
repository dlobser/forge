export default {
  name: "Clamp",
  inputs: [{ name: "x", value: 0 }, { name: "min", value: 0 }, { name: "max", value: 1 }],
  outputs: ["out"],
  compute: (i) => ({ out: Math.max(i.min, Math.min(i.max, i.x)) }),
};
