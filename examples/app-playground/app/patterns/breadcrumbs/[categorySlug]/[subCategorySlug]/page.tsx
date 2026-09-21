import { CategoryCards, CategoryCardsFallback } from '#/ui/category-content';
import { Suspense } from 'react';

export default function Page(props: {
  params: Promise<{ categorySlug: string; subCategorySlug: string }>;
}) {
  return (
    <div className="space-y-4">
      {/*
       * Everything that depends on the slug in the URL streams in after the shell:
       * with `cacheComponents` on, reading `params` outside a `<Suspense>`
       * boundary would stop this route from being prerendered at all.
       */}
      <Suspense fallback={<CategoryCardsFallback />}>
        <CategoryCards params={props.params} slugKey="subCategorySlug" />
      </Suspense>
    </div>
  );
}
