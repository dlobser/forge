export default {
  name: "Subtract",
  inputs: [{ name: "a", value: 0 }, { name: "b", value: 0 }],
  outputs: ["out"],
  compute: (i) => ({ out: i.a - i.b }),
};
