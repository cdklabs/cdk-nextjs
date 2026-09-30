import { HooksClient } from '#/app/hooks/_components/router-context';
import { CategoryTitle, CategoryTitleFallback } from '#/ui/category-content';
import { Suspense } from 'react';

export default function Page(props: {
  params: Promise<{ categorySlug: string; subCategorySlug: string }>;
}) {
  return (
    <div className="space-y-9">
      <Suspense fallback={<CategoryTitleFallback />}>
        <CategoryTitle params={props.params} slugKey="subCategorySlug" />
      </Suspense>

      <HooksClient />
    </div>
  );
}
