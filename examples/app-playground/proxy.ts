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

  if (process.env.PREPEND_APIGW_STAGE) {
    // API Gateway strips the stage name from the path when invoking Lambda.
    // We need to prepend it back so Next.js basePath works correctly.
    // See: https://github.com/awslabs/aws-lambda-web-adapter?tab=readme-ov-file#request-context
    const reqCtxStr = request.headers.get('x-amzn-request-context');
    let stage: string | undefined;
    if (reqCtxStr) {
      const reqCtx = JSON.parse(reqCtxStr);
      stage = reqCtx.stage;
    }

    // Next.js re-enters this middleware for its own internal fetches (e.g.
    // resolving `_next/image` local sources) using a mocked request that
    // doesn't carry the original `x-amzn-request-context` header, so `stage`
    // can't be derived per-request there. Fall back to the stage name baked
    // in at deploy time so those internal fetches still resolve to the
    // correct path instead of getting a literal "/null" prefix or 404ing.
    stage ??= process.env.API_GATEWAY_STAGE;

    if (stage) {
      const url = new URL(request.url);
      const originalPath = url.pathname;

      // Skip rewriting if path already starts with stage name
      // This prevents double-rewriting when Next.js internally fetches static files
      if (originalPath.startsWith(`/${stage}`)) {
        return NextResponse.next();
      }

      // `/` must become `/${stage}`, not `/${stage}/`: routing matches the
      // rewritten path against the built pathnames as-is, and the
      // `trailingSlash: false` redirect that would normally clean up
      // `/${stage}/` runs *before* middleware, so a trailing slash here is a
      // 404 (and redirecting would bounce off the stage root forever).
      url.pathname =
        originalPath === '/' ? `/${stage}` : `/${stage}${originalPath}`;
      // debug(
      //   `[PROXY] Rewriting request - Original: ${originalPath} -> Rewritten: ${url.pathname}`,
      // );
      return NextResponse.rewrite(url);
    }
  }

  const response = NextResponse.next();
  // debug('%O', {
  //   status: response.status,
  //   statusText: response.statusText,
  //   body: response.body,
  // });
  return response;
}
