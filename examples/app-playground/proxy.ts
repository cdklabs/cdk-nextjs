import { NextResponse, NextRequest } from 'next/server';
import getDebug from 'debug';

const debug = getDebug('cdk-nextjs:proxy');

export default function proxy(request: NextRequest) {
  // debug('request.url:', request.url);
  if (process.env.PREPEND_APIGW_STAGE) {
    // API Gateway strips the stage name from the path when invoking Lambda.
    // We need to prepend it back so Next.js basePath works correctly.
    // See: https://github.com/awslabs/aws-lambda-web-adapter?tab=readme-ov-file#request-context
    const reqCtxStr = request.headers.get('x-amzn-request-context');

    if (reqCtxStr) {
      const reqCtx = JSON.parse(reqCtxStr);
      const stage = reqCtx.stage;

      // Next.js internally re-enters this middleware for its own local
      // fetches (e.g. resolving `_next/image` sources), using a mocked
      // request with no `x-amzn-request-context` header carried over from
      // the original call chain in some cases, and without a real API
      // Gateway invocation context at all in others. Without this guard,
      // `stage` is `undefined`/`null` there and the rewrite below produces
      // a literal "/null" or "/undefined" path prefix instead of skipping.
      if (!stage) {
        return NextResponse.next();
      }

      const url = new URL(request.url);
      const originalPath = url.pathname;

      // Skip rewriting if path already starts with stage name
      // This prevents double-rewriting when Next.js internally fetches static files
      if (originalPath.startsWith(`/${stage}`)) {
        return NextResponse.next();
      }

      url.pathname = `/${stage}${url.pathname}`;
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
