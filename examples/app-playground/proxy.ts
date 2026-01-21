import { NextResponse, NextRequest } from 'next/server';

export default function proxy(request: NextRequest) {
  console.log(
    '[MIDDLEWARE] pathname:',
    request.nextUrl.pathname,
    'search:',
    request.nextUrl.search,
  );

  if (process.env.PREPEND_APIGW_STAGE) {
    // Skip rewriting Next.js internal routes (_next/*)
    if (request.nextUrl.pathname.startsWith('/_next/')) {
      console.log('[MIDDLEWARE] Skipping _next path');
      return NextResponse.next();
    }
    // this is needed because we don't have API GW REST API custom domain.
    // therefore must use stage name (default: /prod). next.config.js has `basePath`
    // but it's not included in request path when API GW invokes Lambda so we
    // must add here or you'll get 404 errors.
    // see: https://github.com/awslabs/aws-lambda-web-adapter?tab=readme-ov-file#request-context
    const reqCtxStr = request.headers.get('x-amzn-request-context');
    if (reqCtxStr) {
      const reqCtx = JSON.parse(reqCtxStr);
      const stage = reqCtx.stage;
      const url = new URL(request.url);
      const oldPathname = url.pathname;
      url.pathname = `/${stage}${url.pathname}`;
      console.log(
        '[MIDDLEWARE] Rewriting:',
        oldPathname,
        '->',
        url.pathname,
        'search:',
        url.search,
      );
      return NextResponse.rewrite(url);
    }
  }
  const response = NextResponse.next();
  if (process.env.VERBOSE) {
    console.log({
      requestUrl: request.url,
      requestHeaders: JSON.stringify(getHeaders(request.headers), null, 2),
      responseHeaders: JSON.stringify(getHeaders(response.headers), null, 2),
      status: response.status,
      statusText: response.statusText,
      body: response.body,
    });
  }
  return response;
}

function getHeaders(headers: Headers) {
  const headersObj: Record<string, string> = {};
  headers.forEach((value, key) => {
    headersObj[key] = value;
  });
  return headersObj;
}
