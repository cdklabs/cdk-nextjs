import { Lazy } from "aws-cdk-lib";
import { FunctionEventType } from "aws-cdk-lib/aws-cloudfront";
import {
  assertViewerRequestUnclaimed,
  assetPrefixRewriteHandler,
  checkFunctionCodeSize,
  checkViewerRequestCode,
  FUNCTION_URL_HANDLER,
  MAX_FUNCTION_CODE_BYTES,
  PASS_THROUGH_HANDLER,
  spliceViewerRequest,
  VIEWER_REQUEST_HOOK,
  WEB_FUNCTION_HANDLER,
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
    ["Function URL", FUNCTION_URL_HANDLER],
    ["Web Function", WEB_FUNCTION_HANDLER],
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

describe("the signed-origin viewer-request handlers", () => {
  it.each([
    ["Function URL", FUNCTION_URL_HANDLER],
    ["Web Function", WEB_FUNCTION_HANDLER],
  ])(
    "the %s handler redirects repeated slashes, keeping the query",
    async (_, handler) => {
      const result = await run(handler, "/a//b\\c", { q: { value: "1" } });
      expect(result).toEqual({
        statusCode: 308,
        statusDescription: "Permanent Redirect",
        headers: { location: { value: "/a/b/c?q=1" } },
      });
    },
  );

  it("sets x-forwarded-host to the viewer's host", async () => {
    const request = await run(WEB_FUNCTION_HANDLER, "/ssr", {});
    expect(request.headers).toEqual({
      host: { value: "example.com" },
      "x-forwarded-host": { value: "example.com" },
    });
  });

  it("sends a + in a Web Function query on as %20, names and values", async () => {
    const request = await run(WEB_FUNCTION_HANDLER, "/search", {
      query: { value: "hello+world" },
      "a+b": { value: "1" },
      tag: {
        value: "x+y",
        multiValue: [{ value: "x+y" }, { value: "z" }],
      },
      plain: { value: "a%2Bb" },
      empty: { value: "" },
    });
    expect(request.querystring).toEqual({
      query: { value: "hello%20world" },
      "a%20b": { value: "1" },
      tag: {
        value: "x%20y",
        multiValue: [{ value: "x%20y" }, { value: "z" }],
      },
      plain: { value: "a%2Bb" },
      empty: { value: "" },
    });
  });

  it("merges a name that becomes one already there", async () => {
    const request = await run(WEB_FUNCTION_HANDLER, "/search", {
      "a%20b": { value: "1" },
      "a+b": { value: "2" },
    });
    expect(request.querystring).toEqual({
      "a%20b": {
        value: "1",
        multiValue: [{ value: "1" }, { value: "2" }],
      },
    });
  });

  it("leaves + alone on a Function URL origin", async () => {
    const request = await run(FUNCTION_URL_HANDLER, "/search", {
      query: { value: "hello+world" },
    });
    expect(request.querystring).toEqual({ query: { value: "hello+world" } });
  });
});
