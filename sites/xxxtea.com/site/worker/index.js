// Static asset worker. All requests delegated to the ASSETS binding,
// which serves the Astro build output from ./dist.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
