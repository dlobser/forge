export default {
  name: "Divide",
  inputs: [{ name: "a", value: 1 }, { name: "b", value: 1 }],
  outputs: ["out"],
  compute: (i) => ({ out: i.b !== 0 ? i.a / i.b : 0 }),
};
