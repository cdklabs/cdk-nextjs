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
 * Top-level cache bucket prefix the init cache is uploaded under, as
 * `_seed/<buildId>/<key>`, for `NextjsCacheSeed` to copy into `<buildId>/`.
 * Never read at request time.
 */
export const CACHE_SEED_PREFIX = "_seed";

/**
 * Object written at `<buildId>/.seeded` once a build's seed has been copied in.
 * While it exists the seed is never copied again, so a CloudFormation rollback
 * or a re-deploy of the same build can't overwrite entries the app has since
 * regenerated or deleted.
 */
export const CACHE_SEEDED_MARKER = ".seeded";
