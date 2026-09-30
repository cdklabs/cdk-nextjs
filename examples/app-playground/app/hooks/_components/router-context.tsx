'use client';

import { Boundary } from '#/ui/boundary';
import {
  useParams,
  usePathname,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from 'next/navigation';
import { Suspense } from 'react';

/**
 * Every hook below reads the URL, which a prerender does not have, so with
 * `cacheComponents` they suspend. The shell gets the empty panel; the values
 * stream in with the request.
 */
export function HooksClient() {
  return (
    <Suspense
      fallback={
        <Boundary labels={['Client Component Hooks']} size="small">
          <div className="h-32" />
        </Boundary>
      }
    >
      <RouterHooks />
    </Suspense>
  );
}

function RouterHooks() {
  const pathname = usePathname();
  const params = useParams();
  const selectedLayoutSegment = useSelectedLayoutSegment();
  const selectedLayoutSegments = useSelectedLayoutSegments();
  const searchParams = useSearchParams();

  return (
    <Boundary labels={['Client Component Hooks']} size="small">
      <div className="overflow-x-auto text-sm text-white [color-scheme:dark]">
        <pre>
          {JSON.stringify(
            {
              usePathname: pathname,
              useParams: params,
              useSearchParams: searchParams
                ? Object.fromEntries(searchParams.entries())
                : {},
              useSelectedLayoutSegment: selectedLayoutSegment,
              useSelectedLayoutSegments: selectedLayoutSegments,
            },
            null,
            2,
          )}
        </pre>
      </div>
    </Boundary>
  );
}
