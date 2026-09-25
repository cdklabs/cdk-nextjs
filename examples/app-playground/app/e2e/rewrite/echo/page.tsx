/**
 * The destination of the `beforeFiles` rewrite in `next.config.ts`. Reflects the
 * query the rewrite produced, because a rewrite applied twice does not fail - it
 * renders a wrong `from`.
 *
 * A page rather than a route handler on purpose. Next.js's second rewrite pass
 * rewrites the `query` object a page's `searchParams` come from, and leaves
 * `req.url` alone - which is all a route handler's `request.nextUrl` reads. A
 * route handler here passes with the defect 29 fix reverted.
 */
export const instant = false;

export default async function Page(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  return <pre data-testid="search-params">{JSON.stringify(searchParams)}</pre>;
}
