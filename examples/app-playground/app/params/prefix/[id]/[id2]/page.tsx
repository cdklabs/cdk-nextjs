import { ParamsDump } from '#/ui/params-dump';

/**
 * Two dynamic segments whose names prefix one another. The deployed routing table
 * stores params as `nxtP`-prefixed query keys, and recovering them means matching
 * key names - a match that is a `startsWith` rather than an equality gives `id2`
 * the value of `id`, or drops it. The committed app-playground adapter fixture
 * captures this route, so `dispatch.test.ts` resolves it directly, and
 * `routing-params.test.ts` in examples/e2e-tests requests it on all four
 * deployment types.
 */
export const instant = false;

export default async function Page(props: {
  params: Promise<{ id: string; id2: string }>;
}) {
  const params = await props.params;
  return <ParamsDump params={params} />;
}
