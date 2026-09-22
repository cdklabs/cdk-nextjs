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
    // API Gateway strips the stage name from the path when invoking Lambda, so
    // it has to be prepended back for Next.js `basePath` to match.
    //
    // The stage is read from the environment rather than per-request. Next.js
    // re-enters this proxy for its own internal fetches (e.g. resolving
    // `_next/image` local sources) with a synthetic request that carries none of
    // the original request's metadata, so a per-request value would be missing
    // exactly where it is needed — the prefix would come out as "/null". The
    // stage is fixed for the life of the deployment anyway.
    const stage = process.env.API_GATEWAY_STAGE;

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
