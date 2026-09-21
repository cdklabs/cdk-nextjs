import { Boundary } from '#/ui/boundary';
import {
  CategoryTabGroup,
  CategoryTabGroupFallback,
} from '#/ui/category-tab-group';
import { Suspense } from 'react';
import { Counter } from '../context-click-counter';

export default async function Layout(props: {
  children: React.ReactNode;
  params: Promise<{ categorySlug: string }>;
}) {
  const { children } = props;

  return (
    <Boundary labels={['Layout [Server Component]']} animateRerendering={false}>
      <div className="space-y-9">
        <Suspense fallback={<CategoryTabGroupFallback />}>
          <CategoryTabGroup basePath="/context" params={props.params} />
        </Suspense>
        <Counter />
        <div>{children}</div>
      </div>
    </Boundary>
  );
}
