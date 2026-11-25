/**
 * What the Web Functions shell (`web-function.mts`) reads off its environment
 * and its requests. Its own module so it can be tested: the shell starts a
 * server the moment it is imported.
 */
import type { IncomingHttpHeaders } from "node:http";

/**
 * The environment variable naming the Web Function endpoint whose requests
 * Lambda has SigV4-verified: the IAM-authorized default endpoint CloudFront's
 * Origin Access Control signs for. Set by `NextjsWebFunctions`; unset, no
 * request is trusted.
 */
export const TRUSTED_ENDPOINT_ENV_VAR = "CDK_NEXTJS_TRUSTED_ENDPOINT_NAME";

/**
 * Set by Lambda on every request to the name of the endpoint it came through.
 * Lambda drops any `lambda-web-*` header a client sends, so this one is
 * Lambda's own.
 * @see https://docs.aws.amazon.com/lambda/latest/dg/web-functions-http.html
 */
export const ENDPOINT_NAME_HEADER = "lambda-web-endpoint-name";

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * The address in `AWS_LAMBDA_HTTP_ENDPOINT`, `host:port`, which the server
 * must bind exactly: Lambda forwards requests to that address, and a server
 * that is not listening there within 10 seconds of starting fails the
 * environment (`Application.TimeoutListenError`).
 * @see https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions-env-vars.html
 */
export function listenAddress(value: string | undefined): ListenAddress {
  const separator = value?.lastIndexOf(":") ?? -1;
  const port = Number(value?.slice(separator + 1));
  if (!value || separator <= 0 || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `cdk-nextjs: AWS_LAMBDA_HTTP_ENDPOINT is ${JSON.stringify(value)}, ` +
        "not the host:port Lambda Web Functions set. This shell only runs as " +
        "a Web Function.",
    );
  }
  // An IPv6 host comes bracketed, which `server.listen` doesn't take.
  const host = value.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
  return { host, port };
}

/**
 * Whether the request came through `trustedEndpoint`, an IAM-authorized
 * endpoint: the Web Functions counterpart of the Function URL's
 * `requestContext.authorizer.iam` (see `RuntimeRequest.trustForwardedHost`).
 *
 * Lambda verified the SigV4 of every request on that endpoint, which in
 * practice is CloudFront's Origin Access Control, and CloudFront's
 * viewer-request function overwrote `x-forwarded-host` with the viewer's
 * `Host`. Any other endpoint — one a user added with `addEndpoint`, possibly
 * `APPLICATION_MANAGED` — passes `x-forwarded-host` through from the client
 * unchecked, so it is not trusted.
 */
export function isTrustedEndpoint(
  headers: IncomingHttpHeaders,
  trustedEndpoint: string | undefined,
): boolean {
  if (!trustedEndpoint) {
    return false;
  }
  return headers[ENDPOINT_NAME_HEADER] === trustedEndpoint;
}
