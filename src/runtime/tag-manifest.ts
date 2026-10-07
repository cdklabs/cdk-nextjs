import type { TrackedTagMarkers } from "../adapter/aws-cache-store";

/**
 * The key the process's tag manifest (`TrackedTagMarkers`, from the adapter's
 * `sharedTagManifest`) is kept under on `globalThis`, since the runtime and the
 * cache handlers are separate bundles.
 */
export const TAG_MANIFEST_SYMBOL = Symbol.for(
  "cdk-nextjs.use-cache.tag-manifest",
);

/**
 * Render a page, after waiting for the revalidation log query if the instance
 * has fallen behind on it (sat idle, or thawed): here, before Next.js starts
 * rendering, rather than inside the first `'use cache'` lookup, where the wait
 * cuts a staged render's static stage short. Just `render` until a cache
 * handler first creates the manifest, and then there is nothing to catch up
 * on. Rejects only as `render` does.
 */
export async function catchUpTags<T>(render: () => Promise<T>): Promise<T> {
  const global = globalThis as {
    [TAG_MANIFEST_SYMBOL]?: Pick<TrackedTagMarkers, "catchUp">;
  };
  const manifest = global[TAG_MANIFEST_SYMBOL];
  return manifest ? manifest.catchUp(render) : render();
}
