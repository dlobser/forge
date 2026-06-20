export default {
  name: "Abs",
  inputs: [{ name: "x", value: 0 }],
  outputs: ["out"],
  compute: (i) => ({ out: Math.abs(i.x) }),
};
