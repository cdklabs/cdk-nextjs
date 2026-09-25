import { Boundary } from '#/ui/boundary';
import { CategoryTitle, CategoryTitleFallback } from '#/ui/category-content';
import { Suspense } from 'react';
import { Counter } from '../../context-click-counter';

export default function Page(props: {
  params: Promise<{ categorySlug: string; subCategorySlug: string }>;
}) {
  return (
    <Boundary labels={['Page [Server Component]']} animateRerendering={false}>
      <div className="space-y-8">
        <Suspense fallback={<CategoryTitleFallback />}>
          <CategoryTitle params={props.params} slugKey="subCategorySlug" />
        </Suspense>

        <Counter />
      </div>
    </Boundary>
  );
}
