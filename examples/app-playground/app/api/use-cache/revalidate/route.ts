import { revalidateTag } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';
import {
  e2eKey,
  e2eResponse,
  USE_CACHE_E2E_TAG_PREFIX,
} from '#/lib/use-cache-e2e';

/**
 * Expires the `/api/use-cache/*` entries of one `key`. `{ expire: 0 }` rather
 * than `'max'`: the e2e asserts that no instance serves the old value again,
 * and a stale-while-revalidate profile would legitimately serve it once more.
 * Only the e2e's own tags, so this cannot be used to revalidate anything else.
 */
export async function GET(request: NextRequest) {
  const key = e2eKey(request);
  if (!key) {
    return NextResponse.json({ error: 'missing key' }, { status: 400 });
  }
  revalidateTag(`${USE_CACHE_E2E_TAG_PREFIX}${key}`, { expire: 0 });
  return e2eResponse({ revalidated: true, now: Date.now() });
}
