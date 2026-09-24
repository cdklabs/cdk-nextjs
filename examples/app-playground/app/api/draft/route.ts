import { draftMode } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Turns draft mode on and off. Next.js implements it entirely with a cookie -
 * `__prerender_bypass` in the App Router; the Pages Router adds
 * `__next_preview_data` for the payload, which is why the runtime's own comments
 * name both - so it is the sharpest end-to-end test of cookie handling this app
 * can have.
 *
 * Why that is worth a route: the API Gateway shell has to rebuild a
 * `Cookie` header out of a request whose headers arrived split, and it joins the
 * repeated values with `"; "`. Joining them with `","` instead - the obvious thing,
 * and correct for most repeated headers - loses every cookie after the first,
 * which silently breaks draft mode and nothing else. That join is unit-tested;
 * this is the route that proves it end to end, on the deployment type where the
 * rebuild actually happens.
 */
export async function GET(request: NextRequest) {
  const draft = await draftMode();
  const enable = request.nextUrl.searchParams.has('enable');

  if (enable) {
    draft.enable();
  } else {
    draft.disable();
  }

  return NextResponse.json({ draft: enable });
}
