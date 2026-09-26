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
 * `'use cache: remote'`: stored in S3 by cdk-nextjs's `cacheHandlers.remote`, so
 * every instance answers with the value whichever instance generated first -
 * until `revalidateTag` expires it everywhere.
 */
async function remoteValue(key: string) {
  'use cache: remote';
  cacheTag(`${USE_CACHE_E2E_TAG_PREFIX}${key}`);
  return generated();
}

export async function GET(request: NextRequest) {
  // Request-time, not prerendered: see `app/api/runtime-identity/route.ts`.
  await connection();
  const key = e2eKey(request);
  if (!key) {
    return NextResponse.json({ error: 'missing key' }, { status: 400 });
  }
  await hold(request);
  return e2eResponse(await remoteValue(key));
}
