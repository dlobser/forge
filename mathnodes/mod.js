// positive modulo (wraps negatives), handy with Time for sawtooth/looping
export default {
  name: "Mod",
  inputs: [{ name: "a", value: 0 }, { name: "b", value: 1 }],
  outputs: ["out"],
  compute: (i) => ({ out: i.b !== 0 ? ((i.a % i.b) + i.b) % i.b : 0 }),
};
