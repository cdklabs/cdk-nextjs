'use client';

import { Boundary } from '#/ui/boundary';
import {
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from 'next/navigation';
import { Suspense } from 'react';

/**
 * These hooks read the URL, which a prerender does not have, so with
 * `cacheComponents` they suspend. The boundary lives here rather than in every
 * layout that renders this, and renders nothing in the shell - which is what this
 * component does for an unselected segment anyway.
 */
export function LayoutHooks() {
  return (
    <Suspense>
      <SelectedSegments />
    </Suspense>
  );
}

function SelectedSegments() {
  const selectedLayoutSegment = useSelectedLayoutSegment();
  const selectedLayoutSegments = useSelectedLayoutSegments();

  return selectedLayoutSegment ? (
    <Boundary labels={['Client Component Hooks']} size="small">
      <div className="overflow-x-auto text-sm text-white [color-scheme:dark]">
        <pre>
          {JSON.stringify(
            {
              useSelectedLayoutSegment: selectedLayoutSegment,
              useSelectedLayoutSegments: selectedLayoutSegments,
            },
            null,
            2,
          )}
        </pre>
      </div>
    </Boundary>
  ) : null;
}
