/**
 * Which of the four root constructs is serving this run.
 *
 * Most of what these tests assert is identical on all four. A handful of things
 * are not, because the plumbing in front of the app is genuinely different
 * hardware: CloudFront with a signed Lambda Function URL, API Gateway REST with a
 * streaming Lambda integration, an ALB with Fargate, CloudFront with Fargate. A
 * test that skips on the awkward types proves nothing about them; these helpers
 * exist so a test can assert the *divergence* instead.
 *
 * `E2E_NEXTJS_TYPE` is set by `.github/actions/run-e2e-tests-on-example` from the
 * example directory it deployed. For a hand-deployed run there is a fallback that
 * reads the URL, so `E2E_BASE_URL=... pnpm test` gates correctly with no extra
 * setup.
 */
export type DeploymentType =
  | "global-functions"
  | "global-containers"
  | "regional-containers"
  | "regional-functions";

const DEPLOYMENT_TYPES: readonly DeploymentType[] = [
  "global-functions",
  "global-containers",
  "regional-containers",
  "regional-functions",
];

function fromEnv(): DeploymentType | undefined {
  const value = process.env["E2E_NEXTJS_TYPE"];
  return DEPLOYMENT_TYPES.find((type) => type === value);
}

/**
 * Only distinguishes the two types whose *host* gives them away. An ALB and a
 * CloudFront-fronted container both answer on a plain hostname, so this cannot
 * tell `regional-containers` from `global-containers` - which is why
 * `E2E_NEXTJS_TYPE` is what CI sets, and this is only a convenience.
 */
function fromBaseUrl(baseUrl: string | undefined): DeploymentType | undefined {
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  // `<api-id>.execute-api.<region>.amazonaws.com` - only NextjsRegionalFunctions
  // puts an API Gateway in front of the app.
  if (host.includes(".execute-api.")) return "regional-functions";
  // A CloudFront distribution could be either Global construct. Guessing the
  // Functions one is the useful default: it is the only type with the
  // viewer-request function and the signed Function URL, so a wrong guess makes a
  // test assert *more* than it should and fail loudly rather than silently pass.
  if (host.endsWith(".cloudfront.net")) return "global-functions";
  return undefined;
}

export function getDeploymentType(
  baseUrl = process.env["E2E_BASE_URL"],
): DeploymentType | undefined {
  return fromEnv() ?? fromBaseUrl(baseUrl);
}

/** `NextjsRegionalFunctions`: API Gateway REST in front of a streaming Lambda. */
export function isApiGateway(baseUrl?: string): boolean {
  return getDeploymentType(baseUrl) === "regional-functions";
}

/** `NextjsGlobalFunctions`: CloudFront in front of a signed Lambda Function URL. */
export function isGlobalFunctions(baseUrl?: string): boolean {
  return getDeploymentType(baseUrl) === "global-functions";
}

/** Either Global construct - i.e. there is a CloudFront distribution in front. */
export function isCdn(baseUrl?: string): boolean {
  const type = getDeploymentType(baseUrl);
  return type === "global-functions" || type === "global-containers";
}

/** Fargate rather than Lambda, so no response-stream prelude and no 6 MB cap. */
export function isContainers(baseUrl?: string): boolean {
  const type = getDeploymentType(baseUrl);
  return type === "global-containers" || type === "regional-containers";
}

/**
 * `pnpm dev` serves everything per request with no cache and no AWS in front, so
 * every per-type assertion here is meaningless against it.
 */
export function isLocal(baseUrl = process.env["E2E_BASE_URL"]): boolean {
  return baseUrl?.includes("localhost") === true;
}
