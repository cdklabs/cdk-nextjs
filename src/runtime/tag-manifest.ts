/**
 * The process's tag manifest (`TrackedTagMarkers`, from the adapter's
 * `sharedTagManifest`), as the runtime sees it: through `globalThis`, since
 * the runtime and the cache handlers are separate bundles. Absent until a
 * cache handler first creates it, and then there is nothing to catch up on.
 */
interface SharedTagManifest {
  catchUp(): Promise<void>;
  settled(): Promise<void>;
}

/** The key `sharedTagManifest` keeps it under. */
const TAG_MANIFEST_SYMBOL = Symbol.for("cdk-nextjs.use-cache.tag-manifest");

function tagManifest(): SharedTagManifest | undefined {
  return (globalThis as { [TAG_MANIFEST_SYMBOL]?: SharedTagManifest })[
    TAG_MANIFEST_SYMBOL
  ];
}

/**
 * Wait for the revalidation log query if the instance has fallen behind on it
 * (sat idle, or thawed): here, before Next.js starts rendering, rather than
 * inside the first `'use cache'` lookup, where the wait cuts a staged
 * render's static stage short. Never rejects.
 */
export async function catchUpTags(): Promise<void> {
  await tagManifest()?.catchUp();
}

/**
 * Resolves once no revalidation log query is in flight, so a Lambda sandbox
 * does not freeze with one open. Never rejects.
 */
export async function tagRefreshSettled(): Promise<void> {
  await tagManifest()?.settled();
}
