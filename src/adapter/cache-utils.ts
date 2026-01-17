/*
  Shared cache utility functions
*/
import type {
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";

/**
 * Serialize cache value with custom handling for Map and Buffer objects
 */
export function serializeCacheValue(value: any): string {
  return JSON.stringify(value, (_key, val) => {
    // Convert Map objects to plain objects for JSON serialization
    if (val instanceof Map) {
      return {
        __type: "Map",
        data: Object.fromEntries(val),
      };
    }
    // Convert Buffer objects to a restorable format
    if (Buffer.isBuffer(val)) {
      return {
        __type: "Buffer",
        data: Array.from(val),
      };
    }
    return val;
  });
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
    // Restore Buffer objects that were serialized with __type marker
    if (val && typeof val === "object" && val.__type === "Buffer") {
      return Buffer.from(val.data);
    }
    return val;
  });
}

/**
 * Helper to safely extract tags from context
 */
export function getTags(
  ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
): string[] | undefined {
  return "tags" in ctx ? ctx.tags : undefined;
}
