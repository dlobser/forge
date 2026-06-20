export default {
  name: "Delta Time",
  inputs: [],
  outputs: ["dt"],
  compute: (i, ctx) => ({ dt: ctx.dt }),
};
