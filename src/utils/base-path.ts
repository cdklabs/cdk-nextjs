import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_PREFIX, NextjsType } from "../constants";

/**
 * Reduces a `basePath` to a bare path segment so values that address the same
 * path ("/base", "base", "/base/") compare equal and can be concatenated
 * without doubling separators.
 */
export function normalizeBasePath(basePath?: string): string {
  return (basePath || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Joins path parts with a single "/", normalizing each (so no leading or
 * trailing slash survives, including on the result) and dropping the empty
 * ones, so an unset `basePath` or key prefix leaves the rest untouched.
 */
export function joinPath(...parts: (string | undefined)[]): string {
  return parts.map(normalizeBasePath).filter(Boolean).join("/");
}

/**
 * Prefixes an absolute app path (a health check path, say) with `basePath`,
 * always returning a leading slash. An empty or unset `basePath` only
 * normalizes that leading slash. Anything after the first segment is passed
 * through as given, trailing slash included, since a `trailingSlash` app
 * answers "/api/health" and "/api/health/" differently.
 *
 * Use this for paths handed to something that talks to the app directly — an ALB
 * target group health check, the Lambda Web Adapter readiness check — since the
 * app only answers under its own `basePath`.
 *
 * Prefixes unconditionally, so `path` has to arrive as the app routes it,
 * without `basePath`: for an app based at "/base", "/base/api/health" becomes
 * "/base/base/api/health". Deliberately not special-cased — an app can route
 * "/base/base/..." legitimately, and accepting both spellings would give the
 * path two meanings. See `docs/breaking-changes.md` (0.6.0), which tells users
 * who prefixed `healthCheckPath` by hand to drop the prefix.
 */
export function prefixWithBasePath(
  basePath: string | undefined,
  path: string,
): string {
  const normalized = normalizeBasePath(basePath);
  const absolute = path.startsWith("/") ? path : `/${path}`;
  return normalized ? `/${normalized}${absolute}` : absolute;
}

/**
 * Read the Next.js app's own `basePath` out of `required-server-files.json`,
 * which `next build` writes into `.next` with the fully resolved config (so
 * this picks up a `basePath` computed in `next.config.js`, not only a literal
 * one). Normalized, empty when the app sets none.
 *
 * Degrades to `""` rather than throwing, since an unreadable file shouldn't
 * fail a deployment that would otherwise work. It warns because `""` is
 * indistinguishable from an app that genuinely sets no `basePath`: the
 * `NextjsType`s that derive `basePath` from the app would quietly not derive
 * it and 404 every static asset.
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

/** Whether an `assetPrefix` names an origin rather than a path on this one. */
function isAbsoluteAssetPrefix(assetPrefix: string): boolean {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(assetPrefix);
}

/**
 * Read the app's own `assetPrefix` out of the same fully resolved config, as a
 * path with a leading and no trailing slash ("/cdn"), or `""` when the app sets
 * none.
 *
 * Returns `""` for an absolute `assetPrefix` ("https://cdn.example.com", or the
 * protocol-relative "//cdn.example.com") too: that names an origin cdk-nextjs
 * does not control, and it is the supported way to serve assets from elsewhere,
 * so nothing about it is worth warning about. Use
 * {@link readNextConfigAssetPrefixPath} for what the *distribution* has to
 * answer on, which includes the path an absolute prefix carries.
 *
 * Next.js applies `assetPrefix` on top of, not under, `basePath`, so the result
 * is the whole prefix of a `_next/static` URL and must not be joined with
 * `basePath`.
 */
export function readNextConfigAssetPrefix(dotNextPath: string): string {
  const assetPrefix = readAssetPrefix(dotNextPath, true);
  if (!assetPrefix || isAbsoluteAssetPrefix(assetPrefix)) return "";
  const normalized = normalizeBasePath(assetPrefix);
  return normalized ? `/${normalized}` : "";
}

/**
 * The *path* every bundle URL carries, whichever form `assetPrefix` takes: "/cdn"
 * for `assetPrefix: "/cdn"` and for `assetPrefix:
 * "https://cdn.example.com/cdn"` alike, `""` when there is none (an absolute
 * prefix with no path, or no prefix at all).
 *
 * An absolute prefix's path counts because `next build` compiles a `beforeFiles`
 * rewrite of its own for it — `/cdn/_next/:path+ → /_next/:path+` — so `next
 * start` serves every bundle under that path as well as under `/_next`. A CDN
 * fronting this deployment at that path therefore has to be answered, and the
 * distribution's `assetPrefix` behavior is what answers it. Measured against
 * `test/e2e/app-dir/asset-prefix-absolute`; see `docs/harness-coverage.md`.
 */
export function readNextConfigAssetPrefixPath(dotNextPath: string): string {
  return assetPrefixPath(readAssetPrefix(dotNextPath, false));
}

/**
 * The path portion of an `assetPrefix` value, with a leading and no trailing
 * slash, or `""` when it carries none. Shared with `NextjsDistribution`, whose
 * `assetPrefix` prop a user can also set by hand.
 */
export function assetPrefixPath(assetPrefix: string): string {
  if (!assetPrefix) return "";
  let path = assetPrefix;
  if (isAbsoluteAssetPrefix(assetPrefix)) {
    try {
      // `//cdn.example.com/cdn` is protocol-relative, which `URL` only parses
      // with a base — any base, since only the path is read off it.
      path = new URL(assetPrefix, "https://asset-prefix.invalid").pathname;
    } catch {
      return "";
    }
  }
  const normalized = normalizeBasePath(path);
  return normalized ? `/${normalized}` : "";
}

/**
 * The raw `assetPrefix` string, or `""` when it cannot be read. `warnOnError` is
 * off for the second reader of the same file, so an unreadable one is reported
 * once per synth rather than once per reader.
 */
function readAssetPrefix(dotNextPath: string, warnOnError: boolean): string {
  const requiredServerFiles = join(dotNextPath, "required-server-files.json");
  if (!existsSync(requiredServerFiles)) {
    // `readNextConfigBasePath` already warned about this file; an app with no
    // `assetPrefix` is also the overwhelmingly common case, so a second warning
    // would be noise on every synth.
    return "";
  }
  try {
    const { config } = JSON.parse(readFileSync(requiredServerFiles, "utf-8"));
    const assetPrefix: unknown = config?.assetPrefix;
    return typeof assetPrefix === "string" ? assetPrefix : "";
  } catch (error) {
    if (warnOnError) {
      console.warn(
        `${LOG_PREFIX} Could not read assetPrefix from ${requiredServerFiles}: ${error}. ` +
          "Assuming your Next.js app sets no `assetPrefix`: if it does set one, " +
          "its bundles will 404.",
      );
    }
    return "";
  }
}

function quote(basePath: string): string {
  return basePath ? `"/${basePath}"` : "unset";
}

/**
 * Settles on the single `basePath` the infrastructure should be built around,
 * given the CDK `basePath` prop and the Next.js app's own `basePath`
 * (`NextjsBuild.nextConfigBasePath`), throwing at synth if the two can't serve
 * the app together. Returns a normalized value, or `undefined` for no
 * `basePath` at all; consumers that need a leading slash add their own.
 *
 * The two inputs are genuinely different things — the prop is where the
 * infrastructure serves the app from (and which S3 key prefix the static assets
 * land under), the config is the prefix the app emits its own links and asset
 * hrefs under — so how strictly they have to line up, and whether one can stand
 * in for the other, depends on how the `NextjsType` routes static requests.
 */
export function resolveBasePath(
  nextjsType: NextjsType,
  propBasePath?: string,
  nextConfigBasePath?: string,
): string | undefined {
  const prop = normalizeBasePath(propBasePath);
  const config = normalizeBasePath(nextConfigBasePath);
  if (prop === config) {
    return prop || undefined;
  }

  const mismatch =
    `${LOG_PREFIX} basePath mismatch for NextjsType.${nextjsType}: the \`basePath\` prop is ${quote(prop)} ` +
    `but your Next.js app's config sets \`basePath\` to ${quote(config)}. `;

  switch (nextjsType) {
    case NextjsType.GLOBAL_FUNCTIONS:
    case NextjsType.GLOBAL_CONTAINERS:
      // `NextjsDistribution` builds its behaviors as `/${basePath}/_next/static*`
      // and CloudFront hands an S3 origin the request path verbatim as the
      // object key, so the only value that can serve the app is the prefix the
      // app itself emits. That leaves the prop no room to differ, which makes
      // the app's config the single source of truth worth deriving from.
      if (!prop) {
        return config;
      }
      throw new Error(
        mismatch +
          "CloudFront serves static assets straight from S3 using the request path as the object key, so a mismatch means every `_next/static` and `public/` request 404s. " +
          "Either set both to the same value, or drop the prop — left unset, it follows your app's `basePath`.",
      );
    case NextjsType.REGIONAL_FUNCTIONS:
      // Deliberately not derived: API Gateway mounts resources below the stage
      // and strips it before invoking the app, so an app whose basePath is the
      // stage name (or a custom domain base path mapping that gets stripped the
      // same way) is correct precisely because the prop stays unset.
      if (!prop) {
        return undefined;
      }
      // The prop only has to be the tail of what the app emits, not all of it,
      // because the stripped prefix is part of the app's `basePath` but never
      // part of the resource path: an app at the `prod` stage nested under
      // "/base" sets `basePath: "/prod/base"` and the prop to "/base". Checked
      // on a path boundary so "/prod/base" doesn't accept a prop of "se".
      if (config.endsWith(`/${prop}`)) {
        return prop;
      }
      // Anything else never works: the prop moves every resource, including the
      // `ANY` catch-all, under a path the app never links to.
      throw new Error(
        mismatch +
          "The `basePath` prop nests every API Gateway resource under that path, including the catch-all, so the app has to emit its links under the same prefix or every request 404s. " +
          'Either set your app\'s `basePath` to end with the prop (optionally prefixed by the stage or base path mapping API Gateway strips, e.g. `basePath: "/prod/base"` with a prop of "/base"), or leave the prop unset — unset is what you want when the app\'s `basePath` is the API Gateway stage name, since the stage isn\'t part of the resource path.',
      );
    case NextjsType.REGIONAL_CONTAINERS:
      // The ALB forwards every path to the container, which serves its own
      // static assets, so here `basePath` only namespaces the S3 bucket and has
      // no routing meaning that could disagree with the app.
      return prop || undefined;
  }
}
