import { NextRequest, NextResponse } from 'next/server';
import { instanceId } from './runtime-identity';

/**
 * Shared by the `/api/use-cache/*` routes the `use-cache` e2e drives. Each test
 * run picks its own `key`, so entries from earlier runs or from a test running
 * alongside never answer for it, and tags its entry with it, so a revalidation
 * reaches only that run's entry.
 */
export const USE_CACHE_E2E_TAG_PREFIX = 'e2e-use-cache-';

/** The `key` query parameter, or `null` if it is missing or malformed. */
export function e2eKey(request: NextRequest): string | null {
  const key = request.nextUrl.searchParams.get('key');
  return key && /^[a-z0-9-]{1,64}$/.test(key) ? key : null;
}

/**
 * How long to hold the response, up to 2s. Concurrent requests only spread
 * across Lambda instances if they overlap, and an uncached handler this small
 * returns before the next request arrives; holding them is what makes a burst
 * reach more than one instance.
 */
export async function hold(request: NextRequest): Promise<void> {
  const ms = Math.min(
    Number(request.nextUrl.searchParams.get('holdMs')) || 0,
    2000,
  );
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** The response every `/api/use-cache/*` route answers with. */
export function e2eResponse(body: Record<string, unknown>) {
  return NextResponse.json(
    { ...body, instanceId: instanceId() },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/** A value that is different every time it is generated. */
export function generated() {
  return { value: crypto.randomUUID(), generatedAt: Date.now() };
}
