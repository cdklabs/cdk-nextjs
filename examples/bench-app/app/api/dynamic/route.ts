import { NextRequest, NextResponse } from 'next/server';
import { getRows } from '#/lib/rows';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  const now = Date.now();
  return NextResponse.json(
    {
      now,
      query: Object.fromEntries(request.nextUrl.searchParams),
      rows: getRows(now, 20),
    },
    // Explicit, so no CDN caches it whatever its defaults for a response
    // without Cache-Control: the load tests count on this reaching compute.
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
