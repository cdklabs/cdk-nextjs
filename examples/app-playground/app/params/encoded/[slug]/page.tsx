import { ParamsDump } from '#/ui/params-dump';

/**
 * A param whose value needs percent-encoding on the wire, which is where the four
 * deployment types diverge most sharply. A Lambda Function URL hands the runtime
 * a `rawPath` that is still encoded; API Gateway has already decoded the path and
 * the query, so the runtime re-encodes the query string before handing it on. Two
 * code paths, and `%20` plus multi-byte UTF-8 is the input that tells them apart
 * - a double-decode turns `h%C3%A9llo` into mojibake, and a double-*encode*
 * leaves the literal `%C3%A9` in the rendered page.
 */
export const instant = false;

export default async function Page(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  return (
    <div className="space-y-3">
      <ParamsDump params={params} />
      {/* The query half of the same question, asserted separately: a runtime can
          get the path right and the query wrong, and on API Gateway they are
          handled by different code. */}
      <pre data-testid="search-params" className="text-sm text-gray-200">
        {JSON.stringify(searchParams)}
      </pre>
    </div>
  );
}
