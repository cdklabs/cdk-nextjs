import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_PREFIX } from "../constants";

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
 *
 * The fallback warns rather than staying silent because `""` is
 * indistinguishable from an app that genuinely sets no `basePath`: for the
 * `NextjsType`s that derive `basePath` from the app, an unreadable file means
 * the derivation quietly doesn't happen and every static asset 404s, and for
 * the ones that validate the prop against it, it means synth reports the app as
 * setting no `basePath` when it may well set one.
 */
export function readNextConfigBasePath(dotNextPath: string): string {
  const requiredServerFiles = join(dotNextPath, "required-server-files.json");
  const fallback = (reason: string) => {
    console.warn(
      `${LOG_PREFIX} ${reason}. Assuming your Next.js app sets no \`basePath\`: ` +
        "if it does set one, static assets will 404 and any `basePath` prop " +
        "mismatch reported at synth will name the wrong value.",
    );
    return "";
  };
  if (!existsSync(requiredServerFiles)) {
    return fallback(
      `"required-server-files.json" not found at ${requiredServerFiles}`,
    );
  }
  try {
    const { config } = JSON.parse(readFileSync(requiredServerFiles, "utf-8"));
    return normalizeBasePath(config?.basePath);
  } catch (error) {
    return fallback(
      `Could not read basePath from ${requiredServerFiles}: ${error}`,
    );
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
