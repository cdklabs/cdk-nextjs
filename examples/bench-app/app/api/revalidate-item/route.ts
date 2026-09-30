import { revalidateTag } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Expires `/use-cache/<n>`'s entry on every instance: the load tests' `use-cache`
 * script calls this to put rows in the revalidation log while it reads.
 */
export function POST(request: NextRequest) {
  const n = request.nextUrl.searchParams.get('n') ?? '';
  if (!/^\d{1,6}$/.test(n)) {
    return NextResponse.json({ error: 'n must be a number' }, { status: 400 });
  }
  revalidateTag(`item-${n}`, { expire: 0 });
  return NextResponse.json(
    { revalidated: `item-${n}` },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
