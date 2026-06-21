export default {
  name: "Add",
  inputs: [{ name: "a", value: 0, defaultPin: true }, { name: "b", value: 0 }],
  outputs: ["out"],
  compute: (i) => ({ out: i.a + i.b }),
};
