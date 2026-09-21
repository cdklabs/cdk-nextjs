import { LOG_PREFIX, NextjsType } from "../constants";
import { normalizeBasePath } from "./read-next-config-base-path";

function describe(basePath: string): string {
  return basePath ? `"/${basePath}"` : "unset";
}

/**
 * Checks the CDK `basePath` prop against the Next.js app's own `basePath`
 * (`NextjsBuild.nextConfigBasePath`) and throws at synth if the combination
 * can't serve the app. Both are normalized first, so "/base" and "base" agree.
 *
 * The two are genuinely different things — the prop is where the
 * infrastructure serves the app from (and which S3 key prefix the static assets
 * land under), the config is the prefix the app emits its own links and asset
 * hrefs under — so how strictly they have to line up depends on how the
 * `NextjsType` routes static requests.
 */
export function validateBasePath(
  nextjsType: NextjsType,
  propBasePath?: string,
  nextConfigBasePath?: string,
): void {
  const prop = normalizeBasePath(propBasePath);
  const config = normalizeBasePath(nextConfigBasePath);
  if (prop === config) {
    return;
  }

  const mismatch =
    `${LOG_PREFIX} basePath mismatch for NextjsType.${nextjsType}: the \`basePath\` prop is ${describe(prop)} ` +
    `but your Next.js app's config sets \`basePath\` to ${describe(config)}. `;

  switch (nextjsType) {
    case NextjsType.GLOBAL_FUNCTIONS:
    case NextjsType.GLOBAL_CONTAINERS:
      // `NextjsDistribution` builds its behaviors as `${basePath}/_next/static*`
      // and CloudFront hands an S3 origin the request path verbatim as the
      // object key, so the prop has to be the exact prefix the app emits.
      throw new Error(
        mismatch +
          "CloudFront serves static assets straight from S3 using the request path as the object key, so a mismatch means every `_next/static` and `public/` request 404s. " +
          "Set both to the same value, or neither.",
      );
    case NextjsType.REGIONAL_FUNCTIONS:
      // Prop unset with the app setting one is legitimate: API Gateway mounts
      // resources below the stage and strips it before invoking the app, so an
      // app whose basePath is the stage name (or a custom domain base path
      // mapping that gets stripped the same way) correctly leaves the prop
      // alone.
      if (!prop) {
        return;
      }
      // The reverse never works: the prop moves every resource, including the
      // `ANY` catch-all, under a path the app never links to.
      throw new Error(
        mismatch +
          "The `basePath` prop nests every API Gateway resource under that path, including the catch-all, so the app has to emit its links under the same prefix or every request 404s. " +
          "Either set your app's `basePath` to match, or leave the prop unset — unset is what you want when the app's `basePath` is the API Gateway stage name, since the stage isn't part of the resource path.",
      );
    case NextjsType.REGIONAL_CONTAINERS:
      // The ALB forwards every path to the container, which serves its own
      // static assets, so here `basePath` only namespaces the S3 bucket and has
      // no routing meaning that could disagree with the app.
      return;
  }
}
