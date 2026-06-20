export default {
  name: "Float",
  inputs: [{ name: "value", value: 0, step: 0.01 }],
  outputs: ["out"],
  compute: (i) => ({ out: i.value }),
};
