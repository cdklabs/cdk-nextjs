import { ParamsDump } from '#/ui/params-dump';

/**
 * Two dynamic segments whose names prefix one another. The deployed routing table
 * stores params as `nxtP`-prefixed query keys, and recovering them means matching
 * key names - a match that is a `startsWith` rather than an equality gives `id2`
 * the value of `id`, or drops it. There is no committed adapter fixture with a
 * naturally prefixing pair, so `dispatch.test.ts` has to rename one by hand to
 * test it; this route is the real thing, on all four deployment types.
 */
export const instant = false;

export default async function Page(props: {
  params: Promise<{ id: string; id2: string }>;
}) {
  const params = await props.params;
  return <ParamsDump params={params} />;
}
