import { getCategories, getCategory } from '#/app/api/categories/getCategories';
import { TabGroup, type Item } from '#/ui/tab-group';

/**
 * The tab strip every `[categorySlug]` layout shows: "All", plus one tab per
 * subcategory of the category in the URL.
 *
 * It lives in its own component because it reads `params`, which is reading the
 * request. With `cacheComponents` on, a layout cannot do that at its top level -
 * the layout is part of the prerendered shell, and the shell is built before any
 * URL is known. Rendering this inside a `<Suspense fallback={<CategoryTabGroupFallback />}>`
 * is what lets the rest of the layout prerender.
 *
 * Note that `'use cache'` is not the answer for a layout the way it is for these
 * routes' pages: a layout receives `children`, which is not a cacheable value, so
 * the directive does not cover its `params` access.
 */
export async function CategoryTabGroup({
  basePath,
  params,
  extraItems = [],
}: {
  /** Path the tabs link under, e.g. `/layouts`. */
  basePath: string;
  params: Promise<{ categorySlug: string }>;
  /** Appended after the subcategories, e.g. the deliberately broken link the not-found demo needs. */
  extraItems?: Item[];
}) {
  const { categorySlug } = await params;

  // Both calls are cached, so this resolves from the cache rather than the
  // network on all but the first request for a category.
  const category = await getCategory({ slug: categorySlug });
  const categories = await getCategories({ parent: categorySlug });

  return (
    <TabGroup
      path={`${basePath}/${category.slug}`}
      items={[
        {
          text: 'All',
        },
        ...categories.map((x) => ({
          text: x.name,
          slug: x.slug,
        })),
        ...extraItems,
      ]}
    />
  );
}

/**
 * What the prerendered shell shows in place of the tabs. Same height as a rendered
 * tab so the layout does not shift when the real strip streams in.
 */
export function CategoryTabGroupFallback() {
  return <div className="h-7" />;
}
