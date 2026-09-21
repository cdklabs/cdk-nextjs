import { LOG_PREFIX, NextjsType } from "../constants";
import { normalizeBasePath } from "./read-next-config-base-path";

function describe(basePath: string): string {
  return basePath ? `"/${basePath}"` : "unset";
}

/**
 * Settles on the single `basePath` the infrastructure should be built around,
 * given the CDK `basePath` prop and the Next.js app's own `basePath`
 * (`NextjsBuild.nextConfigBasePath`), throwing at synth if the two can't serve
 * the app together. Both are normalized before comparison, so "/base" and
 * "base" agree.
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
  // Hand back the prop with only its trailing slashes trimmed rather than the
  // fully normalized form: an existing stack's cache behaviors and S3 keys
  // shouldn't shift shape over a leading slash, but a trailing one has to go,
  // since `NextjsDistribution` would build "/base//_next/static*" from it while
  // `BucketDeployment` collapses it and uploads keys under "base/_next/...".
  const propOrUndefined = prop
    ? (propBasePath ?? "").replace(/\/+$/, "")
    : undefined;
  if (prop === config) {
    return propOrUndefined;
  }

  const mismatch =
    `${LOG_PREFIX} basePath mismatch for NextjsType.${nextjsType}: the \`basePath\` prop is ${describe(prop)} ` +
    `but your Next.js app's config sets \`basePath\` to ${describe(config)}. `;

  switch (nextjsType) {
    case NextjsType.GLOBAL_FUNCTIONS:
    case NextjsType.GLOBAL_CONTAINERS:
      // `NextjsDistribution` builds its behaviors as `${basePath}/_next/static*`
      // and CloudFront hands an S3 origin the request path verbatim as the
      // object key, so the only value that can serve the app is the prefix the
      // app itself emits. That leaves the prop no room to differ, which makes
      // the app's config the single source of truth worth deriving from.
      if (!prop) {
        return `/${config}`;
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
        return propOrUndefined;
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
      return propOrUndefined;
  }
}
