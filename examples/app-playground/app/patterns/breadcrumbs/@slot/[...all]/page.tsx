import { Breadcrumbs } from '#/app/patterns/breadcrumbs/_components/breadcrumbs';
import { Suspense } from 'react';

export default function Page(props: {
  params: Promise<{
    all: string[];
  }>;
}) {
  // The trail is made entirely of the segments in the URL, so with
  // `cacheComponents` there is nothing to prerender here: it all waits for the
  // request behind this boundary.
  return (
    <Suspense>
      <Trail params={props.params} />
    </Suspense>
  );
}

async function Trail({ params }: { params: Promise<{ all: string[] }> }) {
  const { all } = await params;

  // Note: you could fetch breadcrumb data based on params here
  // e.g. title, slug, children/siblings (for dropdowns)
  const items = [
    {
      text: 'Home',
      href: '/patterns/breadcrumbs',
    },
    ...all.map((param) => ({
      text: param,
      href: `/patterns/breadcrumbs/${param}`,
    })),
  ];

  return <Breadcrumbs items={items} />;
}
