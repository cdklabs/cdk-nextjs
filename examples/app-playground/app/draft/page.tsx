import { draftMode } from 'next/headers';
import { Boundary } from '#/ui/boundary';

/**
 * Reports whether draft mode is on, which is only true if the
 * `__prerender_bypass` cookie set by `/api/draft?enable=1` survived the round
 * trip through CloudFront, API Gateway or the ALB and was still readable
 * server-side.
 *
 * `instant = false` because reading `draftMode()` is reading the request, and
 * under `cacheComponents` a page that does so outside a `<Suspense>` boundary has
 * to say it blocks. The rendered value is also the thing being asserted, so there
 * is no shell worth prerendering here.
 */
export const instant = false;

export default async function Page() {
  const draft = await draftMode();

  return (
    <Boundary labels={['draft']} color={draft.isEnabled ? 'blue' : 'default'}>
      <p data-testid="draft-enabled" className="text-sm">
        {draft.isEnabled ? 'draft:on' : 'draft:off'}
      </p>
    </Boundary>
  );
}
