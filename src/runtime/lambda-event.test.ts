/* eslint-disable import/no-extraneous-dependencies */
import type { APIGatewayProxyEvent, LambdaFunctionURLEvent } from "aws-lambda";
import { toRuntimeRequest } from "./lambda-event";

/** Only the fields `toRuntimeRequest` reads; the rest of the shape is noise. */
function functionUrlEvent(
  fields: Partial<LambdaFunctionURLEvent> = {},
): LambdaFunctionURLEvent {
  return {
    rawPath: "/",
    rawQueryString: "",
    headers: { host: "abc.lambda-url.us-east-1.on.aws" },
    isBase64Encoded: false,
    requestContext: {
      http: { method: "GET", sourceIp: "203.0.113.7" },
      // CloudFront's Origin Access Control signature, as Lambda reports it.
      authorizer: { iam: { callerId: "cloudfront" } },
    },
    ...fields,
  } as unknown as LambdaFunctionURLEvent;
}

function restEvent(
  fields: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: "GET",
    path: "/",
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    requestContext: { path: "/prod/", identity: { sourceIp: "203.0.113.8" } },
    ...fields,
  } as unknown as APIGatewayProxyEvent;
}

describe("toRuntimeRequest, for a Function URL event", () => {
  it("rebuilds the target from rawPath and rawQueryString, still encoded", () => {
    const request = toRuntimeRequest(
      functionUrlEvent({ rawPath: "/a%20b", rawQueryString: "q=a%20b&x=1" }),
      "",
    );
    expect(request).toMatchObject({
      method: "GET",
      url: "/a%20b?q=a%20b&x=1",
      remoteAddress: "203.0.113.7",
    });
  });

  it("puts the cookies payload v2 lifted out back into one cookie header", () => {
    // Joined with "; ", the separator the Cookie grammar uses. ", " would parse
    // as the single cookie `a = "1, b=2"`, losing draft mode's cookies.
    const request = toRuntimeRequest(
      functionUrlEvent({
        cookies: ["a=1", "__prerender_bypass=x", "__next_preview_data=y"],
      }),
      "",
    );
    expect(request.headers.cookie).toBe(
      "a=1; __prerender_bypass=x; __next_preview_data=y",
    );
  });

  it("lowercases header names", () => {
    const request = toRuntimeRequest(
      functionUrlEvent({ headers: { "X-Forwarded-Host": "shop.test" } }),
      "",
    );
    expect(request.headers["x-forwarded-host"]).toBe("shop.test");
  });

  // Only CloudFront can invoke the URL, and it overwrites the header.
  it("trusts x-forwarded-host", () => {
    expect(toRuntimeRequest(functionUrlEvent(), "").trustForwardedHost).toBe(
      true,
    );
  });

  // A URL overridden to `authType: NONE` takes the header from anyone.
  it("does not trust x-forwarded-host on a request Lambda did not authenticate", () => {
    const request = toRuntimeRequest(
      functionUrlEvent({
        requestContext: {
          http: { method: "GET", sourceIp: "203.0.113.7" },
        } as LambdaFunctionURLEvent["requestContext"],
      }),
      "",
    );
    expect(request.trustForwardedHost).toBe(false);
  });

  it("decodes a base64 body, and leaves an absent one absent", () => {
    const encoded = toRuntimeRequest(
      functionUrlEvent({
        body: Buffer.from("héllo").toString("base64"),
        isBase64Encoded: true,
      }),
      "",
    );
    expect((encoded.body as Buffer).toString("utf-8")).toBe("héllo");
    expect(toRuntimeRequest(functionUrlEvent(), "").body).toBeUndefined();
  });
});

describe("toRuntimeRequest, for an API Gateway REST event", () => {
  // API Gateway sets `Host` to its own domain; the header is the client's.
  it("does not trust x-forwarded-host", () => {
    expect(
      toRuntimeRequest(restEvent({}), "").trustForwardedHost,
    ).toBeUndefined();
  });

  it("rejoins repeated Cookie fields with '; ', not ', '", () => {
    const request = toRuntimeRequest(
      restEvent({
        multiValueHeaders: {
          Cookie: ["a=1", "__prerender_bypass=x"],
          Accept: ["text/html", "application/json"],
        },
      }),
      "",
    );
    expect(request.headers.cookie).toBe("a=1; __prerender_bypass=x");
    // Every other repeated header is a comma-separated list.
    expect(request.headers.accept).toBe("text/html, application/json");
  });

  it("prefers multiValueHeaders, filling in from headers", () => {
    const request = toRuntimeRequest(
      restEvent({
        headers: { Host: "api.test", "X-Only-Single": "1", Cookie: "last=1" },
        multiValueHeaders: { Cookie: ["a=1", "b=2"] },
      }),
      "",
    );
    expect(request.headers).toMatchObject({
      cookie: "a=1; b=2",
      host: "api.test",
      "x-only-single": "1",
    });
  });

  it("re-encodes the query API Gateway decoded, keeping repeated keys", () => {
    const request = toRuntimeRequest(
      restEvent({
        path: "/search",
        requestContext: { path: "/prod/search" } as never,
        multiValueQueryStringParameters: { q: ["a b"], tag: ["x", "y"] },
        queryStringParameters: { q: "a b", tag: "y" },
      }),
      "",
    );
    expect(request.url).toBe("/search?q=a+b&tag=x&tag=y");
  });

  it("puts the stage back for an app whose basePath is the stage", () => {
    const request = toRuntimeRequest(
      restEvent({
        path: "/blog",
        requestContext: { path: "/prod/blog" } as never,
      }),
      "/prod",
    );
    expect(request.url).toBe("/prod/blog");
  });
});
