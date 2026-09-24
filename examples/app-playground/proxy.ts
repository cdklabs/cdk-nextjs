import { NextResponse, NextRequest } from 'next/server';
import getDebug from 'debug';

const debug = getDebug('cdk-nextjs:proxy');

/**
 * Image path the middleware e2e asks for in order to prove that middleware runs
 * for `_next/image` requests. cdk-nextjs optimizes images itself rather than
 * letting Next.js re-enter its own request handler, so "does middleware still
 * see image requests" is a real question with a silent wrong answer.
 */
const E2E_BLOCKED_IMAGE = '/static/e2e-middleware-image.png';

export default function proxy(request: NextRequest) {
  // debug('request.url:', request.url);

  // Narrow enough to never touch real traffic, and the `url` search param is
  // part of the CloudFront cache key, so the 403 cannot be served to anything
  // else.
  if (
    request.nextUrl.pathname.endsWith('/_next/image') &&
    request.nextUrl.searchParams.get('url') === E2E_BLOCKED_IMAGE
  ) {
    return new NextResponse('blocked by proxy', { status: 403 });
  }

  const response = NextResponse.next();
  // debug('%O', {
  //   status: response.status,
  //   statusText: response.statusText,
  //   body: response.body,
  // });
  return response;
}
