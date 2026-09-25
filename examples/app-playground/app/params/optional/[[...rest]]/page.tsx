import { ParamsDump } from '#/ui/params-dump';

/**
 * An optional catch-all, which has to render with *no* segments at all. Matching
 * `/params/optional` used to hand the route a single segment whose value was the
 * string `"undefined"` - a phantom the page then rendered - because the params
 * recovered from the routing table did not distinguish "absent" from "empty".
 *
 * The count is rendered separately from the dump so a test can assert zero
 * without depending on how an absent catch-all is spelled in JSON (`undefined`
 * disappears from `JSON.stringify`, `[]` does not).
 */
export const instant = false;

export default async function Page(props: {
  params: Promise<{ rest?: string[] }>;
}) {
  const params = await props.params;
  return (
    <div className="space-y-3">
      <ParamsDump params={params} />
      <p data-testid="segment-count">{params.rest?.length ?? 0}</p>
    </div>
  );
}
