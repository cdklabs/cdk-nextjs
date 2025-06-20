import { NextResponse, NextRequest } from 'next/server';

export default function middleware(request: NextRequest) {
  if (process.env.PREPEND_APIGW_STAGE) {
    // this is needed because we don't have API GW REST API custom domain.
    // therefore must use stage name (default: /prod). next.config.js has `basePath`
    // but it's not included in request path when API GW invokes Lambda so we
    // must add here or you'll get 404 errors.
    // see: https://github.com/awslabs/aws-lambda-web-adapter?tab=readme-ov-file#request-context
    const reqCtxStr = request.headers.get('x-amzn-request-context');
    if (reqCtxStr) {
      const reqCtx = JSON.parse(reqCtxStr);
      const stage = reqCtx.stage;
      return NextResponse.rewrite(
        new URL(`/${stage}${request.nextUrl.pathname}`, request.url),
      );
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
