import { AsyncLocalStorage } from "node:async_hooks";
import type { TrackedTagMarkers } from "../adapter/aws-cache-store";

/**
 * The key {@link outsideRequest}'s context is kept under on `globalThis`, for
 * the same reason as {@link TAG_MANIFEST_SYMBOL}.
 */
export const OUTSIDE_REQUEST_SYMBOL = Symbol.for(
  "cdk-nextjs.outside-request-context",
);

type ContextRunner = <T>(fn: () => T) => T;

/**
 * Capture the context the runtime's module loads in, outside any request.
 * Called once, at load; a later call keeps the first capture.
 */
export function captureOutsideRequest(): void {
  const global = globalThis as { [OUTSIDE_REQUEST_SYMBOL]?: ContextRunner };
  global[OUTSIDE_REQUEST_SYMBOL] ??= AsyncLocalStorage.snapshot();
}

/**
 * Run `fn` in the context {@link captureOutsideRequest} captured, where Next.js's
 * request stores are unset: or in the current one, if nothing was captured
 * (outside the runtime, as in unit tests).
 *
 * Next.js 16.4 patches `Date.now()`, `new Date()`, `Math.random()` and
 * `crypto`'s random functions to end a staged render's static stage when one is
 * called during it (`node-environment-extensions/io-utils`), judged by its
 * request store. Cache handler work called from inside the render - the tag
 * refresh's clock reads, the AWS SDK's request signing and invocation ids - is
 * not the render's, but it runs in the render's context, so it counted: a
 * draft mode page's static stage ended empty, and the client cached nothing
 * from it.
 */
export function outsideRequest<T>(fn: () => T): T {
  const global = globalThis as { [OUTSIDE_REQUEST_SYMBOL]?: ContextRunner };
  const run = global[OUTSIDE_REQUEST_SYMBOL];
  return run ? run(fn) : fn();
}

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
