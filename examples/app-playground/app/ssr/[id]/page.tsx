import { connection } from 'next/server';
import { getPost } from '#/lib/posts';
import { RenderingInfo } from '#/ui/rendering-info';

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // Render at request time - the `cache: 'no-store'` fetch this page used to make
  // did this as a side effect, and the ssr e2e asserts every visit is fresh.
  await connection();
  const data = getPost(params.id);

  return (
    <div className="grid grid-cols-6 gap-x-6 gap-y-3">
      <div className="col-span-full space-y-3 lg:col-span-4">
        <h1 className="truncate text-2xl font-medium capitalize text-gray-200">
          {data.title}
        </h1>
        <p className="font-medium text-gray-500">{data.body}</p>
      </div>
      <div className="-order-1 col-span-full lg:order-none lg:col-span-2">
        <RenderingInfo type="ssr" />
      </div>
    </div>
  );
}
