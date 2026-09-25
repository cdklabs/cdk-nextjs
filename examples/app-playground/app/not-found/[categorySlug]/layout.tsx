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
      <div>
        <div className="flex justify-between">
          {/*
           * `CategoryTabGroup` calls `getCategory()`, which calls `notFound()` when
           * the slug does not exist, so this boundary is also where the demo's 404
           * comes from:
           * - `notFound()` renders the closest `not-found.tsx` in the route segment
           *   hierarchy.
           * - For `layout.js`, the closest `not-found.tsx` starts from the parent
           *   segment. For `page.js`, it starts from the same segment.
           * - Learn more: https://nextjs.org/docs/app/building-your-application/routing#component-hierarchy.
           */}
          <Suspense fallback={<CategoryTabGroupFallback />}>
            <CategoryTabGroup
              basePath="/not-found"
              params={props.params}
              extraItems={[
                {
                  text: 'Subcategory That Does Not Exist',
                  slug: 'does-not-exist',
                },
              ]}
            />
          </Suspense>

          <div className="self-start">
            <ClickCounter />
          </div>
        </div>
      </div>

      <div>{children}</div>
    </div>
  );
}
