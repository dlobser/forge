// cos(x * freq * 2pi + phase) * amp.
export default {
  name: "Cosine",
  inputs: [{ name: "x", value: 0 }, { name: "freq", value: 1 }, { name: "phase", value: 0 }, { name: "amp", value: 1 }],
  outputs: ["out"],
  compute: (i) => ({ out: Math.cos(i.x * i.freq * Math.PI * 2 + i.phase) * i.amp }),
};
