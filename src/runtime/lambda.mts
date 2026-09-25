/* eslint-disable import/no-extraneous-dependencies */
/**
 * The Functions shell: a Lambda response-streaming handler around the runtime
 * core.
 *
 * Reached two ways, and both event shapes are handled here rather than being
 * normalized by the constructs:
 *
 * - **Global Functions** — a Lambda Function URL behind CloudFront, so a payload
 *   v2 `LambdaFunctionURLEvent` (`rawPath`, `rawQueryString`, `cookies`).
 * - **Regional Functions** — an API Gateway REST streaming proxy integration, so
 *   an `APIGatewayProxyEvent` (`path`, `multiValueQueryStringParameters`,
 *   `httpMethod`).
 *
 * Everything past `toRuntimeRequest` is shared with the container shell. This
 * file owns exactly two things Lambda-specific: the event shape, and the
 * `awslambda.HttpResponseStream` prelude.
 */
import type { IncomingHttpHeaders } from "node:http";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { APIGatewayProxyEvent, LambdaFunctionURLEvent } from "aws-lambda";
import { apiGatewayRequestPath } from "./api-gateway-path";
import { loadRuntime, RuntimeRequest } from "./core";
import { deploymentRootOf } from "./deployment-root";
import type { ResponseHead } from "./http/response";
import type { ResponseSink } from "./http/sink";

type LambdaEvent = LambdaFunctionURLEvent | APIGatewayProxyEvent;

/**
 * Started at module load so the manifest read, the `chdir`, and the routing-table
 * construction all happen during Lambda's init phase, which gets full CPU and is
 * not billed on a provisioned-concurrency or SnapStart-less cold start the way
 * handler time is.
 */
const runtimePromise = loadRuntime(
  deploymentRootOf(dirname(fileURLToPath(import.meta.url))),
);
// Nothing awaits this until the first invocation, and an unhandled rejection
// would take the sandbox down before any request could report why.
runtimePromise.catch(() => {});

/** Only the REST API event carries `httpMethod`. */
function isApiGatewayEvent(event: LambdaEvent): event is APIGatewayProxyEvent {
  return "httpMethod" in event;
}

class LambdaResponseSink implements ResponseSink {
  /** See {@link ResponseSink.padEmptyBody}. Both integrations need it. */
  public readonly padEmptyBody = true;

  public constructor(private readonly responseStream: Writable) {}

  public begin(head: ResponseHead): Writable {
    // The prelude has to precede the first body byte, which is why
    // `ShimServerResponse` emits the head as an event instead of letting Next.js
    // write straight through.
    return awslambda.HttpResponseStream.from(this.responseStream, {
      statusCode: head.statusCode,
      headers: head.headers,
      cookies: head.cookies,
    });
  }
}

export const handler = awslambda.streamifyResponse(
  async (event: LambdaEvent, responseStream: Writable): Promise<void> => {
    const runtime = await runtimePromise;
    await runtime.handle(
      toRuntimeRequest(event, runtime.manifest.config.basePath),
      new LambdaResponseSink(responseStream),
    );
  },
);

function toRuntimeRequest(
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
  };
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
 * `multiValueHeaders` is preferred where present: the single-valued map keeps only
 * the last value, which loses repeated headers.
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
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    const key = name.toLowerCase();
    if (value !== undefined && headers[key] === undefined) {
      headers[key] = value;
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
  const multi = event.multiValueQueryStringParameters;
  if (multi) {
    for (const [name, values] of Object.entries(multi)) {
      for (const value of values ?? []) {
        search.append(name, value);
      }
    }
  } else {
    for (const [name, value] of Object.entries(
      event.queryStringParameters ?? {},
    )) {
      if (value !== undefined) {
        search.append(name, value);
      }
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}
