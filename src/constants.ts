export enum NextjsType {
  GLOBAL_CONTAINERS = "GLOBAL_CONTAINERS",
  GLOBAL_FUNCTIONS = "GLOBAL_FUNCTIONS",
  REGIONAL_CONTAINERS = "REGIONAL_CONTAINERS",
  REGIONAL_FUNCTIONS = "REGIONAL_FUNCTIONS",
}

/**
 * Mount path in container for EFS. Next.js image optimization, data, and full
 * route cache will be symlinked to this location.
 *
 * Must comply with pattern: ^/mnt/[a-zA-Z0-9-_.]+$ due to lambda requirement.
 * Fargate doesn't have this same requirement but we share code for lambda and
 * fargate.
 * @see https://docs.aws.amazon.com/lambda/latest/api/API_FileSystemConfig.html
 */
export const MOUNT_PATH = "/mnt/cdk-nextjs";

export const BUILD_ID_ARG_NAME = "BUILD_ID";
export const RELATIVE_PATH_TO_PACKAGE_ARG_NAME = "RELATIVE_PATH_TO_PACKAGE";
