/* eslint-disable import/no-extraneous-dependencies */
import { NextAdapter } from "next";

const adapter: NextAdapter = {
  name: "cdk-nextjs-adapter",
  async modifyConfig(config, { phase }) {
    if (phase === "phase-production-build") {
      return {
        ...config,
        output: "standalone",
        cacheHandler: import.meta.resolve("cdk-nextjs/cache-handler"),
        images: {
          ...config.images,
          customCacheHandler: true, // TODO: remove in Next.js 17
        },
      };
    }
    return config;
  },
};

export default adapter;
