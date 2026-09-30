import { CategoryCards, CategoryCardsFallback } from '#/ui/category-content';
import { Suspense } from 'react';

export default function Page(props: {
  params: Promise<{ categorySlug: string }>;
}) {
  return (
    <div className="space-y-4">
      {/*
       * `CategoryCards` calls `getCategory()`, which calls `notFound()` when the
       * slug does not exist:
       * - `notFound()` renders the closest `not-found.tsx` in the route segment
       *   hierarchy.
       * - For `layout.js`, the closest `not-found.tsx` starts from the parent
       *   segment. For `page.js`, it starts from the same segment.
       * - Learn more: https://nextjs.org/docs/app/building-your-application/routing#component-hierarchy.
       *
       * Everything that depends on the slug in the URL streams in after the shell:
       * with `cacheComponents` on, reading `params` outside a `<Suspense>`
       * boundary would stop this route from being prerendered at all.
       */}
      <Suspense fallback={<CategoryCardsFallback count={9} />}>
        <CategoryCards params={props.params} prefix="All " count={9} />
      </Suspense>
    </div>
  );
}
