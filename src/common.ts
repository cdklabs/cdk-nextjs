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

// NOTE: *_ARG_NAME constants are referenced in Dockerfiles so they can be reused
export const BUILD_ID_ARG_NAME = "BUILD_ID";
export const BUILDER_IMAGE_ALIAS_ARG_NAME = "BUILDER_IMAGE_ALIAS";
export const CACHE_PATH_ARG_NAME = "CACHE_PATH";
export const DATA_CACHE_PATH_ARG_NAME = "DATA_CACHE_PATH";
export const FULL_ROUTE_CACHE_PATH_ARG_NAME = "FULL_ROUTE_CACHE_PATH";
export const IMAGE_CACHE_PATH_ARG_NAME = "IMAGE_CACHE_PATH";
export const MOUNT_PATH_ARG_NAME = "MOUNT_PATH";
export const PUBLIC_PATH_ARG_NAME = "PUBLIC_PATH";
export const RELATIVE_PATH_TO_PACKAGE_ARG_NAME = "RELATIVE_PATH_TO_PACKAGE";

export const CACHE_PATH = ".next/cache";
export const DATA_CACHE_PATH = `${CACHE_PATH}/fetch-cache`;
export const IMAGE_CACHE_PATH = `${CACHE_PATH}/images`;
export const PUBLIC_PATH = "public";
export const FULL_ROUTE_CACHE_PATH = `.next/server/app`;
export const STATIC_PATH = ".next/static";

export function getLambdaArchitecture(): Architecture {
  return process.arch === "x64" ? Architecture.X86_64 : Architecture.ARM_64;
}

/**
 * remove below for deprecated relativePathToWorkspace in 0.5.0
 */
export function handleDeprecatedProperties<
  T extends {
    relativePathToWorkspace?: string;
    relativePathToPackage?: string;
  },
>(props: T): T {
  if (props.relativePathToWorkspace) {
    console.warn(
      "WARNING: relativePathToWorkspace is deprecated and will be removed in 0.5.0. Please use relativePathToPackage",
    );
    props.relativePathToPackage = props.relativePathToWorkspace;
  }
  return props;
}
