/* eslint-disable import/no-extraneous-dependencies */
import { NextAdapter } from "next";

const adapter: NextAdapter = {
  name: "cdk-nextjs-cache-handler",
  async modifyConfig(config, { phase }) {
    if (phase === "phase-production-build") {
      return {
        ...config,
        output: "standalone",
        cacheHandler: require.resolve("./cdk-nextjs-cache-handler.js"),
      };
    }
    return config;
  },
};

export default adapter;
