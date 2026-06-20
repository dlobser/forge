// linear interpolate a -> b by t
export default {
  name: "Mix",
  inputs: [{ name: "a", value: 0 }, { name: "b", value: 1 }, { name: "t", value: 0.5 }],
  outputs: ["out"],
  compute: (i) => ({ out: i.a + (i.b - i.a) * i.t }),
};
