import { notFound } from 'next/navigation';
import { RenderingInfo } from '#/ui/rendering-info';

export async function generateStaticParams() {
  // Generate two pages at build time and the rest (3-100) on-demand
  return [{ id: '1' }, { id: '2' }];
}

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (Number(params.id) >= 100) {
    notFound();
  }

  return <Post id={params.id} />;
}

/**
 * Cached, so the fetch and the render timestamp inside `RenderingInfo` happen once
 * per post rather than per request - the ssg e2e asserts exactly that. Under
 * `cacheComponents` an uncached `fetch` (or a `Date.now()`) would make the route
 * dynamic and every visit freshly rendered.
 *
 * The `notFound()` guard stays outside it: throwing to a 404 is control flow for
 * one request, not a value worth caching per id.
 */
async function Post({ id }: { id: string }) {
  'use cache';

  const res = await fetch(`https://jsonplaceholder.typicode.com/posts/${id}`);
  const data = (await res.json()) as { title: string; body: string };

  const isOnDemand = Number(id) >= 3;

  return (
    <div className="grid grid-cols-6 gap-x-6 gap-y-3">
      <div className="col-span-full space-y-3 lg:col-span-4">
        <h1 className="truncate text-2xl font-medium capitalize text-gray-200">
          {data.title}
        </h1>
        <p className="line-clamp-3 font-medium text-gray-500">{data.body}</p>
      </div>
      <div className="-order-1 col-span-full lg:order-none lg:col-span-2">
        <RenderingInfo type={isOnDemand ? 'ssgod' : 'ssg'} />
      </div>
    </div>
  );
}
