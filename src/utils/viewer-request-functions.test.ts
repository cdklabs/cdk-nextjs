import { Lazy } from "aws-cdk-lib";
import {
  FunctionEventType,
  LambdaEdgeEventType,
} from "aws-cdk-lib/aws-cloudfront";
import {
  BehaviorCloudFrontFunction,
  assertViewerEdgeLambdasClear,
  assertViewerRequestUnclaimed,
  assetPrefixRewriteHandler,
  checkFunctionCodeSize,
  checkViewerRequestCode,
  MAX_FUNCTION_CODE_BYTES,
  PASS_THROUGH_HANDLER,
  spliceViewerRequest,
  VIEWER_REQUEST_HOOK,
  X_FORWARDED_HOST_HANDLER,
} from "./viewer-request-functions";

type QueryString = Record<
  string,
  { value: string; multiValue?: { value: string }[] }
>;

/** Runs a deployed handler on a viewer-request event, as CloudFront would. */
async function run(handler: string, uri: string, querystring: QueryString) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    `${spliceViewerRequest(handler, undefined)}\nreturn handler;`,
  )() as (event: unknown) => Promise<Record<string, unknown>>;
  return fn({
    request: {
      uri,
      querystring,
      headers: { host: { value: "example.com" } },
    },
  });
}

describe("spliceViewerRequest", () => {
  it.each([
    ["x-forwarded-host", X_FORWARDED_HOST_HANDLER],
    ["pass-through", PASS_THROUGH_HANDLER],
    ["assetPrefix rewrite", assetPrefixRewriteHandler("base", "/cdn")],
  ])("drops the marker and indentation from the %s handler", (_, handler) => {
    const code = spliceViewerRequest(handler, undefined);
    expect(code).not.toContain(VIEWER_REQUEST_HOOK);
    expect(code).not.toMatch(/^[ \t]/m);
    expect(code).toMatch(/^async function handler\(event\) \{$/m);
  });

  it("puts the user's code first and awaits viewerRequest at the marker", () => {
    const code = spliceViewerRequest(
      PASS_THROUGH_HANDLER,
      'import cf from "cloudfront";\nfunction viewerRequest(event) {}',
    );
    expect(code.startsWith('import cf from "cloudfront";')).toBe(true);
    expect(code).toMatch(
      /async function handler\(event\) \{\nconst viewerResult = await viewerRequest\(event\);/,
    );
  });
});

describe("assetPrefixRewriteHandler", () => {
  it("swaps the prefix for the basePath", () => {
    expect(assetPrefixRewriteHandler("base", "/cdn")).toContain(
      'request.uri = "/base" + request.uri.slice(4);',
    );
    expect(assetPrefixRewriteHandler("", "/cdn")).toContain(
      'request.uri = "" + request.uri.slice(4);',
    );
  });
});

describe("checkViewerRequestCode", () => {
  it.each([
    "function viewerRequest(event) {}",
    "async function viewerRequest(event) {}",
    "const viewerRequest = (event) => {};",
    "var x = 1, viewerRequest = (event) => {};",
  ])("accepts %s", (code) => {
    expect(() => checkViewerRequestCode(code)).not.toThrow();
  });

  it("refuses code that never defines viewerRequest", () => {
    expect(() =>
      checkViewerRequestCode("const ok = viewerRequest === 1;"),
    ).toThrow(/must define `viewerRequest\(event\)`/);
  });

  it("refuses code that uses the name handler", () => {
    expect(() =>
      checkViewerRequestCode("function viewerRequest(event) {} // handler"),
    ).toThrow(/uses the name `handler`/);
  });
});

describe("checkFunctionCodeSize", () => {
  it("allows code up to the limit, counted in UTF-8 bytes", () => {
    expect(checkFunctionCodeSize("a".repeat(MAX_FUNCTION_CODE_BYTES))).toBe(
      undefined,
    );
    // Two bytes each: half as many characters reach the limit.
    expect(() =>
      checkFunctionCodeSize("ä".repeat(MAX_FUNCTION_CODE_BYTES / 2 + 1)),
    ).toThrow(
      `makes a CloudFront Function of ${MAX_FUNCTION_CODE_BYTES + 2} bytes`,
    );
  });

  it("reports a token rather than measuring its placeholder", () => {
    const code = `${"a".repeat(MAX_FUNCTION_CODE_BYTES)}${Lazy.string({
      produce: () => "",
    })}`;
    expect(checkFunctionCodeSize(code)).toBe("unresolved");
  });
});

describe("assertViewerRequestUnclaimed", () => {
  it("allows no associations, or ones on other event types", () => {
    expect(() =>
      assertViewerRequestUnclaimed("staticBehaviorOptions", undefined, "x"),
    ).not.toThrow();
    expect(() =>
      assertViewerRequestUnclaimed(
        "staticBehaviorOptions",
        [{ eventType: FunctionEventType.VIEWER_RESPONSE }],
        "x",
      ),
    ).not.toThrow();
  });

  it("names the override and what needs the event type", () => {
    expect(() =>
      assertViewerRequestUnclaimed(
        "imageBehaviorOptions",
        [{ eventType: FunctionEventType.VIEWER_REQUEST }],
        "something needs it",
      ),
    ).toThrow(
      "`overrides.imageBehaviorOptions.functionAssociations` associates a " +
        "CloudFront function with viewer-request, but something needs it. ",
    );
  });
});

describe("X_FORWARDED_HOST_HANDLER", () => {
  it("redirects repeated slashes, keeping the query", async () => {
    const result = await run(X_FORWARDED_HOST_HANDLER, "/a//b\\c", {
      q: { value: "1" },
    });
    expect(result).toEqual({
      statusCode: 308,
      statusDescription: "Permanent Redirect",
      headers: { location: { value: "/a/b/c?q=1" } },
    });
  });

  it("sets x-forwarded-host to the viewer's host", async () => {
    const request = await run(X_FORWARDED_HOST_HANDLER, "/ssr", {});
    expect(request.headers).toEqual({
      host: { value: "example.com" },
      "x-forwarded-host": { value: "example.com" },
    });
  });

  it("leaves a + in the query as sent", async () => {
    const request = await run(X_FORWARDED_HOST_HANDLER, "/search", {
      query: { value: "hello+world" },
      "a+b": { value: "1" },
    });
    expect(request.querystring).toEqual({
      query: { value: "hello+world" },
      "a+b": { value: "1" },
    });
  });
});

describe("assertViewerEdgeLambdasClear", () => {
  const ours = [
    { eventType: FunctionEventType.VIEWER_REQUEST, owner: "our function" },
  ];

  it("allows no edge lambdas, or ones on origin events", () => {
    expect(() =>
      assertViewerEdgeLambdasClear("dynamicBehaviorOptions", undefined, ours),
    ).not.toThrow();
    expect(() =>
      assertViewerEdgeLambdasClear(
        "dynamicBehaviorOptions",
        [
          { eventType: LambdaEdgeEventType.ORIGIN_REQUEST },
          { eventType: LambdaEdgeEventType.ORIGIN_RESPONSE },
        ],
        ours,
      ),
    ).not.toThrow();
  });

  it("allows a viewer edge lambda with no viewer CloudFront Function", () => {
    expect(() =>
      assertViewerEdgeLambdasClear(
        "staticBehaviorOptions",
        [{ eventType: LambdaEdgeEventType.VIEWER_REQUEST }],
        [],
      ),
    ).not.toThrow();
  });

  it("names the override field, both event types and the function's owner", () => {
    expect(() =>
      assertViewerEdgeLambdasClear(
        "imageBehaviorOptions",
        [{ eventType: LambdaEdgeEventType.VIEWER_RESPONSE }],
        ours,
      ),
    ).toThrow(
      "`overrides.imageBehaviorOptions.edgeLambdas` associates a Lambda@Edge " +
        "function with viewer-response, but the same behavior has " +
        "viewer-event CloudFront Functions: our function (viewer-request). ",
    );
  });

  it("names every viewer-event function on both sides", () => {
    expect(() =>
      assertViewerEdgeLambdasClear(
        "dynamicBehaviorOptions",
        [
          { eventType: LambdaEdgeEventType.VIEWER_REQUEST },
          { eventType: LambdaEdgeEventType.ORIGIN_REQUEST },
          { eventType: LambdaEdgeEventType.VIEWER_RESPONSE },
        ],
        [
          ...ours,
          { eventType: FunctionEventType.VIEWER_RESPONSE, owner: "theirs" },
        ],
      ),
    ).toThrow(
      "with viewer-request and viewer-response, but the same behavior has " +
        "viewer-event CloudFront Functions: our function (viewer-request); " +
        "theirs (viewer-response). ",
    );
  });

  const remedyOf = (
    edgeEventType: LambdaEdgeEventType,
    functions: BehaviorCloudFrontFunction[] = ours,
  ) => {
    try {
      assertViewerEdgeLambdasClear(
        "dynamicBehaviorOptions",
        [{ eventType: edgeEventType }],
        functions,
      );
    } catch (error) {
      return (error as Error).message.replace(/^.* Use /s, "Use ");
    }
    throw new Error("expected a refusal");
  };
  const ORIGIN_EVENT =
    "Use an origin-request or origin-response Lambda@Edge function, which " +
    "can sit beside viewer CloudFront Functions";
  const CODE =
    "`viewerRequestFunctionCode`, which runs inside cdk-nextjs's own " +
    "viewer-request functions, for the Lambda@Edge function's logic";
  const VIEWER_RESPONSE_FUNCTION =
    "a viewer-response CloudFront Function in " +
    "`overrides.dynamicBehaviorOptions.functionAssociations`, which runs on " +
    "cache hits too";

  it("suggests viewerRequestFunctionCode for a viewer-request Lambda@Edge", () => {
    expect(remedyOf(LambdaEdgeEventType.VIEWER_REQUEST)).toContain(
      `${ORIGIN_EVENT}, or ${CODE}. See `,
    );
  });

  it("doesn't suggest viewerRequestFunctionCode where the override holds viewer-request", () => {
    expect(
      remedyOf(LambdaEdgeEventType.VIEWER_REQUEST, [
        {
          eventType: FunctionEventType.VIEWER_REQUEST,
          owner: "theirs",
          fromOverride: true,
        },
      ]),
    ).toContain(`${ORIGIN_EVENT}. See `);
  });

  it("suggests a viewer-response CloudFront Function for a viewer-response Lambda@Edge", () => {
    expect(remedyOf(LambdaEdgeEventType.VIEWER_RESPONSE)).toContain(
      `${ORIGIN_EVENT}, or ${VIEWER_RESPONSE_FUNCTION}. See `,
    );
  });

  it("doesn't suggest a viewer-response CloudFront Function where one is already there", () => {
    expect(
      remedyOf(LambdaEdgeEventType.VIEWER_RESPONSE, [
        {
          eventType: FunctionEventType.VIEWER_RESPONSE,
          owner: "theirs",
          fromOverride: true,
        },
      ]),
    ).toContain(`${ORIGIN_EVENT}. See `);
  });
});
