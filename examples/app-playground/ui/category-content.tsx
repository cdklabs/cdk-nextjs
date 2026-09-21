import { getCategory } from '#/app/api/categories/getCategories';
import { SkeletonCard } from '#/ui/skeleton-card';

type CategoryParams = Promise<{
  categorySlug?: string;
  subCategorySlug?: string;
}>;

/**
 * The name of the category in the URL. Its own component because it reads
 * `params`, which is reading the request: with `cacheComponents` on, a route
 * without `generateStaticParams` has no params at all while its shell is being
 * prerendered, so this has to render inside a `<Suspense>` boundary.
 *
 * `'use cache'` is not an alternative here. Caching the page would still leave the
 * render waiting on the slug, and a shell cannot wait.
 */
export async function CategoryTitle({
  params,
  slugKey = 'categorySlug',
  prefix = '',
}: {
  params: CategoryParams;
  slugKey?: 'categorySlug' | 'subCategorySlug';
  /** e.g. `"All "` on a category page that lists everything under it. */
  prefix?: string;
}) {
  const slug = (await params)[slugKey]!;
  // Cached, so this is a cache read rather than a network call on all but the
  // first request for a category.
  const category = await getCategory({ slug });

  // One interpolation, not `{prefix}{category.name}`: two adjacent expressions
  // are two text nodes, and React separates them in the HTML with a `<!-- -->`
  // marker. Keeping the title a single string is what lets the ppr e2e assert on
  // "All Electronics" appearing in the bytes.
  return (
    <h1 className="text-xl font-medium text-gray-400/80">{`${prefix}${category.name}`}</h1>
  );
}

/** Reserves the title's line in the prerendered shell so nothing shifts. */
export function CategoryTitleFallback() {
  return <div className="h-7" />;
}

/** The title over the category's skeleton cards - the body of most demo pages. */
export async function CategoryCards({
  params,
  slugKey = 'categorySlug',
  prefix = '',
  count,
}: {
  params: CategoryParams;
  slugKey?: 'categorySlug' | 'subCategorySlug';
  prefix?: string;
  /** Fixed number of cards; defaults to the category's own count. */
  count?: number;
}) {
  const slug = (await params)[slugKey]!;
  const category = await getCategory({ slug });

  return (
    <>
      {/* A single interpolation - see `CategoryTitle`. */}
      <h1 className="text-xl font-medium text-gray-400/80">{`${prefix}${category.name}`}</h1>

      <SkeletonCardGrid count={count ?? category.count} />
    </>
  );
}

/**
 * What the shell shows in place of the cards. The card count comes from the
 * category, which the shell does not know yet, so it guesses a full row.
 */
export function CategoryCardsFallback({ count = 9 }: { count?: number }) {
  return (
    <>
      <CategoryTitleFallback />
      <SkeletonCardGrid count={count} />
    </>
  );
}

export function SkeletonCardGrid({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
