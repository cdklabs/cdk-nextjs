import { cacheTag } from 'next/cache';
import { connection, NextRequest, NextResponse } from 'next/server';
import {
  e2eKey,
  e2eResponse,
  generated,
  hold,
  USE_CACHE_E2E_TAG_PREFIX,
} from '#/lib/use-cache-e2e';

/**
 * Plain `'use cache'`: in memory, so each instance has its own value - but a
 * `revalidateTag` on any one instance has to expire it on all of them, which
 * cdk-nextjs's `cacheHandlers.default` does through the revalidation table.
 */
async function defaultValue(key: string) {
  'use cache';
  cacheTag(`${USE_CACHE_E2E_TAG_PREFIX}${key}`);
  return generated();
}

export async function GET(request: NextRequest) {
  await connection();
  const key = e2eKey(request);
  if (!key) {
    return NextResponse.json({ error: 'missing key' }, { status: 400 });
  }
  await hold(request);
  return e2eResponse(await defaultValue(key));
}
