/**
 * CloudFront path patterns for `NextjsDistribution`'s behaviors: spelling a
 * `public/` entry as one, putting the `basePath` in front, and checking the
 * `public/` ones against the function group ones.
 */
import {
  cloudFrontPatternRegex,
  PATH_PATTERN_LITERAL,
} from "../adapter/function-groups";
import { LOG_PREFIX } from "../constants";
import { PublicDirEntry } from "../nextjs-build/nextjs-build";

/** CloudFront's path pattern length limit. */
export const MAX_PATH_PATTERN_LENGTH = 255;

/**
 * Whether `char` is in CloudFront's path pattern alphabet: the literals, plus the
 * `*` and `?` wildcards. No space, no `%`, nothing non-ASCII.
 */
export function isPathPatternChar(char: string): boolean {
  return char === "*" || char === "?" || PATH_PATTERN_LITERAL.test(char);
}

/**
 * A `public/` entry's name as a CloudFront path pattern.
 *
 * `public/hello world.jpg` is a valid Next.js asset — `next start` serves it, and
 * `next/image` points at it — but a space cannot appear in a path pattern, so
 * cdk-nextjs used to throw at synth and the app could not be deployed at all
 * (`next-image-legacy/unicode`, whose `public/` also holds `äöüščří.png`).
 *
 * CloudFront URL-decodes the request path before matching it, so the pattern is
 * matched against `hello world.jpg`, not the `/hello%20world.jpg` on the wire.
 * Each character outside the alphabet is replaced by one `?` per byte of its
 * UTF-8 encoding, because that is what `?` matches: `hello?world.jpg` for the
 * space, and two `?` for each character of `äöüščří.png`. Measured against a
 * deployed distribution; a `?` per *percent-encoded* character (`hello???world`)
 * synthesizes fine and never matches. A `*` would be shorter and much wider:
 * `äöüščří.png` would become `*.png`, which would pull every `.png` request in
 * the app onto the static origin.
 */
export function toPathPattern(name: string): string {
  return [...name]
    .map((char) =>
      isPathPatternChar(char)
        ? char
        : "?".repeat(Buffer.byteLength(char, "utf8")),
    )
    .join("");
}

/**
 * Optionally prepends a normalized `basePath` ({@link normalizeBasePath}) to
 * the given path pattern.
 *
 * A trailing slash on `pathPattern` is load-bearing and survives, which is why
 * this concatenates rather than going through `joinPath`. The build's
 * `functionGroupBehaviors` hold both "pricing" and "pricing/" for a
 * `trailingSlash` app, and normalizing the second one collapsed it onto the
 * first: `addBehavior` was
 * then called twice with `/base/pricing`, which CloudFront rejects at deploy
 * ("more than one cache behavior has the same path pattern"), and the
 * canonical `/base/pricing/` was left to the `/base/*` catch-all — the misroute
 * the second pattern exists to prevent.
 */
export function getPathPattern(basePath: string, pathPattern: string): string {
  if (!basePath) {
    return pathPattern;
  }
  return `/${basePath}/${pathPattern.replace(/^\/+/, "")}`;
}

/**
 * The behavior path pattern for each top-level `public/` entry, final form:
 * `/*` for a directory and the basePath prefix both applied.
 *
 * An entry whose name has no character CloudFront can spell is left out of
 * `patterns` and named in `unmatchable` instead, rather than given a pattern of
 * nothing but wildcards. `фото/` is `????????/*` — any 8-byte first segment —
 * and public/ behaviors are added ahead of every compute behavior, so it would
 * send `/products/42` and `/settings/*` to S3, which answers 403. Leaving the
 * entry out costs its own files instead: those requests reach the compute,
 * which does not have them, and 404. One literal character is enough to keep a
 * pattern narrow — `????????.jpg` only matches `.jpg` requests — so only the
 * all-wildcard ones go.
 *
 * The length limit is checked here, on the final pattern, rather than in
 * {@link toPathPattern}: the `/*` and the basePath count against it too, and a
 * pattern that passed without them failed at deploy instead.
 */
export function publicPathPatterns(
  publicDirEntries: PublicDirEntry[],
  basePath: string,
): { patterns: string[]; unmatchable: string[] } {
  const patterns: string[] = [];
  const unmatchable: string[] = [];
  for (const publicFile of publicDirEntries) {
    const name = toPathPattern(publicFile.name);
    if (!/[^?*/]/.test(name)) {
      unmatchable.push(publicFile.name);
      continue;
    }
    const pathPattern = getPathPattern(
      basePath,
      publicFile.isDirectory ? `${name}/*` : name,
    );
    if (pathPattern.length > MAX_PATH_PATTERN_LENGTH) {
      throw new Error(
        `The public/ entry "${publicFile.name}" needs a ` +
          `${pathPattern.length}-character CloudFront path pattern, over ` +
          `the ${MAX_PATH_PATTERN_LENGTH}-character ` +
          "limit. Rename it, or move it into a subdirectory of public/ whose " +
          "own name is short enough. See " +
          "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesPathPattern",
      );
    }
    patterns.push(pathPattern);
  }
  return { patterns, unmatchable };
}

/** A function group behavior with its final path pattern, basePath included. */
export interface ResolvedFunctionGroupBehavior {
  readonly group: { readonly name: string };
  /** The group pattern it came from (`/docs/**`). */
  readonly route: string;
  readonly pathPattern: string;
}

/**
 * Refuse a group behavior that a `public/` behavior would make unreachable.
 *
 * `public/` behaviors are added first, and CloudFront stops at the first match,
 * so two cases send a group's route to S3 instead of its function — which is
 * why this is checked at synth, where both sides are known:
 * - the same pattern twice: `public/docs/` and `/docs/**` both deploy as
 *   `docs/*`. The synth succeeded and CloudFront rejected the deploy.
 * - a group pattern under a public directory: `/docs/guide/**` behind
 *   `docs/*` deploys and never matches.
 */
export function assertNoPublicCollisions(
  publicPatterns: string[],
  functionGroupBehaviors: ResolvedFunctionGroupBehavior[],
) {
  const publicRegexes = publicPatterns.map((pattern) => ({
    pattern,
    regex: cloudFrontPatternRegex(`/${pattern.replace(/^\/+/, "")}`),
  }));
  for (const { group, route, pathPattern } of functionGroupBehaviors) {
    const duplicate = publicPatterns.includes(pathPattern);
    // Matching the group pattern's own text is enough: its only wildcard is a
    // trailing `*`, so a public pattern that matches the text up to and
    // including it matches every URL the group pattern does.
    const shadow = duplicate
      ? undefined
      : publicRegexes.find(({ regex }) =>
          regex.test(`/${pathPattern.replace(/^\/+/, "")}`),
        );
    if (!duplicate && !shadow) {
      continue;
    }
    throw new Error(
      `${LOG_PREFIX} \`functionGroups\` pattern "${route}" (group ` +
        `"${group.name}") ` +
        (duplicate
          ? `deploys as the path pattern "${pathPattern}", which a top-level ` +
            `public/ entry already uses — CloudFront rejects a distribution ` +
            `with two behaviors on one path pattern. `
          : `deploys as "${pathPattern}", but the top-level public/ entry ` +
            `behind "${shadow!.pattern}" is matched first and sends every ` +
            `such request to S3, so the group's function would never see ` +
            `them. `) +
        `Move those public/ files under a directory no route uses, or ` +
        `group a different path.`,
    );
  }
}
