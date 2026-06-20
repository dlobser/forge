export default {
  name: "Multiply",
  inputs: [{ name: "a", value: 1 }, { name: "b", value: 1 }],
  outputs: ["out"],
  compute: (i) => ({ out: i.a * i.b }),
};
