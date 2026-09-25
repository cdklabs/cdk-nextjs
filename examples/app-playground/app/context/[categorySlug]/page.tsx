import { Boundary } from '#/ui/boundary';
import { CategoryTitle, CategoryTitleFallback } from '#/ui/category-content';
import { Suspense } from 'react';
import { Counter } from '../context-click-counter';

export default function Page(props: {
  params: Promise<{ categorySlug: string }>;
}) {
  return (
    <Boundary labels={['Page [Server Component]']} animateRerendering={false}>
      <div className="space-y-8">
        {/*
         * The title is the only part that needs the slug in the URL, so it is the
         * only part behind a boundary: with `cacheComponents` on, reading `params`
         * outside one would stop this route from being prerendered.
         */}
        <Suspense fallback={<CategoryTitleFallback />}>
          <CategoryTitle params={props.params} prefix="All " />
        </Suspense>

        <Counter />
      </div>
    </Boundary>
  );
}
