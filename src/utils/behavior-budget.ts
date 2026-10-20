import { Token } from "aws-cdk-lib";

/**
 * CloudFront's default "Cache behaviors per distribution" quota, the default
 * behavior included. Adjustable, hence `maxCacheBehaviors`.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions
 */
export const DEFAULT_MAX_CACHE_BEHAVIORS = 75;

export interface BehaviorBudgetProps {
  /** `maxCacheBehaviors`, possibly a token. */
  readonly limit: number;
  /** Normalized ({@link normalizeBasePath}), `""` for none. */
  readonly basePath: string;
  /** The `assetPrefix` path that needs a behavior of its own, `""` for none. */
  readonly assetPrefix: string;
  /** Whether service workers get a behavior that adds `Service-Worker-Allowed`. */
  readonly serviceWorker?: boolean;
  /** How many top-level `public/` entries get a behavior. */
  readonly publicPatterns: number;
  /** How many function group behaviors there are. */
  readonly groupPatterns: number;
}

/**
 * CloudFront has a per-distribution cache behavior quota, counting the default
 * one — 75 unless raised, and `maxCacheBehaviors` says which — and there are
 * three things competing for it: `public/` entries, function groups, and
 * cdk-nextjs's own fixed set.
 * Checked in one place so the error can say which to cut.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions
 */
export function assertBehaviorBudget({
  limit,
  basePath,
  assetPrefix,
  serviceWorker,
  publicPatterns,
  groupPatterns,
}: BehaviorBudgetProps) {
  if (Token.isUnresolved(limit)) {
    return;
  }
  // The default behavior, `_next/image*`, `_next/static*`, plus — with a
  // basePath — the two that stand in for the default behavior's coverage, and
  // — with a path-style assetPrefix — the one that serves bundles under it,
  // and — with service workers — the one that adds `Service-Worker-Allowed`.
  // The normalized basePath, not the raw prop: `basePath: "/"` normalizes to
  // `""` and adds no behaviors, so counting it added 2 to the total and could
  // throw "over the limit" on an app that is under it.
  const fixed =
    3 + (basePath ? 2 : 0) + (assetPrefix ? 1 : 0) + (serviceWorker ? 1 : 0);
  const total = fixed + publicPatterns + groupPatterns;
  if (total <= limit) {
    return;
  }
  const parts = [
    `${fixed} used by cdk-nextjs itself`,
    `${publicPatterns} for top-level public/ entries`,
  ];
  if (groupPatterns) {
    parts.push(`${groupPatterns} for \`functionGroups\` patterns`);
  }
  throw new Error(
    `This Next.js app needs ${total} CloudFront cache behaviors, over the ` +
      `limit of ${limit} per distribution: ${parts.join(", ")}. ` +
      `Move public/ files into a single top-level directory (one behavior ` +
      `serves \`static/*\`)` +
      (groupPatterns
        ? `, and prefer one subtree pattern per function group over several ` +
          `exact paths`
        : ``) +
      `. If your account's quota is higher than ${limit}, set ` +
      `\`maxCacheBehaviors\` to it. See https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions`,
  );
}
