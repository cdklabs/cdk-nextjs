export type Post = { title: string; body: string };

/**
 * Local stand-in for the `jsonplaceholder.typicode.com/posts/:id` call the
 * isr, ssg and ssr pages used to make. Two of them ran it during `next build`,
 * so one dropped connection to a third-party API failed the e2e job (#269).
 *
 * Nothing depended on the network: the e2e suites assert on the render
 * timestamp in `RenderingInfo`, never on the post, and what makes each page
 * isr, ssg or ssr is its `'use cache'` / `cacheLife` / `connection()` call, not
 * the fetch. Content is derived from `id` so each post still reads differently.
 */
export function getPost(id: string): Post {
  return {
    title: `Post ${id}`,
    body: `Body of post ${id}, generated locally so the page builds and renders without a network call.`,
  };
}
