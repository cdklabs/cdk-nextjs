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
 * The on-demand counterpart to `/isr/[id]`, for the revalidation e2e. That route
 * also regenerates every 10 seconds on its own, so a test that only watches its
 * timestamp change cannot tell `revalidateTag` working from the clock running
 * out. This one never goes stale inside a test run - `max` revalidates after 30
 * days - so the only thing that can re-render it is an on-demand revalidation.
 *
 * `max` rather than a custom `cacheLife({ revalidate })`, for the reason
 * `/isr/[id]` spells out: its `stale` is not shorter than the shell's, so the
 * route stays `compute: "static"` instead of being postponed.
 */
async function Post({ id }: { id: string }) {
  'use cache';

  cacheLife('max');
  // What `/api/revalidate?collection=on-demand` revalidates. Deliberately not
  // `collection`, so revalidating `/isr/[id]` never touches this route.
  cacheTag('on-demand');

  return (
    <div className="grid grid-cols-6 gap-x-6 gap-y-3">
      <div className="col-span-full space-y-3 lg:col-span-4">
        <h1 className="truncate text-2xl font-medium capitalize text-gray-200">
          On-demand post {id}
        </h1>
      </div>
      <div className="-order-1 col-span-full lg:order-none lg:col-span-2">
        <RenderingInfo type="isr" />
      </div>
    </div>
  );
}
