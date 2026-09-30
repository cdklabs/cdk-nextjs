import { cacheLife, cacheTag } from 'next/cache';
import { RenderingInfo } from '#/ui/rendering-info';

export async function generateStaticParams() {
  return [{ id: '1' }, { id: '2' }, { id: '3' }];
}

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return <Post id={params.id} />;
}

/**
 * What makes this route ISR under `cacheComponents`: `cacheLife` replaces the
 * `next: { revalidate: 10 }` this page used to pass to `fetch`, and `cacheTag`
 * replaces that call's `tags`. Route segment config (`revalidate`,
 * `dynamicParams`) is rejected outright with `cacheComponents` on.
 *
 * Only `revalidate` is overridden, and that is load-bearing. `stale` is how long a
 * client may reuse the value without asking again, and the prerendered shell is
 * served with its own stale time (`x-nextjs-stale-time: 300`). A `'use cache'`
 * scope with a *shorter* `stale` than that cannot be baked into the shell, so the
 * build postpones it: the route becomes `compute: "resuming"` in
 * `prerender-manifest.json` and is served with
 * `cache-control: private, no-store` and no `x-nextjs-cache` header - no CDN
 * caching, no ISR, nothing for the isr e2e to assert. Leaving `stale` at the
 * default keeps the route `compute: "static"` with
 * `initialRevalidateSeconds: 10`, which is what ISR is.
 */
async function Post({ id }: { id: string }) {
  'use cache';

  // Serve the cached render for 10 seconds, then revalidate in the background on
  // the next request - the `x-nextjs-cache: STALE` the isr e2e asserts on.
  cacheLife({ revalidate: 10 });
  // `/api/revalidate` calls `revalidateTag('collection')`, which is how the
  // revalidation e2e invalidates every post at once.
  cacheTag('collection');

  const res = await fetch(`https://jsonplaceholder.typicode.com/posts/${id}`);
  const data = (await res.json()) as { title: string; body: string };

  return (
    <div className="grid grid-cols-6 gap-x-6 gap-y-3">
      <div className="col-span-full space-y-3 lg:col-span-4">
        <h1 className="truncate text-2xl font-medium capitalize text-gray-200">
          {data.title}
        </h1>
        <p className="font-medium text-gray-500">{data.body}</p>
      </div>
      <div className="-order-1 col-span-full lg:order-none lg:col-span-2">
        <RenderingInfo type="isr" />
      </div>
    </div>
  );
}
