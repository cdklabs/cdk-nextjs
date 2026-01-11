// src/nextjs-build/adapter.ts
var adapter = {
  name: "cdk-nextjs-adapter",
  async modifyConfig(config, { phase }) {
    if (phase === "phase-production-build") {
      return {
        ...config,
        output: "standalone",
        // The cache handler will be available in the same directory as server.js after build
        cacheHandler: "./cdk-nextjs-cache-handler.mjs"
      };
    }
    return config;
  }
};
var adapter_default = adapter;
export {
  adapter_default as default
};
