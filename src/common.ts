import { Architecture } from "aws-cdk-lib/aws-lambda";

export enum NextjsType {
  GLOBAL_CONTAINERS = "GLOBAL_CONTAINERS",
  GLOBAL_FUNCTIONS = "GLOBAL_FUNCTIONS",
  REGIONAL_CONTAINERS = "REGIONAL_CONTAINERS",
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

export const CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME =
  "CDK_NEXTJS_SERVER_DIST_DIR";

// NOTE: *_ARG_NAME constants are referenced in Dockerfiles. Be sure to update
// Dockerfiles if the values are changed
export const BUILD_ID_ARG_NAME = "BUILD_ID";
export const BUILDER_IMAGE_ALIAS_ARG_NAME = "BUILDER_IMAGE_ALIAS";
export const DATA_CACHE_PATH = ".next/cache/fetch-cache";
export const FULL_ROUTE_CACHE_PATH = ".next/server/app";
export const IMAGE_CACHE_PATH = ".next/cache/images";
export const IMAGE_CACHE_PATH_ARG_NAME = "IMAGE_CACHE_PATH";
export const MOUNT_PATH_ARG_NAME = "MOUNT_PATH";
export const PUBLIC_PATH = "public";
export const PUBLIC_PATH_ARG_NAME = "PUBLIC_PATH";
export const RELATIVE_PATH_TO_WORKSPACE_ARG_NAME = "RELATIVE_PATH_TO_WORKSPACE";
export const SERVER_DIST_PATH = ".next/server";
export const SERVER_DIST_PATH_ARG_NAME = "SERVER_DIST_PATH";
export const STATIC_PATH = ".next/static";

export function getLambdaArchitecture(): Architecture {
  return process.arch === "x64" ? Architecture.X86_64 : Architecture.ARM_64;
}
