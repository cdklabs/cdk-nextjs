import { fetchLocal } from '#/lib/fetch-local';

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

/** `getPost` through `fetch` - see `fetchLocal` for why. */
export function fetchPost(id: string): Promise<Post> {
  return fetchLocal(getPost(id));
}
