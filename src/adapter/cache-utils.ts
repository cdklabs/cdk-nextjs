/*
  Shared cache utility functions
*/
import type {
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";

/**
 * Pre-process value to convert Buffers and Maps before JSON.stringify
 * This is necessary because Buffer.toJSON() is called before replacer functions
 */
function preprocessValue(value: any): any {
  // Handle null/undefined
  if (value == null) {
    return value;
  }

  // Convert Buffer to our custom format
  if (Buffer.isBuffer(value)) {
    return {
      __type: "Buffer",
      data: Array.from(value),
    };
  }

  // Convert Map to our custom format
  if (value instanceof Map) {
    const entries: Record<string, any> = {};
    for (const [key, val] of value.entries()) {
      entries[key] = preprocessValue(val);
    }
    return {
      __type: "Map",
      data: entries,
    };
  }

  // Recursively process arrays
  if (Array.isArray(value)) {
    return value.map((item) => preprocessValue(item));
  }

  // Recursively process objects
  if (typeof value === "object") {
    const processed: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      processed[key] = preprocessValue(val);
    }
    return processed;
  }

  // Return primitives as-is
  return value;
}

/**
 * Serialize cache value with custom handling for Map and Buffer objects
 */
export function serializeCacheValue(value: any): string {
  // Pre-process to convert Buffers and Maps before JSON.stringify
  // This ensures Buffer.toJSON() doesn't interfere
  const processed = preprocessValue(value);
  return JSON.stringify(processed);
}

/**
 * Parse cache value with custom handling for Map and Buffer objects
 */
export function parseCacheValue(jsonString: string): any {
  return JSON.parse(jsonString, (_key, val) => {
    // Restore Map objects that were serialized with __type marker
    if (val && typeof val === "object" && val.__type === "Map") {
      return new Map(Object.entries(val.data));
    }
    // Restore Buffer objects that were serialized with __type marker (our custom format)
    if (val && typeof val === "object" && val.__type === "Buffer") {
      return Buffer.from(val.data);
    }
    // Restore Buffer objects that were serialized with Node.js default Buffer.toJSON() format
    // This handles legacy cache entries or runtime-generated entries
    if (
      val &&
      typeof val === "object" &&
      val.type === "Buffer" &&
      Array.isArray(val.data)
    ) {
      return Buffer.from(val.data);
    }
    return val;
  });
}

/**
 * The cache key a prerendered route's seeded entry has to be written under.
 *
 * `ctx.outputs.prerenders[].pathname` is the *URL* the page is served at, so it
 * carries the app's `basePath`. The key the server later looks entries up under
 * is the route, which does not — Next.js strips `basePath` before routing, so the
 * cache handler never sees it at request time. Seeding `/prod/ssg/1` verbatim
 * therefore writes `<buildId>/prod/ssg/1.json` while the server asks for
 * `<buildId>/ssg/1.json`: every build-time prerender is a MISS that re-renders on
 * first request, and the page is only "static" from the second visit onwards.
 */
export function prerenderPathToCacheKey(
  pathname: string,
  basePath: string,
): string {
  // Matching on a path boundary so a sibling route like `/production` is not
  // read as basePath `/prod` plus `uction`.
  const hasBasePath =
    !!basePath &&
    (pathname === basePath || pathname.startsWith(`${basePath}/`));
  const route = (hasBasePath ? pathname.slice(basePath.length) : pathname)
    // Leading slashes would make an S3 key with an empty first segment.
    .replace(/^\/+/, "");
  return route === "" ? "index" : route;
}

/**
 * Helper to safely extract tags from context
 */
export function getTags(
  ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
): string[] | undefined {
  return "tags" in ctx ? ctx.tags : undefined;
}
