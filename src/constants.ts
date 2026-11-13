export enum NextjsType {
  GLOBAL_CONTAINERS = "GLOBAL_CONTAINERS",
  GLOBAL_FUNCTIONS = "GLOBAL_FUNCTIONS",
  GLOBAL_WEB_FUNCTIONS = "GLOBAL_WEB_FUNCTIONS",
  REGIONAL_CONTAINERS = "REGIONAL_CONTAINERS",
  REGIONAL_FUNCTIONS = "REGIONAL_FUNCTIONS",
}

export const LOG_PREFIX = "[cdk-nextjs]";

/**
 * Whether `nextjsType` runs on Lambda, Global or Regional, Event Functions or
 * Web Functions: a zip on the Lambda managed runtime (Amazon Linux, glibc)
 * rather than a container image.
 */
export function isFunctionsType(nextjsType: NextjsType): boolean {
  return (
    nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
    nextjsType === NextjsType.GLOBAL_WEB_FUNCTIONS ||
    nextjsType === NextjsType.REGIONAL_FUNCTIONS
  );
}

/** Whether `nextjsType` is served through CloudFront. */
export function isGlobalType(nextjsType: NextjsType): boolean {
  return (
    nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
    nextjsType === NextjsType.GLOBAL_WEB_FUNCTIONS ||
    nextjsType === NextjsType.GLOBAL_CONTAINERS
  );
}

/**
 * Whether CloudFront reaches `nextjsType` through a SigV4-signed Lambda origin
 * (a Function URL or a Web Function endpoint), which needs the origin's own
 * domain as `Host` and so carries the viewer's in `x-forwarded-host`, and
 * rejects a body without `x-amz-content-sha256`.
 */
export function isSignedLambdaOriginType(nextjsType: NextjsType): boolean {
  return (
    nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
    nextjsType === NextjsType.GLOBAL_WEB_FUNCTIONS
  );
}
