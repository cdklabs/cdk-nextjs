export type Post = { title: string; body: string };

/**
 * Local stand-in for the `jsonplaceholder.typicode.com/posts/:id` call the
 * isr, ssg and ssr pages used to make. Two of them ran it during `next build`,
 * so one dropped connection to a third-party API failed the e2e job (#269).
 *
 * Nothing asserts on the post itself - the e2e suites check the render
 * timestamp in `RenderingInfo` - so content is derived from `id`.
 */
export function getPost(id: string): Post {
  return {
    title: `Post ${id}`,
    body: `Body of post ${id}, generated locally so the page builds and renders without a network call.`,
  };
}

/**
 * `getPost` through `fetch`, for the pages whose coverage depends on the call
 * being a `fetch`. Next.js caches a `fetch` made while prerendering as a
 * `FETCH`-kind entry, which cdk-nextjs seeds into S3 at deploy and the cache
 * handler reads back on revalidation - a path no other route exercises. A
 * `data:` URL keeps that path without the network: Next.js's patched `fetch`
 * caches it by URL like any other, and nothing is listening on localhost during
 * `next build` or inside a Lambda to serve a local route handler instead.
 */
export async function fetchPost(id: string): Promise<Post> {
  const url = `data:application/json,${encodeURIComponent(JSON.stringify(getPost(id)))}`;
  const res = await fetch(url);
  return (await res.json()) as Post;
}
