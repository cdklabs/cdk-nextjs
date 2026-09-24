import { apiGatewayRequestPath } from "./api-gateway-path";

/** The two fields as a deployed REST API reported them for the same request. */
const event = (path: string, contextPath: string) => ({
  path,
  requestContext: { path: contextPath },
});

describe("apiGatewayRequestPath", () => {
  it("keeps the stage for an app whose basePath is the stage", () => {
    expect(apiGatewayRequestPath(event("/foo", "/prod/foo"), "/prod")).toBe(
      "/prod/foo",
    );
  });

  it("reads whatever the stage is called, not a fixed name", () => {
    expect(apiGatewayRequestPath(event("/foo", "/test/foo"), "/test")).toBe(
      "/test/foo",
    );
  });

  it("serves the app's root at the bare stage URL", () => {
    // `event.path` is normalized to "/" here, which is why the prefix cannot be
    // recovered by subtracting one field from the other.
    expect(apiGatewayRequestPath(event("/", "/prod"), "/prod")).toBe("/prod");
    expect(apiGatewayRequestPath(event("/", "/prod/"), "/prod")).toBe("/prod/");
  });

  it("keeps a basePath nested below the stage", () => {
    // `basePath: "/prod/base"` with the construct's `basePath` prop "base": the
    // resources sit under /base, and only the stage is stripped.
    expect(
      apiGatewayRequestPath(event("/base/foo", "/prod/base/foo"), "/prod/base"),
    ).toBe("/prod/base/foo");
  });

  it("passes the percent-encoding through untouched", () => {
    expect(
      apiGatewayRequestPath(event("/a%20b/c", "/prod/a%20b/c"), "/prod"),
    ).toBe("/prod/a%20b/c");
  });

  it("leaves an app without a basePath on the stripped path", () => {
    expect(apiGatewayRequestPath(event("/foo", "/prod/foo"), "")).toBe("/foo");
  });

  it("leaves an app whose basePath API Gateway does not strip alone", () => {
    // A custom domain mapped at the root: nothing is stripped, so both fields
    // agree and either would do.
    expect(
      apiGatewayRequestPath(event("/docs/foo", "/docs/foo"), "/docs"),
    ).toBe("/docs/foo");
    // And a basePath that is not the stage: the stage-carrying path would 404.
    expect(apiGatewayRequestPath(event("/foo", "/prod/foo"), "/docs")).toBe(
      "/foo",
    );
  });

  it("matches the basePath on a segment boundary", () => {
    expect(
      apiGatewayRequestPath(event("/foo", "/production/foo"), "/prod"),
    ).toBe("/foo");
  });

  it("falls back to event.path when the context has no path", () => {
    expect(
      apiGatewayRequestPath({ path: "/foo", requestContext: {} }, "/prod"),
    ).toBe("/foo");
  });
});
