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
