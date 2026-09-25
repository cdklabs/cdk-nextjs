import { HooksClient } from '#/app/hooks/_components/router-context';
import { CategoryTitle, CategoryTitleFallback } from '#/ui/category-content';
import { Suspense } from 'react';

export default function Page(props: {
  params: Promise<{ categorySlug: string }>;
}) {
  return (
    <div className="space-y-9">
      {/*
       * The title is the only part that needs the slug in the URL - see
       * `CategoryTitle` for why that means it renders behind a boundary.
       */}
      <Suspense fallback={<CategoryTitleFallback />}>
        <CategoryTitle params={props.params} prefix="All " />
      </Suspense>

      <HooksClient />
    </div>
  );
}
