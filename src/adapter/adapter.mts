/* eslint-disable import/no-extraneous-dependencies */
import { NextAdapter } from "next";
import { fileURLToPath } from "node:url";

const adapter: NextAdapter = {
  name: "cdk-nextjs-adapter",
  async modifyConfig(config, { phase }) {
    if (phase === "phase-production-build") {
      return {
        ...config,
        output: "standalone",
        cacheHandler: config.cacheHandler
          ? config.cacheHandler
          : fileURLToPath(import.meta.resolve("cdk-nextjs/cache-handler")),
        images: {
          ...config.images,
          customCacheHandler: config.images.customCacheHandler
            ? config.images.customCacheHandler
            : true, // TODO: remove in Next.js 17
        },
      };
    }
    return config;
  },
  onBuildComplete(ctx) {
    ctx;
    // TODO: copy .rsc, .body, .html into the cdk-nextjs-init-cache folder for init cache deployment
  },
};

export default adapter;
