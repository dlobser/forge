export default {
  name: "Int",
  inputs: [{ name: "value", value: 0, step: 1 }],
  outputs: ["out"],
  compute: (i) => ({ out: Math.round(i.value) }),
};
