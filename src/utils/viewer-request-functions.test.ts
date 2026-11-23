import { Lazy } from "aws-cdk-lib";
import { FunctionEventType } from "aws-cdk-lib/aws-cloudfront";
import {
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
