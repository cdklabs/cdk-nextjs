export enum NextjsType {
  GLOBAL_CONTAINERS = "GLOBAL_CONTAINERS",
  GLOBAL_FUNCTIONS = "GLOBAL_FUNCTIONS",
  REGIONAL_CONTAINERS = "REGIONAL_CONTAINERS",
}

/**
 * Directory of [Next.js Data Cache](https://nextjs.org/docs/app/building-your-application/caching#data-cache) in EFS
 * Path: /mnt/cdk-nextjs/data-cache
 */
export const DATA_CACHE_DIR = "data-cache";
/**
 * Directory of Next.js Image Cache in EFS
 * Path: /mnt/cdk-nextjs/image-cache
 */
export const IMAGE_CACHE_DIR = "image-cache";
/**
 * Directory of [Next.js Full Route Cache](https://nextjs.org/docs/app/building-your-application/caching#full-route-cache) in EFS
 * Path: /mnt/cdk-nextjs/full-route-cache
 */
export const FULL_ROUTE_CACHE_DIR = "full-route-cache";
/**
 * Directory of Next.js [Public Folder](https://nextjs.org/docs/app/building-your-application/optimizing/static-assets) in EFS
 * Path: /mnt/cdk-nextjs/public
 */
export const PUBLIC_DIR = "public";
