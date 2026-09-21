import { normalizeBasePath } from "./read-next-config-base-path";

/**
 * Appends `basePath` to an origin (or any URL prefix) for a construct's public
 * `url`, normalizing it first so neither side's slashes double up and an unset
 * or slash-only `basePath` leaves the origin untouched.
 */
export function appendBasePath(origin: string, basePath?: string): string {
  const normalized = normalizeBasePath(basePath);
  return normalized ? `${origin}/${normalized}` : origin;
}
