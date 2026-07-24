// oscillator — oscillates between low and high over time at a given speed/frequency
export default {
  name: "Oscillator",
  inputs: [
    { name: "speed", value: 1.0 },
    { name: "low", value: 0.0 },
    { name: "high", value: 1.0 },
  ],
  outputs: ["out"],
  compute: (i, ctx) => {
    const t = ctx.time * i.speed;
    const s = Math.sin(t * Math.PI * 2.0);
    const out = i.low + (s + 1.0) * 0.5 * (i.high - i.low);
    return { out };
  },
};
