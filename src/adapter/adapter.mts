/* eslint-disable import/no-extraneous-dependencies */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import getDebug from "debug";
import type { NextAdapter } from "next";
import { writeBuildOutputs } from "./build-outputs.js";
import { writeInitCache } from "./init-cache.js";
import { LOG_PREFIX } from "../constants.js";

const debug = getDebug("cdk-nextjs:adapter");

const adapter: NextAdapter = {
  name: "cdk-nextjs-adapter",
  async modifyConfig(config, { phase, nextVersion }) {
    if (phase === "phase-production-build") {
      assertSupportedNextVersion(nextVersion);
      return {
        ...config,
        // No `output: "standalone"`. `onBuildComplete` stages the deployment
        // root from the same NFT traces `writeStandaloneDirectory` would have
        // used, so the two are alternatives rather than layers — `next build`
        // says as much itself, immediately above the `onBuildComplete` call:
        // "in the future `output: standalone` might not be allowed if an adapter
        // with `onBuildComplete` is configured."
        cacheHandler: config.cacheHandler
          ? config.cacheHandler
          : fileURLToPath(import.meta.resolve("cdk-nextjs/cache-handler")),
        cacheHandlers: useCacheHandlers(config.cacheHandlers),
        images: {
          ...config.images,
          customCacheHandler: config.images.customCacheHandler
            ? config.images.customCacheHandler
            : true, // TODO: remove in Next.js 17
        },
      };
    }
    if (phase === "phase-production-server") {
      // `next start`. The deployed runtime needs none of this: its route modules
      // read `cacheHandlers` from `required-server-files.json`, which the build
      // phase above wrote. But `next start` registers the handlers once, from
      // *this* config, before any route module gets the chance, and a registry
      // initialized without them stays that way (`initializeCacheHandlers` in
      // `next/dist/server/use-cache/handlers.js` only runs once). Same handlers
      // here, so `next start` caches the way a deployment does.
      return {
        ...config,
        cacheHandlers: useCacheHandlers(config.cacheHandlers),
      };
    }
    return config;
  },
  async onBuildComplete(ctx) {
    // Stage the deployment root and write the manifest the runtime dispatches
    // from. This is what replaces `output: "standalone"`.
    const { manifest, adapterDir, stagedGroups } = await writeBuildOutputs(ctx);
    const entrypointCount = Object.keys(manifest.entrypoints).length;
    for (const group of stagedGroups) {
      const routes = manifest.groups?.[group.name];
      console.log(
        `${LOG_PREFIX} Staged ${group.fileCount} files for ` +
          `${routes ? `${routes.length} of ${entrypointCount}` : entrypointCount} ` +
          `entrypoints in ${group.path}`,
      );
    }
    debug(`Adapter output directory: ${adapterDir}`);

    const cacheDir =
      process.env.CDK_NEXTJS_INIT_CACHE_DIR ||
      join(ctx.distDir, "cdk-nextjs-init-cache");

    await writeInitCache(ctx, cacheDir);
  },
};

export default adapter;

/**
 * The oldest Next.js cdk-nextjs builds. The adapter API it reads dates from
 * 16.3, which added `routing.middlewareMatchers` and `outputs.*.assetsHashes`
 * (on 16.2 the build dies with a `TypeError` deep in `onBuildComplete`). The
 * floor is 16.4.5 because that release patches the November 2026 advisories:
 * cross-tenant `'use cache'` disclosure, cache poisoning of shared fallback
 * shells, and cross-client response injection in self-hosted apps
 * (GHSA-pc58-hwjq-p385), among others. Every 16.3 and earlier 16.4 release is
 * affected, and cdk-nextjs is exactly the self-hosted, multi-tenant-cache setup
 * those describe.
 *
 * A prerelease compares by its numbers alone, so `17.0.0-canary.1` passes.
 */
const MIN_NEXT_VERSION = [16, 4, 5] as const;

function assertSupportedNextVersion(nextVersion: string | undefined): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(nextVersion ?? "");
  if (!match) {
    return;
  }
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  const index = version.findIndex((part, i) => part !== MIN_NEXT_VERSION[i]);
  if (index !== -1 && version[index] < MIN_NEXT_VERSION[index]) {
    throw new Error(
      `${LOG_PREFIX} Next.js ${nextVersion} is not supported: cdk-nextjs needs ` +
        `Next.js ${MIN_NEXT_VERSION.join(".")} or higher.`,
    );
  }
}

/**
 * `cacheHandlers` with cdk-nextjs's handlers for the two names Next.js defines -
 * `default` (`'use cache'`) and `remote` (`'use cache: remote'`) - and whatever
 * the app configured itself left as it is, including either of those two.
 *
 * Without them Next.js maps both names to one in-memory handler whose tags are
 * process-local, so on a multi-instance deployment `'use cache: remote'` is not
 * shared and a `revalidateTag` reaches only the instance that ran it. See
 * `use-cache-remote-handler.ts` and `use-cache-default-handler.ts`.
 */
function useCacheHandlers(
  configured: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  return {
    ...configured,
    default:
      configured?.default ||
      fileURLToPath(import.meta.resolve("cdk-nextjs/cache-handlers/default")),
    remote:
      configured?.remote ||
      fileURLToPath(import.meta.resolve("cdk-nextjs/cache-handlers/remote")),
  };
}
