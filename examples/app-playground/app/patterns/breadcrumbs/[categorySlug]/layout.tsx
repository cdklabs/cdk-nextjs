import {
  CategoryTabGroup,
  CategoryTabGroupFallback,
} from '#/ui/category-tab-group';
import { Suspense } from 'react';

export default async function Layout(props: {
  children: React.ReactNode;
  params: Promise<{ categorySlug: string }>;
}) {
  const { children } = props;

  return (
    <div className="space-y-9">
      <div className="flex justify-between">
        <Suspense fallback={<CategoryTabGroupFallback />}>
          <CategoryTabGroup
            basePath="/patterns/breadcrumbs"
            params={props.params}
          />
        </Suspense>
      </div>

      <div>{children}</div>
    </div>
  );
}
