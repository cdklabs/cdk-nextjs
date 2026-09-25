import { LayoutHooks } from '#/app/hooks/_components/router-context-layout';
import {
  CategoryTabGroup,
  CategoryTabGroupFallback,
} from '#/ui/category-tab-group';
import { ClickCounter } from '#/ui/click-counter';
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
          <CategoryTabGroup basePath="/hooks" params={props.params} />
        </Suspense>

        <div className="self-start">
          <ClickCounter />
        </div>
      </div>

      <LayoutHooks />

      <div>{children}</div>
    </div>
  );
}
