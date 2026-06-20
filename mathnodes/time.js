// Math node format — drop a file like this in /mathnodes and reload:
//   export default {
//     name: "...",                         // node title
//     inputs: [{ name, value, step? }],    // each = a number input pin + a widget default
//     outputs: ["out", ...],               // number output pins
//     compute: (i, ctx) => ({ out: ... }), // i = resolved inputs (pin or widget),
//   };                                     //   ctx = { time, dt, frame }
export default {
  name: "Time",
  inputs: [],
  outputs: ["t"],
  compute: (i, ctx) => ({ t: ctx.time }),
};
