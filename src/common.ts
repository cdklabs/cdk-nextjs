export enum NextjsType {
  GLOBAL_CONTAINERS = "GLOBAL_CONTAINERS",
  GLOBAL_FUNCTIONS = "GLOBAL_FUNCTIONS",
  REGIONAL_CONTAINERS = "REGIONAL_CONTAINERS",
}

/**
 * Directory of Next.js Data Cache in EFS
 *
 * /mnt/cdk-nextjs-cache/data-cache
 */
export const DATA_CACHE_DIR = "data-cache";
/**
 * Directory of Next.js Image Cache in EFS
 *
 * /mnt/cdk-nextjs-cache/image-cache
 */
export const IMAGE_CACHE_DIR = "image-cache";
/**
 * Directory of Next.js Full Route Cache in EFS
 *
 * /mnt/cdk-nextjs-cache/full-route-cache
 */
export const FULL_ROUTE_CACHE_DIR = "full-route-cache";
