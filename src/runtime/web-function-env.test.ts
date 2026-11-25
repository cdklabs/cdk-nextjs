import {
  ENDPOINT_NAME_HEADER,
  isTrustedEndpoint,
  listenAddress,
} from "./web-function-env";

describe("listenAddress", () => {
  it("binds exactly the host:port Lambda sets", () => {
    expect(listenAddress("169.254.100.1:8080")).toEqual({
      host: "169.254.100.1",
      port: 8080,
    });
  });

  it("unbrackets an IPv6 host", () => {
    expect(listenAddress("[::]:9000")).toEqual({ host: "::", port: 9000 });
  });

  // Outside a Web Function, or a format Lambda changed: fail at start, where
  // the log says why, rather than listening where nothing is forwarded.
  it.each([undefined, "", "8080", ":8080", "host:", "host:http", "host:-1"])(
    "throws on %p",
    (value) => {
      expect(() => listenAddress(value)).toThrow(/AWS_LAMBDA_HTTP_ENDPOINT/);
    },
  );
});

describe("isTrustedEndpoint", () => {
  it("trusts requests through the IAM-authorized endpoint", () => {
    expect(isTrustedEndpoint({ [ENDPOINT_NAME_HEADER]: "prod" }, "prod")).toBe(
      true,
    );
  });

  // An endpoint a user added with `addEndpoint`, which may be public.
  it("doesn't trust requests through any other endpoint", () => {
    expect(
      isTrustedEndpoint({ [ENDPOINT_NAME_HEADER]: "public" }, "prod"),
    ).toBe(false);
  });

  it("doesn't trust a request without the header", () => {
    expect(isTrustedEndpoint({}, "prod")).toBe(false);
  });

  // Fails closed when the construct didn't say which endpoint to trust.
  it("trusts nothing without a configured endpoint", () => {
    expect(isTrustedEndpoint({ [ENDPOINT_NAME_HEADER]: "prod" }, "")).toBe(
      false,
    );
    expect(
      isTrustedEndpoint({ [ENDPOINT_NAME_HEADER]: "prod" }, undefined),
    ).toBe(false);
  });

  // Duplicated headers arrive joined or as an array; neither is Lambda's.
  it("doesn't trust a repeated header", () => {
    expect(
      isTrustedEndpoint({ [ENDPOINT_NAME_HEADER]: ["prod", "prod"] }, "prod"),
    ).toBe(false);
  });
});
