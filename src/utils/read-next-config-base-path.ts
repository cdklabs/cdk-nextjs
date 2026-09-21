import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";

const debug = getDebug("cdk-nextjs:nextjs-build");

/**
 * Read the Next.js app's own `basePath` out of `required-server-files.json`,
 * which `next build` writes into `.next` with the fully resolved config (so
 * this picks up a `basePath` computed in `next.config.js`, not only a literal
 * one). Returns a bare path segment with no surrounding slashes, empty when the
 * app sets none.
 *
 * Degrades to `""` rather than throwing: all this powers is a consistency check
 * against the CDK `basePath` prop, and an unreadable file shouldn't be enough
 * to fail a deployment that would otherwise work.
 */
export function readNextConfigBasePath(dotNextPath: string): string {
  const requiredServerFiles = join(dotNextPath, "required-server-files.json");
  if (!existsSync(requiredServerFiles)) {
    debug(
      `"required-server-files.json" not found at ${requiredServerFiles}, assuming the app sets no basePath`,
    );
    return "";
  }
  try {
    const { config } = JSON.parse(readFileSync(requiredServerFiles, "utf-8"));
    return normalizeBasePath(config?.basePath);
  } catch (error) {
    debug(`Could not read basePath from ${requiredServerFiles}: ${error}`);
    return "";
  }
}

/**
 * Reduces a `basePath` to a bare path segment so values that address the same
 * path ("/base", "base", "/base/") compare equal and can be concatenated into
 * an S3 key without doubling separators.
 */
export function normalizeBasePath(basePath?: string): string {
  return (basePath || "").replace(/^\/+/, "").replace(/\/+$/, "");
}
