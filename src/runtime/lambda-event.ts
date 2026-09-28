/* eslint-disable import/no-extraneous-dependencies */
/**
 * Lambda event → {@link RuntimeRequest}, for both event shapes the Functions
 * shell (`lambda.mts`) is reached with. Its own module so it can be tested:
 * `lambda.mts` starts loading the runtime, and needs the `awslambda` global, the
 * moment it is imported.
 */
import type { IncomingHttpHeaders } from "node:http";
import type { APIGatewayProxyEvent, LambdaFunctionURLEvent } from "aws-lambda";
import { apiGatewayRequestPath } from "./api-gateway-path";
import type { RuntimeRequest } from "./core";

export type LambdaEvent = LambdaFunctionURLEvent | APIGatewayProxyEvent;

/** Only the REST API event carries `httpMethod`. */
function isApiGatewayEvent(event: LambdaEvent): event is APIGatewayProxyEvent {
  return "httpMethod" in event;
}

export function toRuntimeRequest(
  event: LambdaEvent,
  basePath: string,
): RuntimeRequest {
  const body = decodeBody(event.body, event.isBase64Encoded);
  if (isApiGatewayEvent(event)) {
    return {
      method: event.httpMethod,
      // With the stage API Gateway stripped put back, but only for an app whose
      // `basePath` expects it; see `apiGatewayRequestPath`.
      url: apiGatewayRequestPath(event, basePath) + formatQuery(event),
      headers: restHeaders(event),
      body,
      remoteAddress: event.requestContext.identity?.sourceIp,
    };
  }
  const { http } = event.requestContext;
  return {
    method: http.method,
    // Raw, still percent-encoded, which is what Next.js's own normalization
    // expects.
    url:
      event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : ""),
    headers: functionUrlHeaders(event),
    body,
    remoteAddress: http.sourceIp,
    // Trusted for any IAM-authorized invoker: in practice CloudFront's Origin
    // Access Control, whose viewer-request function overwrites
    // `x-forwarded-host` with the viewer's `Host` (see
    // `RuntimeRequest.trustForwardedHost`; `NextjsDistribution` refuses an
    // override that would replace that function,
    // `withDynamicFunctionAssociations`), plus principals granted
    // `lambda:InvokeFunctionUrl`, which are already trusted with the function.
    // Gated on the signature Lambda verified, not assumed: a URL overridden to
    // `authType: NONE` can be called by anyone, with any header.
    trustForwardedHost: isIamAuthenticated(event),
  };
}

/**
 * Lambda sets `authorizer.iam` only for a request it verified the SigV4 of — by
 * any principal allowed to invoke the URL, not only CloudFront.
 */
function isIamAuthenticated(event: LambdaFunctionURLEvent): boolean {
  const { authorizer } = event.requestContext as {
    authorizer?: { iam?: unknown };
  };
  return authorizer?.iam !== undefined;
}

function decodeBody(
  body: string | null | undefined,
  isBase64Encoded: boolean,
): Buffer | undefined {
  if (body === null || body === undefined) {
    return undefined;
  }
  return Buffer.from(body, isBase64Encoded ? "base64" : "utf-8");
}

/**
 * Payload v2 lifts cookies out of the headers into their own array, so they have
 * to be put back — Next.js reads `req.headers.cookie` for draft mode, the
 * prerender bypass, and anything a route handler does with `cookies()`.
 */
function functionUrlHeaders(
  event: LambdaFunctionURLEvent,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) {
      headers[name.toLowerCase()] = value;
    }
  }
  if (event.cookies?.length) {
    headers.cookie = event.cookies.join("; ");
  }
  return headers;
}

/**
 * `multiValueHeaders` only: API Gateway always sends it, as a superset of the
 * single-valued map, which keeps only the last value of a repeated header.
 *
 * `cookie` is rejoined with `"; "` rather than the `", "` every other header uses,
 * because that is the separator the field's own grammar uses (RFC 6265) and what
 * every cookie parser splits on. Joining two `Cookie` fields with a comma produced
 * `cookie: "a=1, b=2"`, which parses as the single cookie `a = "1, b=2"` — every
 * cookie after the first is lost, including `__prerender_bypass` and
 * `__next_preview_data`, so draft mode silently stopped working.
 */
function restHeaders(event: APIGatewayProxyEvent): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    if (values?.length) {
      const key = name.toLowerCase();
      headers[key] =
        values.length === 1
          ? values[0]
          : values.join(key === "cookie" ? "; " : ", ");
    }
  }
  return headers;
}

/**
 * Rebuilds the query string API Gateway already parsed (and decoded) for us.
 * Re-encoding is required, not cosmetic: `?q=a%20b` arrives as `a b`, and passing
 * that through unescaped produces a URL that `new URL()` mangles.
 */
function formatQuery(event: APIGatewayProxyEvent): string {
  const search = new URLSearchParams();
  for (const [name, values] of Object.entries(
    event.multiValueQueryStringParameters ?? {},
  )) {
    for (const value of values ?? []) {
      search.append(name, value);
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}
