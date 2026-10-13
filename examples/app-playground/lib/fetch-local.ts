/**
 * `fetch` a local value, for the cached calls whose coverage depends on their
 * being a `fetch`. They used to call third-party APIs during `next build`, where
 * one dropped connection failed the build (#269).
 *
 * Next.js stores a `fetch` made while prerendering as a `FETCH`-kind entry: the
 * cdk-nextjs cache handler writes it and reads it back across `next build`'s
 * prerender passes, and the adapter seeds it into S3 at deploy - a path no other
 * route exercises. A `data:` URL keeps that path without the network: Next.js's
 * patched `fetch` caches it by URL like any other, and nothing is listening on
 * localhost during `next build` or inside a Lambda to serve a local route
 * handler instead.
 */
export async function fetchLocal<T>(value: T): Promise<T> {
  const res = await fetch(
    `data:application/json,${encodeURIComponent(JSON.stringify(value))}`,
  );
  return (await res.json()) as T;
}
