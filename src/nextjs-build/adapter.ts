/* eslint-disable import/no-extraneous-dependencies */
import { NextAdapter } from "next";

const adapter: NextAdapter = {
  name: "cdk-nextjs-adapter",
  async modifyConfig(config, { phase }) {
    if (phase === "phase-production-build") {
      return {
        ...config,
        output: "standalone",
        cacheHandler: "./cdk-nextjs-cache-handler.mjs",
      };
    }
    return config;
  },
};

export default adapter;
