// remap — lineally map a value from [inputLow, inputHigh] to [low, high]
export default {
  name: "Remap",
  inputs: [
    { name: "val", value: 0.5, defaultPin: true },
    { name: "inputLow", value: 0 },
    { name: "inputHigh", value: 1 },
    { name: "low", value: 0 },
    { name: "high", value: 1 },
  ],
  outputs: ["out"],
  compute: (i) => {
    const denom = i.inputHigh - i.inputLow;
    const out = Math.abs(denom) < 1e-6 
      ? i.low 
      : i.low + ((i.val - i.inputLow) * (i.high - i.low)) / denom;
    return { out };
  },
};
