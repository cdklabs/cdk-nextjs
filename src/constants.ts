import { Runtime, RuntimeFamily } from "aws-cdk-lib/aws-lambda";

export enum NextjsType {
  GLOBAL_CONTAINERS = "GLOBAL_CONTAINERS",
  GLOBAL_FUNCTIONS = "GLOBAL_FUNCTIONS",
  REGIONAL_CONTAINERS = "REGIONAL_CONTAINERS",
  REGIONAL_FUNCTIONS = "REGIONAL_FUNCTIONS",
}

export const LOG_PREFIX = "[cdk-nextjs]";

/**
 * The Lambda runtime of every function cdk-nextjs creates. Keep its major in
 * step with `nodeVersion` in `.projenrc.ts` (the generated custom-resource
 * functions and the runtime bundles' esbuild target) and the `node:<major>-alpine`
 * base of the generated Dockerfiles. A string rather than `Runtime.NODEJS_26_X`
 * so the `aws-cdk-lib` peer floor doesn't have to rise with it.
 */
export const LAMBDA_RUNTIME = new Runtime("nodejs26.x", RuntimeFamily.NODEJS);

/** Whether `nextjsType` runs on Lambda, Global or Regional. */
export function isFunctionsType(nextjsType: NextjsType): boolean {
  return (
    nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
    nextjsType === NextjsType.REGIONAL_FUNCTIONS
  );
}

/** Whether `nextjsType` is served through CloudFront. */
export function isGlobalType(nextjsType: NextjsType): boolean {
  return (
    nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
    nextjsType === NextjsType.GLOBAL_CONTAINERS
  );
}
