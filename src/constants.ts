export enum NextjsType {
  GLOBAL_CONTAINERS = "GLOBAL_CONTAINERS",
  GLOBAL_FUNCTIONS = "GLOBAL_FUNCTIONS",
  REGIONAL_CONTAINERS = "REGIONAL_CONTAINERS",
  REGIONAL_FUNCTIONS = "REGIONAL_FUNCTIONS",
}

export const LOG_PREFIX = "[cdk-nextjs]";

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

/**
 * Object written at `<buildId>/.seeded` once a build's init cache has been
 * written in (`NextjsCache.cacheSeed`). While it exists the seed is never
 * written again, so a CloudFormation rollback or a re-deploy of the same build
 * can't overwrite entries the app has since regenerated or deleted.
 */
export const CACHE_SEEDED_MARKER = ".seeded";
