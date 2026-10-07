/**
 * `functionGroups` resolution: the rules shared by `next build` and synth.
 *
 * Splitting spans two processes. `onBuildComplete` stages one deployment tree
 * per group while `next build` is still running; the constructs turn the groups
 * into CloudFront behaviors or API Gateway resources at synth. If the two
 * disagree, CloudFront sends a request to a function whose zip lacks its
 * entrypoint — so the build decides both, here, and records the behaviors it
 * checked in the manifest for synth to deploy as they are. Synth still runs
 * {@link validateFunctionGroups}, to fail before a `next build` it would
 * otherwise pay for.
 *
 * Nothing in this file imports `aws-cdk-lib`: it is bundled into the adapter by
 * esbuild. The public JSII struct consumers actually write (`NextjsFunctionGroup`,
 * which adds per-group `overrides`) is in `src/nextjs-compute/nextjs-functions.ts`
 * and is structurally assignable to {@link FunctionGroupSpec}.
 */
import { LOG_PREFIX } from "../constants";
import { ERROR_PAGE_SUFFIXES } from "../runtime/manifest";
import { basePathPrefix, hasPathPrefix } from "../utils/base-path";

/**
 * The implicit group every unassigned route falls into. Reserved as a group
 * name: it is also the construct id suffix and the function whose URL backs the
 * distribution's default behavior.
 */
export const DEFAULT_FUNCTION_GROUP = "default";

/**
 * How the resolved groups reach `onBuildComplete`, which cannot read CDK props —
 * it runs inside `next build`. `CDK_NEXTJS_INIT_CACHE_DIR` is the precedent.
 */
export const FUNCTION_GROUPS_ENV_VAR = "CDK_NEXTJS_FUNCTION_GROUPS";

/** The part of a group the build side needs. */
export interface FunctionGroupSpec {
  readonly name: string;
  readonly routes: string[];
}

/** One route template and the entrypoint it invokes. */
export interface RouteEntry {
  /** Basepath-prefixed route template, exactly as `manifest.entrypoints` keys it. */
  readonly template: string;
  /**
   * What identifies the entrypoint: the build side passes its `filePath`, since
   * that is what gets staged. Two templates sharing one are never split apart.
   */
  readonly entrypointId: string;
  /**
   * The entrypoint's `AdapterEntrypointType`. Only `"page"` changes anything: a
   * Pages Router page is also requested at `/_next/data/<buildId>/<page>.json`,
   * so that URL has to reach the page's group too.
   */
  readonly type?: string;
}

/**
 * One behavior the edge routes a group on. The Functions root constructs deploy
 * exactly these, in order: a CloudFront behavior each, or the API Gateway
 * resources for each distinct `route`.
 */
export interface GroupBehavior {
  readonly group: string;
  /**
   * The group pattern (`/blog/**`) the behavior was generated from, or the
   * optional catch-all parent {@link routedPatterns} added.
   */
  readonly route: string;
  /**
   * The CloudFront path pattern, before basePath and without a leading slash
   * (`blog/*`, `_next/data/<buildId>/blog/*`).
   */
  readonly pattern: string;
}

/** What {@link assignRoutesToGroups} decided. */
export interface GroupAssignment {
  /** Group name → the templates packaged into it, `default` included. */
  readonly templates: Record<string, string[]>;
  /**
   * Every group behavior, most specific first: the order CloudFront has to see
   * them in, since it stops at the first match. Recorded rather than
   * recomputed at synth, so the behaviors deployed are the ones this
   * assignment was checked against.
   */
  readonly behaviors: GroupBehavior[];
}

/** What {@link assignRoutesToGroups} needs to know besides the routes. */
export interface AssignRoutesOptions {
  /** `next.config` `basePath`, which every manifest template carries. */
  readonly basePath: string;
  /**
   * Next.js's build ID — the segment in `/_next/data/<buildId>/…` URLs, which is
   * `ctx.buildId` and `.next/BUILD_ID`, not cdk-nextjs's deployment-suffixed
   * one. Required when any entry is a Pages Router page.
   */
  readonly buildId?: string;
  /** `next.config` `trailingSlash`. */
  readonly trailingSlash?: boolean;
  /**
   * `ctx.routing`: the `next.config` rewrites whose source and destination
   * have to land in one group, and Next.js's own dynamic route order, which
   * decides the template a URL resolves to.
   */
  readonly routing: RoutingRules;
}

/** One `ctx.routing` rewrite, reduced to the fields read here. */
export interface RewriteRule {
  /** The path-to-regexp source, basePath included (`/old/:path*`). */
  readonly source?: string;
  readonly destination?: string;
}

/** The part of `ctx.routing` {@link assignRoutesToGroups} reads. */
export interface RoutingRules {
  readonly beforeFiles?: readonly RewriteRule[];
  readonly afterFiles?: readonly RewriteRule[];
  readonly fallback?: readonly RewriteRule[];
  /** Next.js's own template matchers, used to resolve a rewrite's destination. */
  readonly dynamicRoutes?: readonly {
    readonly sourceRegex: string;
    readonly destination?: string;
  }[];
}

const ERROR_PREFIX = `${LOG_PREFIX} \`functionGroups\`: `;
const NAME_PATTERN = /^[a-zA-Z0-9-]+$/;
const SUBTREE_SUFFIX = "/**";
/**
 * The literal characters a CloudFront path pattern may contain: its alphabet
 * (`A-Z a-z 0-9 _ - . * $ / ~ " ' @ : +` and `&`) less the two wildcards, which
 * `validateRoutePattern` only accepts as a trailing `/**`. `nextjs-distribution.ts`
 * adds the wildcards back to encode `public/` names.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesPathPattern
 */
export const PATH_PATTERN_LITERAL = /[a-zA-Z0-9_\-.$/~"'@:+&]/;

/**
 * Read {@link FUNCTION_GROUPS_ENV_VAR}. `undefined` — not the empty array — when
 * unset, because "no splitting" and "split into nothing" are different requests
 * and only the first is valid.
 */
export function parseFunctionGroupsEnv(
  value: string | undefined,
): FunctionGroupSpec[] | undefined {
  return value ? JSON.parse(value) : undefined;
}

/**
 * Splitting and `i18n` are mutually exclusive, and it is a CloudFront limit
 * again.
 *
 * With `i18n` configured, every route template is locale-prefixed
 * (`/en/pricing`, `/de/pricing`), so honoring a `/pricing` group would take one
 * behavior *per locale per pattern* — a budget of 75 behaviors spent in a handful
 * of routes. The alternative, a `*` in the locale position, matches any first
 * segment and would capture routes belonging to other groups. Neither is
 * something to do silently, so refuse instead.
 */
export function assertNoI18nSplitting(i18n: unknown): void {
  if (i18n === null || i18n === undefined) {
    return;
  }
  throw new Error(
    `${ERROR_PREFIX}\`functionGroups\` cannot be combined with \`i18n\`. ` +
      `With i18n every route is locale-prefixed, so routing a group at the edge ` +
      `would need one CloudFront behavior per locale per pattern, against a ` +
      `quota of 75 for the whole distribution. Deploy one function for every ` +
      `route (omit \`functionGroups\`), or drop \`i18n\`.`,
  );
}

/**
 * Reject everything that cannot be honored, at the earliest of the two sides to
 * see it. Called from both, because either can be the first: `next build` runs
 * before synth reads the manifest, but a `skipBuild: true` consumer inverts that.
 */
export function validateFunctionGroups(
  groups: readonly FunctionGroupSpec[],
): void {
  if (groups.length === 0) {
    throw new Error(
      `${ERROR_PREFIX}\`functionGroups\` is an empty array. Omit the prop ` +
        `entirely to deploy one function for every route, which is the default.`,
    );
  }

  const seenNames = new Set<string>();
  const patternOwner = new Map<string, string>();

  for (const group of groups) {
    if (group.name === DEFAULT_FUNCTION_GROUP) {
      throw new Error(
        `${ERROR_PREFIX}"${DEFAULT_FUNCTION_GROUP}" is a reserved group name: ` +
          `it is the implicit group every unassigned route falls into.`,
      );
    }
    if (!NAME_PATTERN.test(group.name)) {
      throw new Error(
        `${ERROR_PREFIX}Group name "${group.name}" must match ` +
          `${NAME_PATTERN} — it becomes a construct id and part of a Lambda ` +
          `function name.`,
      );
    }
    if (seenNames.has(group.name)) {
      throw new Error(
        `${ERROR_PREFIX}Two groups are both named "${group.name}".`,
      );
    }
    seenNames.add(group.name);

    if (group.routes.length === 0) {
      throw new Error(
        `${ERROR_PREFIX}Group "${group.name}" owns no routes. Every group is a ` +
          `Lambda function, so an empty one would deploy and never be reached.`,
      );
    }
    for (const route of group.routes) {
      validateRoutePattern(route, group.name);
      const owner = patternOwner.get(route);
      if (owner !== undefined) {
        throw new Error(
          `${ERROR_PREFIX}Pattern "${route}" appears in both group "${owner}" ` +
            `and group "${group.name}". A route can only be packaged into one ` +
            `function. (Overlapping-but-different patterns are fine: "/api/**" ` +
            `in one group and "/api/reports/**" in another resolves ` +
            `longest-first.)`,
        );
      }
      patternOwner.set(route, group.name);
    }
  }
}

/**
 * A pattern is an exact static path (`/pricing`) or a subtree (`/api/reports/**`).
 *
 * **Dynamic segments are rejected**, and the reason is CloudFront rather than
 * anything about Next.js. Patterns become behavior path patterns, and CloudFront
 * supports only `*` and `?`, so `/dashboard/[id]` could only ever deploy as
 * `/dashboard/*` — which also matches `/dashboard/settings` and
 * `/dashboard/a/b/c`. If those are in another group, CloudFront routes them to a
 * function whose zip lacks their entrypoint: a crash on a route the consumer
 * explicitly assigned elsewhere. Accepting a syntax whose granularity cannot be
 * honored would be worse than rejecting it.
 *
 * The restriction costs nothing that was achievable anyway. `/dashboard/**` →
 * `/dashboard/*` is the same URL space exactly, and isolating one heavy dynamic
 * route still works as a subtree: `/api/report/**` covers `/api/report/[id]`.
 *
 * `NextjsRegionalFunctions` gets the same restriction even though API Gateway
 * REST could express `/{id}` precisely — so that switching deployment type (to
 * Regional for GovCloud, say) never silently changes how routes are grouped.
 * That one is a consistency choice, not a technical limit.
 */
function validateRoutePattern(route: string, groupName: string): void {
  const where = `Group "${groupName}" pattern "${route}"`;
  if (!route.startsWith("/")) {
    throw new Error(
      `${ERROR_PREFIX}${where} must start with "/". Patterns are URL paths as ` +
        `the browser requests them.`,
    );
  }
  // `/index` is deliberately allowed. For the App Router it is a real route of
  // its own (`app/index/page.tsx`), which `routablePathnames` keeps apart from
  // `/`. For the Pages Router it is the home page under the name `next build`
  // reports it by, one entrypoint registered under `/` as well — and grouping
  // that would leave `/` on the default behavior with a function that lacks the
  // file. Only the assignment can tell the two apart, and its coverage check
  // (`assertEdgeReachesEveryFile`) rejects the second.
  if (route === "/") {
    throw new Error(
      `${ERROR_PREFIX}${where} cannot be routed. CloudFront has no path ` +
        `pattern that matches only "/" — the default behavior serves it — so the ` +
        `home page always belongs to the "${DEFAULT_FUNCTION_GROUP}" group. ` +
        `Group the routes around it instead.`,
    );
  }
  // `/_next/…` is Next's own URL space — build assets, `/_next/image`, and the
  // Pages Router data routes — and each has its behavior already: the data route
  // of a grouped page follows it (see `pathPatternsFor`), and a `_next/*` behavior
  // would compete with the static-asset and image ones for everything else.
  if (route === "/_next" || route.startsWith("/_next/")) {
    throw new Error(
      `${ERROR_PREFIX}${where} is under "/_next", which Next.js reserves for ` +
        `build assets, image optimization and data routes. A Pages Router ` +
        `page's "/_next/data/…" route follows the page into its group, so ` +
        `group the page itself instead.`,
    );
  }
  if (route === SUBTREE_SUFFIX) {
    throw new Error(
      `${ERROR_PREFIX}${where} would own every route, leaving the default ` +
        `group empty. Splitting exists to divide routes between functions; ` +
        `omit \`functionGroups\` to deploy them all in one.`,
    );
  }
  if (/[[\]]/.test(route)) {
    throw new Error(
      `${ERROR_PREFIX}${where} contains a dynamic segment. Patterns become ` +
        `CloudFront behavior path patterns, which support only "*" and "?", so ` +
        `"${route}" could only deploy as a wildcard that also captures its ` +
        `siblings. Use a subtree instead: "/blog/**" owns "/blog/[slug]".`,
    );
  }
  if (/\((.*)\)/.test(route)) {
    throw new Error(
      `${ERROR_PREFIX}${where} contains a route group segment. Route groups ` +
        `like "(marketing)" organize files and never appear in a URL, so they ` +
        `cannot be routed on. Use the URL path the route is served at.`,
    );
  }
  const withoutSubtree = route.endsWith(SUBTREE_SUFFIX)
    ? route.slice(0, -SUBTREE_SUFFIX.length)
    : route;
  if (/[*?]/.test(withoutSubtree)) {
    throw new Error(
      `${ERROR_PREFIX}${where} contains a wildcard somewhere other than a ` +
        `trailing "/**". The only two forms are an exact path ("/pricing") and ` +
        `a subtree ("/api/reports/**").`,
    );
  }
  if (route.includes("//")) {
    throw new Error(`${ERROR_PREFIX}${where} contains an empty path segment.`);
  }
  // A route Next.js serves can still hold a character no path pattern can:
  // `app/über/page.tsx`, `app/a b/page.tsx`, `app/a,b/page.tsx` all build, and
  // the pattern passes every check above. `pathPatternsFor` copies it verbatim,
  // so it reached `addBehavior` untouched and was left for CloudFront to reject,
  // in an error naming neither the group nor the route. The `public/`
  // workaround, one `?` per UTF-8 byte, is not available here: `?` matches *any*
  // byte, so `/über` would deploy as `/??ber` and also send `/xyber` to this
  // group's function, whose zip lacks its entrypoint. That is the sibling capture
  // dynamic segments are rejected for, so the same answer applies.
  const invalid = [...new Set(withoutSubtree)].filter(
    (char) => !PATH_PATTERN_LITERAL.test(char),
  );
  if (invalid.length > 0) {
    throw new Error(
      `${ERROR_PREFIX}${where} contains ` +
        `${invalid.map((char) => JSON.stringify(char)).join(", ")}, which a ` +
        `CloudFront behavior path pattern cannot contain (allowed: A-Z a-z 0-9 ` +
        `_ - . $ / ~ " ' @ : + &). Escaping it with "?" would also match other ` +
        `routes of the same length. Use a subtree on a parent segment whose ` +
        `name is plain ASCII instead: "/intl/**" owns "/intl/über".`,
    );
  }
}

/**
 * Split every route template across the groups, longest matching pattern first,
 * then prove that the edge routes every URL each file serves to the group that
 * file was packaged into.
 *
 * Its `templates` are keyed by group name and always contain
 * {@link DEFAULT_FUNCTION_GROUP}, so callers can iterate them as the complete set
 * of functions to deploy. The default group is allowed to be empty of *templates*
 * — it still serves `/_next/image`, any static file, and anything the
 * distribution's catch-all behavior sends it.
 *
 * `basePath` is prepended to each pattern before matching, because manifest
 * templates are basePath-prefixed and consumers write the routes their app
 * declares.
 *
 * Packaging matches patterns against *templates*, but CloudFront routes *URLs*,
 * and a file answers URLs none of its templates spells: an optional catch-all's
 * parent, the `trailingSlash` form, a Pages Router data URL, every other
 * template it shares (root params synthesize `/en` and `/de` from one
 * `[locale]` page). An interception route is worse: it is never requested at its
 * own path at all. So after matching, intercepting files move to the group of
 * the URL they intercept ({@link reassignInterceptingFiles}), and the result is
 * replayed through the same behaviors `NextjsDistribution` deploys
 * ({@link assertEdgeReachesEveryFile}, {@link assertRewritesStayInGroup}). A URL
 * that would reach a function without its file throws here, during `next build`,
 * rather than answering 404 once deployed.
 */
export function assignRoutesToGroups(
  groups: readonly FunctionGroupSpec[],
  entries: readonly RouteEntry[],
  options: AssignRoutesOptions,
): GroupAssignment {
  validateFunctionGroups(groups);
  const basePath = basePathPrefix(options.basePath);

  // Matched with the very behaviors `NextjsDistribution` deploys for the
  // declared patterns, most specific first, so packaging and the edge share one
  // routing model and the first match is the winner. Data routes are left out:
  // no template is under `/_next`, and which groups have them is decided by
  // this assignment.
  const edgeBase = {
    basePath,
    buildId: options.buildId,
    trailingSlash: options.trailingSlash ?? false,
  };
  const patterns = edgeBehaviors(
    groups,
    {},
    { ...edgeBase, dataRouteGroups: new Set() },
  );

  const matchedPatterns = new Set<string>();
  // An entrypoint is a *file*; two templates can share one (a Pages Router page
  // and its `/_next/data/<buildId>/…json` sibling). Splitting them across zips
  // would stage the same file twice and route one of them to a function that
  // has it by accident, so ownership is recorded per entrypoint and reused.
  const groupOfEntrypoint = new Map<string, string>();
  // Which `patterns` index won the entrypoint. `patterns` is sorted
  // most-specific-first, so a lower index is the better claim, and keeping it
  // stops a second template that shares the entrypoint from taking it over with
  // a *broader* pattern. Without it the owner was whichever of the two templates
  // `entries` happened to visit last — the same build grouped differently
  // depending on manifest key order.
  const winningIndexOfEntrypoint = new Map<string, number>();

  for (const entry of entries) {
    let winner: number | undefined;
    for (const [index, pattern] of patterns.entries()) {
      if (!pattern.regex.test(entry.template)) {
        continue;
      }
      // Every match is recorded, not only the winning one. A pattern fully
      // shadowed by a narrower pattern in another group never wins anything —
      // "/api/**" against an app whose only API routes are under
      // "/api/reports/**" — so recording just the winner left it looking like a
      // typo and threw below, rejecting the very layout the duplicate-pattern
      // error a few lines up documents as supported.
      matchedPatterns.add(`${pattern.group}\u0000${pattern.route}`);
      winner ??= index;
    }
    // An intercepting file's own template (`/feed/(..)photo/[id]`) is not a URL
    // anyone requests, so it does not decide the file's group; the URL it
    // intercepts does, below. Its match still counts against the typo check.
    if (winner === undefined || isInterceptionTemplate(entry.template)) {
      continue;
    }
    const incumbent = winningIndexOfEntrypoint.get(entry.entrypointId);
    if (incumbent === undefined || winner < incumbent) {
      winningIndexOfEntrypoint.set(entry.entrypointId, winner);
      groupOfEntrypoint.set(entry.entrypointId, patterns[winner].group);
    }
  }

  // A pattern matching nothing is a typo, and a typo here is invisible: the
  // route stays in the default group and the split silently does less than it
  // was asked to. Cheap to catch, so catch it.
  for (const group of groups) {
    for (const route of group.routes) {
      if (!matchedPatterns.has(`${group.name}\u0000${route}`)) {
        throw new Error(
          `${ERROR_PREFIX}Group "${group.name}" pattern "${route}" matches no ` +
            `route in this build. ` +
            optionalCatchAllParentHint(route, entries, basePath) +
            `Patterns match route templates as Next.js declares them (e.g. ` +
            `"/blog/[slug]" is matched by "/blog/**"), and prerendered pages and ` +
            `static assets are served from S3 and need no group.`,
        );
      }
    }
  }

  const edge: EdgeOptions = {
    ...edgeBase,
    // Only a group that owns a Pages Router page has data URLs to route. Read
    // before interception moves files: those are App Router, never pages.
    dataRouteGroups: new Set(
      entries
        .filter((entry) => entry.type === "page")
        .map(
          (entry) =>
            groupOfEntrypoint.get(entry.entrypointId) ?? DEFAULT_FUNCTION_GROUP,
        ),
    ),
  };
  reassignInterceptingFiles(
    entries,
    groupOfEntrypoint,
    edgeBehaviors(
      groups,
      templatesByGroup(groups, entries, groupOfEntrypoint),
      edge,
    ),
    edge,
  );
  const assigned = templatesByGroup(groups, entries, groupOfEntrypoint);
  // Rebuilt rather than reused: an intercepting file never adds an optional
  // catch-all parent, so this is the same list, but only by that argument.
  const behaviors = edgeBehaviors(groups, assigned, edge);
  const router: Router = {
    fileOfTemplate: fileOfTemplate(entries),
    routing: options.routing,
  };
  assertEdgeReachesEveryFile(
    entries,
    groupOfEntrypoint,
    behaviors,
    edge,
    router,
  );
  assertRewritesStayInGroup(groupOfEntrypoint, behaviors, router);

  for (const key of Object.keys(assigned)) {
    assigned[key] = [...assigned[key]].sort();
  }
  return {
    templates: assigned,
    behaviors: behaviors.map(({ group, route, pattern }) => ({
      group,
      route,
      pattern,
    })),
  };
}

/**
 * The patterns a group is *routed* on: the ones it declares, plus the parent
 * path of every optional catch-all a subtree pattern moved into it.
 *
 * `/blog/[[...slug]]` serves `/blog` as well as everything under it, and
 * `/blog/**` moves the whole file — but deploys as `blog/*`, which does not
 * match `/blog`. So the parent is routed automatically, as an exact pattern of
 * its own; declaring `/blog` by hand is a pattern with no route of its own and
 * is rejected as a typo, with a hint pointing here. Nothing else a subtree owns
 * needs this: a file whose parent URL is its subtree's base can only be an
 * optional catch-all, since Next.js rejects `app/blog/page.tsx` next to it.
 *
 * @param ownedTemplates the templates assigned to the group, basePath-prefixed
 *   as `manifest.groups` records them
 */
export function routedPatterns(
  routes: readonly string[],
  ownedTemplates: readonly string[],
  basePath: string,
): string[] {
  const result = [...routes];
  for (const route of routes) {
    if (!route.endsWith(SUBTREE_SUFFIX)) {
      continue;
    }
    const parent = route.slice(0, -SUBTREE_SUFFIX.length);
    const prefix = `${prefixBasePath(parent, basePath)}/`;
    const ownsOptionalCatchAll = ownedTemplates.some(
      (template) =>
        template.startsWith(prefix) &&
        OPTIONAL_CATCH_ALL_SEGMENT.test(template.slice(prefix.length)),
    );
    if (ownsOptionalCatchAll && !result.includes(parent)) {
      result.push(parent);
    }
  }
  return result;
}

/**
 * CloudFront path patterns for one group pattern, without a leading slash —
 * the form `NextjsDistribution.getPathPattern` expects, so the basePath is
 * added there rather than here.
 *
 * Two patterns come back when the group owns a Pages Router route: its RSC-era
 * equivalent is a second URL space, `/_next/data/<buildId>/<route>.json`, which
 * the default behavior would otherwise send to the default group.
 *
 * A third comes back for an exact route in a `trailingSlash` app, where the
 * canonical URL is `/pricing/` rather than `/pricing`: the bare pattern does not
 * match it, so without this every request for the route the user actually links to
 * falls through to the default group's function — which, for a Pages Router API
 * route, has no entrypoint for it at all. Subtree patterns need no variant
 * (`pricing/*` already matches `/pricing/`), and neither do the data URLs, which
 * never carry the slash.
 */
export function pathPatternsFor(
  route: string,
  options: {
    hasDataRoutes: boolean;
    trailingSlash?: boolean;
    buildId?: string;
  },
): string[] {
  const isSubtree = route.endsWith(SUBTREE_SUFFIX);
  const base = isSubtree ? route.slice(0, -SUBTREE_SUFFIX.length) : route;
  const bare = base.replace(/^\//, "");
  const patterns = [isSubtree ? `${bare}/*` : bare];
  if (!isSubtree && options.trailingSlash && bare) {
    patterns.push(`${bare}/`);
  }
  if (options.hasDataRoutes) {
    // The literal build ID, not a `*` for it. CloudFront's `*` also matches
    // `/`, so `_next/data/*/blog/*` claimed `/_next/data/<id>/docs/blog/x.json`
    // too — another group's page, sent to a function without it. Every other
    // pattern is anchored at the start of the path; this one now is as well.
    //
    // It makes these behaviors change whenever the build ID does, which is every
    // deploy unless `deploymentId` pins it. A client still holding the previous
    // build requests `/_next/data/<old id>/…`, which no behavior matches, so it
    // reaches the default function. That is correct rather than merely
    // harmless: `next start` 404s a data request for another build ID
    // (`handleNextDataRequest` in `next/dist/server/base-server.js`) and so does
    // the runtime, which has no pathname for it, and the Pages Router client
    // treats a data 404 as an asset error and hard-navigates to the page
    // (`fetchNextData` → `markAssetError` → `handleRouteInfoError` in
    // `next/dist/shared/lib/router/router.js`), which gets the new build.
    patterns.push(
      isSubtree
        ? `_next/data/${dataBuildId(options.buildId)}/${bare}/*`
        : `_next/data/${dataBuildId(options.buildId)}/${bare}.json`,
    );
  }
  return patterns;
}

/**
 * Rank a CloudFront path pattern so the most specific is added first: literal
 * segments before the first `*` dominate, then an exact pattern before a
 * wildcard one, then total segments, then length. {@link edgeBehaviors} sorts
 * on it.
 *
 * Ranking on the leading literal is what a CloudFront wildcard forces, because
 * it matches across `/` rather than within one segment: an exact `a/b` has to
 * precede the subtree `a/*` that would otherwise swallow it, though the two are
 * the same length and depth. At equal literal depth the exact one still goes
 * first, since a trailingSlash `a/b/` is otherwise outranked by the subtree
 * `a/b/*`, one segment longer, that matches it. Since the data patterns carry
 * the literal build ID, no pattern has a wildcard anywhere but at its end.
 */
function behaviorSpecificity(pattern: string): number {
  const segments = pattern.split("/").filter(Boolean);
  const firstWildcard = segments.findIndex((segment) => segment.includes("*"));
  const literalDepth = firstWildcard === -1 ? segments.length : firstWildcard;
  const exact = firstWildcard === -1 ? 1 : 0;
  return (
    (literalDepth * 2 + exact) * 1000000 +
    segments.length * 10000 +
    pattern.length
  );
}

/**
 * The build ID as it goes into a path pattern. A custom `generateBuildId` can
 * return anything, and a character CloudFront cannot spell would otherwise fail
 * the deploy naming neither the build ID nor the group.
 */
function dataBuildId(buildId: string | undefined): string {
  if (!buildId) {
    throw new Error(
      `${ERROR_PREFIX}Routing a Pages Router app's "/_next/data/<buildId>/…" ` +
        `URLs needs its build ID, and none was passed. This is a cdk-nextjs ` +
        `bug: the build ID comes from the adapter manifest.`,
    );
  }
  const invalid = [...new Set(buildId)].filter(
    (char) => !PATH_PATTERN_LITERAL.test(char) || char === "/",
  );
  if (invalid.length > 0) {
    throw new Error(
      `${ERROR_PREFIX}The build ID "${buildId}" contains ` +
        `${invalid.map((char) => JSON.stringify(char)).join(", ")}, which a ` +
        `CloudFront path pattern cannot hold, so its "/_next/data" URLs cannot ` +
        `be routed to a group. Make \`generateBuildId\` return only A-Z a-z ` +
        `0-9 _ - . characters.`,
    );
  }
  return buildId;
}

/**
 * The typo check's hint for the one exact pattern that was the documented
 * workaround: the parent of an optional catch-all, which has no template.
 */
function optionalCatchAllParentHint(
  route: string,
  entries: readonly RouteEntry[],
  basePath: string,
): string {
  if (route.endsWith(SUBTREE_SUFFIX)) {
    return "";
  }
  const prefix = `${prefixBasePath(route, basePath)}/`;
  const catchAll = entries.find(
    (entry) =>
      entry.template.startsWith(prefix) &&
      OPTIONAL_CATCH_ALL_SEGMENT.test(entry.template.slice(prefix.length)),
  );
  if (!catchAll) {
    return "";
  }
  return (
    `"${route}" is served by the optional catch-all "${catchAll.template}", ` +
    `whose subtree pattern "${route}${SUBTREE_SUFFIX}" routes "${route}" as ` +
    `well — use that instead. `
  );
}

/** `/blog/[[...slug]]`'s last segment. */
const OPTIONAL_CATCH_ALL_SEGMENT = /^\[\[\.\.\.[^\]/]+\]\]$/;

/**
 * Next.js's interception markers, longest-overlapping first, exactly as
 * `INTERCEPTION_ROUTE_MARKERS` in
 * `next/dist/shared/lib/router/utils/interception-routes.js` orders them.
 */
const INTERCEPTION_MARKERS = ["(..)(..)", "(.)", "(..)", "(...)"];

function interceptionMarkerOf(path: string): string | undefined {
  for (const segment of path.split("/")) {
    const marker = INTERCEPTION_MARKERS.find((it) => segment.startsWith(it));
    if (marker) {
      return marker;
    }
  }
  return undefined;
}

function isInterceptionTemplate(template: string): boolean {
  return interceptionMarkerOf(template) !== undefined;
}

/**
 * The route an interception route intercepts: `/feed/(..)photo/[id]` →
 * `/photo/[id]`. `extractInterceptionRouteInformation` from
 * `next/dist/shared/lib/router/utils/interception-routes.js`, restated because
 * this file is bundled without `next`. The template is already a normalized app
 * path (no route groups, no `@slot`s), so none of its normalization is needed.
 * Next.js's interception rewrite matches exactly this path, and only with a
 * `Next-Url` header — which CloudFront does not route on.
 */
export function interceptedRoute(path: string): string | undefined {
  const marker = interceptionMarkerOf(path);
  if (marker === undefined) {
    return undefined;
  }
  const at = path.indexOf(marker);
  const intercepting = path.slice(0, at).split("/").filter(Boolean);
  const rest = path
    .slice(at + marker.length)
    .split("/")
    .filter(Boolean);
  const parent =
    marker === "(.)"
      ? intercepting
      : marker === "(..)"
        ? intercepting.slice(0, -1)
        : marker === "(..)(..)"
          ? intercepting.slice(0, -2)
          : [];
  return `/${[...parent, ...rest].join("/")}`;
}

/**
 * Templates that name what a request is *rewritten* to inside Next.js, never
 * what the browser asks for: the RSC payload (`/pricing.rsc`) and segment
 * prefetches (`/pricing.segments/…`) are requested as `/pricing` with an `RSC`
 * header, which is why `pricing` alone has always routed them.
 */
function isInternalTemplate(path: string): boolean {
  return path.endsWith(".rsc") || path.includes(".segments/");
}

/** What the edge routes on. */
interface EdgeOptions {
  /** With a leading slash, `""` for none. */
  readonly basePath: string;
  readonly buildId?: string;
  readonly trailingSlash: boolean;
  /** The groups that own a Pages Router page, and so have data URLs. */
  readonly dataRouteGroups: ReadonlySet<string>;
}

/** A {@link GroupBehavior}, with the regex CloudFront matches it as. */
interface EdgeBehavior extends GroupBehavior {
  readonly regex: RegExp;
}

/**
 * Every group behavior, most specific first: the order CloudFront has to see
 * them in, since it stops at the first match. The assignment returns this list
 * and the constructs deploy it as it is.
 */
function edgeBehaviors(
  groups: readonly FunctionGroupSpec[],
  assigned: Record<string, string[]>,
  edge: EdgeOptions,
): EdgeBehavior[] {
  return groups
    .flatMap((group) =>
      routedPatterns(
        group.routes,
        assigned[group.name] ?? [],
        edge.basePath,
      ).flatMap((route) =>
        pathPatternsFor(route, {
          trailingSlash: edge.trailingSlash,
          buildId: edge.buildId,
          hasDataRoutes: edge.dataRouteGroups.has(group.name),
        }).map((pattern) => ({
          group: group.name,
          route,
          pattern,
          regex: cloudFrontPatternRegex(`${edge.basePath}/${pattern}`),
        })),
      ),
    )
    .sort(
      (a, b) => behaviorSpecificity(b.pattern) - behaviorSpecificity(a.pattern),
    );
}

/**
 * CloudFront path pattern matching: anchored at both ends, `*` for any run of
 * characters `/` included, `?` for exactly one, case-sensitive. `pattern` has to
 * carry the leading slash CloudFront implies.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesPathPattern
 */
export function cloudFrontPatternRegex(pattern: string): RegExp {
  const source = [...pattern]
    .map((char) =>
      char === "*"
        ? ".*"
        : char === "?"
          ? "."
          : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}

/** The behavior CloudFront would pick for `url`, `undefined` for the default one. */
function edgeBehaviorFor(
  behaviors: readonly EdgeBehavior[],
  url: string,
): EdgeBehavior | undefined {
  return behaviors.find((behavior) => behavior.regex.test(url));
}

function templatesByGroup(
  groups: readonly FunctionGroupSpec[],
  entries: readonly RouteEntry[],
  groupOfEntrypoint: ReadonlyMap<string, string>,
): Record<string, string[]> {
  const assigned: Record<string, string[]> = {
    [DEFAULT_FUNCTION_GROUP]: [],
  };
  for (const group of groups) {
    assigned[group.name] = [];
  }
  for (const entry of entries) {
    const group =
      groupOfEntrypoint.get(entry.entrypointId) ?? DEFAULT_FUNCTION_GROUP;
    assigned[group].push(entry.template);
  }
  return assigned;
}

/**
 * Put each intercepting file in the group of the URL it intercepts.
 *
 * With `/feed/**` grouped, `app/feed/(..)photo/[id]/page.tsx` matched it and
 * moved to the feed group. But the soft navigation it exists for requests
 * `/photo/1` with a `Next-Url: /feed` header; CloudFront routes on the URL alone,
 * so the request reaches whichever function owns `/photo/*`, where Next.js's
 * interception rewrite (a `beforeFiles` rule on that header) resolves it to the
 * intercepting file — which that function did not have.
 *
 * Moving the file there is always possible unless the intercepted URL space is
 * itself split: `/photo/[id]` in the default group with `/photo/1` grouped
 * elsewhere would need the file in both. That throws.
 */
function reassignInterceptingFiles(
  entries: readonly RouteEntry[],
  groupOfEntrypoint: Map<string, string>,
  behaviors: readonly EdgeBehavior[],
  edge: EdgeOptions,
): void {
  for (const entry of entries) {
    const path = stripBasePath(entry.template, edge.basePath);
    if (path === undefined || isInternalTemplate(path)) {
      continue;
    }
    const target = interceptedRoute(path);
    if (target === undefined) {
      continue;
    }
    const url = withBasePath(target, edge.basePath);
    const group =
      edgeBehaviorFor(behaviors, url)?.group ?? DEFAULT_FUNCTION_GROUP;
    const intercepted = templateRegex(url);
    const split = behaviors.find(
      (behavior) =>
        behavior.group !== group &&
        !behavior.pattern.startsWith("_next/data/") &&
        sampleUrl(behavior.route, edge.basePath).some((it) =>
          intercepted.test(it),
        ),
    );
    if (split) {
      throw new Error(
        `${ERROR_PREFIX}"${entry.entrypointId}" is the interception route ` +
          `"${entry.template}", which Next.js reaches by rewriting a request for ` +
          `"${url}" inside whichever function CloudFront sent it to — so it is ` +
          `packaged with the group that owns "${url}". That URL space is split, ` +
          `though: most of it reaches ${groupLabel(group)}, but group ` +
          `"${split.group}"'s pattern "${split.route}" claims part of it, and ` +
          `one file cannot be in both. Route all of "${target}" to one group.`,
      );
    }
    groupOfEntrypoint.set(entry.entrypointId, group);
  }
}

/** A URL a group pattern routes, to test against another route's URL space. */
function sampleUrl(route: string, basePath: string): string[] {
  return route.endsWith(SUBTREE_SUFFIX)
    ? [`${basePath}${route.slice(0, -SUBTREE_SUFFIX.length)}/_`]
    : [`${basePath}${route}`];
}

/** The URLs a template stands for, as a regex: `[id]` is one segment, and so on. */
function templateRegex(template: string): RegExp {
  const source = template
    .split("/")
    .filter(Boolean)
    .map(
      (segment) =>
        [
          `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "/[^/]+",
          "/.+",
          "(?:/.+)?",
        ][segmentKind(segment)],
    )
    .join("");
  return new RegExp(`^${source || "/"}$`);
}

/**
 * Throw unless every URL each file serves reaches the group holding it.
 *
 * Checked for every file, the default group's included: the invariant is "the
 * edge never sends a request to a function without its file", and a group
 * pattern can break it by claiming a URL of a file left in the default group as
 * easily as by leaving one behind. A dynamic template stands for a URL space,
 * not one URL, so it is also checked against the part of that space other
 * groups' patterns capture ({@link capturedDynamicUrls}): a `/[...slug]` left in
 * the default group answers `/blog/a/b` too, which `/blog/**` sends elsewhere.
 *
 * Only the URLs as Next.js spells them are replayed, and that is a known gap
 * rather than an oversight: CloudFront path patterns and API Gateway resources
 * both match case-sensitively, while `@next/routing` matches templates
 * case-insensitively. `/API/reports/1` therefore misses a `/api/reports/**`
 * group and reaches the default function, which resolves it to a template it
 * does not have. Neither edge can be told to fold case, and lowercasing at the
 * edge would break the case-sensitive S3 keys behind `public/`, so there is
 * nothing to check here that could pass; the runtime answers such a request
 * itself (see `ownedRouteError`).
 */
function assertEdgeReachesEveryFile(
  entries: readonly RouteEntry[],
  groupOfEntrypoint: ReadonlyMap<string, string>,
  behaviors: readonly EdgeBehavior[],
  edge: EdgeOptions,
  router: Router,
): void {
  const files = new Map<string, RouteEntry[]>();
  for (const entry of entries) {
    const list = files.get(entry.entrypointId) ?? [];
    list.push(entry);
    files.set(entry.entrypointId, list);
  }
  // Deep enough for a sample to get past every template a capturing group
  // could shadow it with.
  const deepest =
    Math.max(
      0,
      ...entries.map((entry) => {
        const path = stripBasePath(entry.template, edge.basePath);
        return path !== undefined && isRoutablePath(path)
          ? path.split("/").filter(Boolean).length
          : 0;
      }),
    ) + 1;
  for (const [file, fileEntries] of files) {
    const owner = groupOfEntrypoint.get(file) ?? DEFAULT_FUNCTION_GROUP;
    const misrouted: Misroute[] = [];
    for (const entry of fileEntries) {
      for (const url of servedUrls(entry.template, entry.type, edge)) {
        const behavior = edgeBehaviorFor(behaviors, url);
        const group = behavior?.group ?? DEFAULT_FUNCTION_GROUP;
        if (group !== owner && !misrouted.some((it) => it.url === url)) {
          misrouted.push({ url, group, route: behavior?.route });
        }
      }
      for (const it of capturedDynamicUrls(
        entry,
        owner,
        deepest,
        behaviors,
        edge,
        router,
      )) {
        if (!misrouted.some((known) => known.url === it.url)) {
          misrouted.push(it);
        }
      }
    }
    if (misrouted.length > 0) {
      throw new Error(misroutedFileMessage(file, owner, misrouted, edge));
    }
  }
}

interface Misroute {
  readonly url: string;
  /** Where CloudFront sends it. */
  readonly group: string;
  /** The pattern that sent it there, `undefined` for the default behavior. */
  readonly route?: string;
  /**
   * Set when `url` is a sample of a dynamic template's URL space rather than
   * a URL the template spells: the template Next.js resolves it to there.
   */
  readonly servedAs?: string;
}

/**
 * Stands in for "any value" of a dynamic segment in a sample URL. A literal
 * template of that exact name would shadow it, which can only hide a misroute,
 * never invent one.
 */
const ANY_SEGMENT = "_";

/**
 * Whether a request can resolve to `path` (basePath stripped) directly: not an
 * RSC or segment rewrite, an interception route, or a data-URL alias (a data URL
 * resolves to the page it names).
 */
function isRoutablePath(path: string): boolean {
  return (
    !isInternalTemplate(path) &&
    !isInterceptionTemplate(path) &&
    !path.startsWith("/_next/data/")
  );
}

/** 0 static, 1 `[param]`, 2 `[...catchAll]`, 3 `[[...optional]]`. */
function segmentKind(segment: string): number {
  if (OPTIONAL_CATCH_ALL_SEGMENT.test(segment)) {
    return 3;
  }
  if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
    return 2;
  }
  return /^\[[^\]]+\]$/.test(segment) ? 1 : 0;
}

/**
 * The URLs of a *dynamic* template's space that another group's behavior
 * captures, and that Next.js — running in that group's function — still
 * resolves to this template's file.
 *
 * `servedUrls` replays the template as spelled, which is exact for a static
 * route but not for `/[...slug]`: the text `/[...slug]` never matches `blog/*`,
 * yet `/blog/a/b` does, reaches the blog function, and resolves there to
 * `/[...slug]`, which the blog zip lacks. So each other group's behavior is
 * intersected with the template's URL space, one sample URL per shape
 * ({@link sampleTemplatePaths}), and each sample is resolved the way Next.js
 * resolves it ({@link resolveFile}). A more specific template in the capturing
 * group legitimately shadows the sample (`/blog/[slug]` answers `/blog/_`, so
 * only `/blog/_/_` is a misroute); anything it does not shadow is flagged.
 */
function capturedDynamicUrls(
  entry: RouteEntry,
  owner: string,
  deepest: number,
  behaviors: readonly EdgeBehavior[],
  edge: EdgeOptions,
  router: Router,
): Misroute[] {
  const path = stripBasePath(entry.template, edge.basePath);
  if (
    path === undefined ||
    !path.includes("[") ||
    ERROR_PAGE_SUFFIXES.includes(path) ||
    !isRoutablePath(path)
  ) {
    return [];
  }
  const segments = path.split("/").filter(Boolean);
  const samples = new Set<string>();
  for (const behavior of behaviors) {
    if (
      behavior.group === owner ||
      behavior.pattern.startsWith("_next/data/")
    ) {
      continue;
    }
    const bare = behavior.pattern.replace(/\/$/, "");
    const isSubtree = bare.endsWith("/*");
    const prefix = (isSubtree ? bare.slice(0, -2) : bare)
      .split("/")
      .filter(Boolean);
    for (const sample of sampleTemplatePaths(
      segments,
      prefix,
      isSubtree,
      Math.max(deepest, prefix.length + 1),
    )) {
      samples.add(sample);
    }
  }
  const misrouted: Misroute[] = [];
  // `resolved` is `url` as Next.js matches it: without the trailing slash.
  const check = (url: string, resolved: string) => {
    const behavior = edgeBehaviorFor(behaviors, url);
    const group = behavior?.group ?? DEFAULT_FUNCTION_GROUP;
    if (group === owner || misrouted.some((it) => it.url === url)) {
      return;
    }
    if (resolveFile(resolved, router) === entry.entrypointId) {
      misrouted.push({
        url,
        group,
        route: behavior?.route,
        servedAs: entry.template,
      });
    }
  };
  for (const sample of samples) {
    for (const { url, resolved } of urlVariants(sample, entry.type, edge)) {
      check(url, resolved);
    }
  }
  return misrouted;
}

/**
 * Sample paths in both a template's URL space and a behavior's: for a subtree
 * `prefix/*`, every way the template's segments can line up with `prefix` and
 * continue past it, one sample per resulting length up to `maxDepth`, with
 * {@link ANY_SEGMENT} for each dynamic value beyond the prefix. For an exact
 * pattern, the pattern's own path if the template matches it.
 */
function sampleTemplatePaths(
  template: readonly string[],
  prefix: readonly string[],
  isSubtree: boolean,
  maxDepth: number,
): string[] {
  if (!isSubtree) {
    const path = `/${prefix.join("/")}`;
    return templateRegex(`/${template.join("/")}`).test(path) ? [path] : [];
  }
  const valueAt = (at: number) =>
    at < prefix.length ? prefix[at] : ANY_SEGMENT;
  const results: string[] = [];
  const walk = (index: number, acc: readonly string[]): void => {
    if (index === template.length) {
      // Exactly the prefix is kept too: `prefix/*` matches its trailing-slash
      // form, which `check` adds for a `trailingSlash` app.
      if (acc.length >= prefix.length) {
        results.push(`/${acc.join("/")}`);
      }
      return;
    }
    const segment = template[index];
    const at = acc.length;
    const kind = segmentKind(segment);
    if (kind === 0) {
      if (at >= prefix.length || prefix[at] === segment) {
        walk(index + 1, [...acc, segment]);
      }
      return;
    }
    if (kind === 1) {
      walk(index + 1, [...acc, valueAt(at)]);
      return;
    }
    for (let count = kind === 2 ? 1 : 0; at + count <= maxDepth; count++) {
      const taken = Array.from({ length: count }, (_, i) => valueAt(at + i));
      walk(index + 1, [...acc, ...taken]);
    }
  };
  walk(0, []);
  return results;
}

/**
 * The URLs one template's file answers at the edge.
 *
 * Nothing for the error pages (every group stages them), the RSC and
 * segment-prefetch rewrites (requested at the page's own URL), and interception
 * routes (reached only through the intercepted URL's rewrite). Otherwise the
 * template itself, an optional catch-all's parent, and for each of those the
 * `trailingSlash` form and a Pages Router page's data URL. Only the slash-less
 * data URL: the client never adds one.
 */
function servedUrls(
  template: string,
  type: string | undefined,
  edge: EdgeOptions,
): string[] {
  const path = stripBasePath(template, edge.basePath);
  if (
    path === undefined ||
    ERROR_PAGE_SUFFIXES.includes(path) ||
    isInternalTemplate(path) ||
    isInterceptionTemplate(path)
  ) {
    return [];
  }
  if (path.startsWith("/_next/data/")) {
    return [template];
  }
  const paths = [path];
  const optional = /^(.*)\/(\[\[\.\.\.[^\]/]+\]\])$/.exec(path);
  if (optional) {
    paths.push(optional[1] || "/");
  }
  return paths.flatMap((it) =>
    urlVariants(it, type, edge).map(({ url }) => url),
  );
}

/**
 * A path's URL, its `trailingSlash` form and a Pages Router page's data URL,
 * each with `resolved`: the URL as Next.js matches it, without the trailing slash.
 */
function urlVariants(
  path: string,
  type: string | undefined,
  edge: EdgeOptions,
): { url: string; resolved: string }[] {
  const url = withBasePath(path, edge.basePath);
  const variants = [{ url, resolved: url }];
  if (edge.trailingSlash && path !== "/") {
    variants.push({ url: `${url}/`, resolved: url });
  }
  if (type === "page" && edge.buildId) {
    const data = `${edge.basePath}/_next/data/${edge.buildId}${path === "/" ? "/index" : path}.json`;
    variants.push({ url: data, resolved: data });
  }
  return variants;
}

function misroutedFileMessage(
  file: string,
  owner: string,
  misrouted: readonly Misroute[],
  edge: EdgeOptions,
): string {
  const where = misrouted
    .map(
      (it) =>
        `"${it.url}" to ${groupLabel(it.group)}` +
        (it.route ? ` (its pattern "${it.route}")` : ""),
    )
    .join(", ");
  const head =
    `${ERROR_PREFIX}"${file}" is packaged into ${groupLabel(owner)}, but ` +
    `CloudFront would send ${where}, whose function does not have it: a 404 on ` +
    `every such request. Every URL one file serves has to reach the group that ` +
    `holds the file.`;
  const captured = misrouted.filter((it) => it.servedAs !== undefined);
  if (captured.length > 0) {
    const templates = [...new Set(captured.map((it) => `"${it.servedAs}"`))];
    return (
      `${head} Those URLs are part of the dynamic route ` +
      `${templates.join(", ")} ("${ANY_SEGMENT}" stands for any segment ` +
      `value): the pattern captures them at the edge, and no route packaged ` +
      `into the capturing group is more specific, so Next.js still resolves ` +
      `them to this file. Give that group a route that answers them (a ` +
      `catch-all under its pattern, say), or narrow the pattern.`
    );
  }
  if (owner === DEFAULT_FUNCTION_GROUP) {
    return (
      `${head} A pattern claims a URL of a file that no pattern moved: narrow ` +
      `it, or give the group the file's other routes too.`
    );
  }
  const unroutable = misrouted.filter(
    (it) => suggestedPattern(it.url, edge) === undefined,
  );
  if (unroutable.length > 0) {
    return (
      `${head} ${unroutable.map((it) => `"${it.url}"`).join(", ")} cannot be ` +
      `routed to any group — CloudFront has no pattern for the home page alone, ` +
      `and a dynamic first segment would need "/**" — so this file can only be ` +
      `served by the "${DEFAULT_FUNCTION_GROUP}" group. Remove the pattern that ` +
      `moved it. (A Pages Router home page is also "/index": one file.)`
    );
  }
  const suggestions = [
    ...new Set(misrouted.map((it) => suggestedPattern(it.url, edge)!)),
  ];
  return (
    `${head} Add ${suggestions.map((it) => `"${it}"`).join(", ")} to group ` +
    `"${owner}"'s routes.`
  );
}

/**
 * The group pattern that would route `url`, `undefined` when none can: a static
 * path routes as itself, a dynamic one as the subtree above its first dynamic
 * segment, and a data URL or `trailingSlash` form as the page it belongs to.
 */
function suggestedPattern(url: string, edge: EdgeOptions): string | undefined {
  let path = stripBasePath(url, edge.basePath) ?? url;
  const dataPrefix = `/_next/data/${edge.buildId}/`;
  if (path.startsWith(dataPrefix) && path.endsWith(".json")) {
    path = `/${path.slice(dataPrefix.length, -".json".length)}`;
    path = path === "/index" ? "/" : path;
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  const segments = path.split("/").filter(Boolean);
  const firstDynamic = segments.findIndex((segment) => segment.startsWith("["));
  if (segments.length === 0 || firstDynamic === 0) {
    return undefined;
  }
  return firstDynamic === -1
    ? path
    : `/${segments.slice(0, firstDynamic).join("/")}${SUBTREE_SUFFIX}`;
}

/**
 * Throw on a `next.config` rewrite whose source reaches one group and whose
 * destination is packaged into another.
 *
 * A rewrite runs inside the function that received the request, so
 * `/old/:path*` → `/new` with `/new/**` grouped and `/old` not sends `/old/x` to
 * the default function, which rewrites it to a file it lacks.
 *
 * Only the rewrites whose destination is a literal path can be resolved to a
 * file here; one built from the source's parameters (`/blog/:slug` →
 * `/posts/:slug`) is skipped, as are external ones. The source is checked at the
 * granularity of its literal prefix: each parameter stands in as a dynamic
 * segment. Rewrites done by middleware (`NextResponse.rewrite`) are code, not
 * config, and cannot be checked at all.
 */
function assertRewritesStayInGroup(
  groupOfEntrypoint: ReadonlyMap<string, string>,
  behaviors: readonly EdgeBehavior[],
  router: Router,
): void {
  const { routing } = router;
  const phases: [readonly RewriteRule[] | undefined, boolean][] = [
    [routing.beforeFiles, false],
    // `afterFiles` and `fallback` only apply when no file matched the URL, so a
    // source that is itself a route never reaches the destination.
    [routing.afterFiles, true],
    [routing.fallback, true],
  ];
  for (const [rules, yieldsToFiles] of phases) {
    for (const rule of rules ?? []) {
      const destination = literalDestination(rule.destination);
      // Next.js's own interception rewrites are here too, on `Next-Url`;
      // `reassignInterceptingFiles` has already put their files in place.
      if (destination === undefined || isInterceptionTemplate(destination)) {
        continue;
      }
      const file = resolveFile(destination, router);
      if (file === undefined) {
        continue;
      }
      const target = groupOfEntrypoint.get(file) ?? DEFAULT_FUNCTION_GROUP;
      for (const url of rewriteSourceUrls(rule.source)) {
        if (yieldsToFiles && router.fileOfTemplate.has(url)) {
          continue;
        }
        const behavior = edgeBehaviorFor(behaviors, url);
        const group = behavior?.group ?? DEFAULT_FUNCTION_GROUP;
        if (group === target) {
          continue;
        }
        throw new Error(
          `${ERROR_PREFIX}The next.config rewrite from "${rule.source}" to ` +
            `"${rule.destination}" crosses groups: CloudFront sends "${url}" to ` +
            `${groupLabel(group)}` +
            (behavior ? ` (its pattern "${behavior.route}")` : "") +
            `, and Next.js then serves it with "${file}", which is packaged ` +
            `into ${groupLabel(target)}. A rewrite is applied inside the ` +
            `function that received the request, so its source and its ` +
            `destination have to be routed to the same group.`,
        );
      }
    }
  }
}

/** A rewrite destination's pathname, `undefined` unless it is a literal local path. */
function literalDestination(
  destination: string | undefined,
): string | undefined {
  if (!destination?.startsWith("/")) {
    return undefined;
  }
  const pathname = destination.split(/[?#]/)[0];
  if (/[$:]/.test(pathname)) {
    return undefined;
  }
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
}

/** What {@link resolveFile} resolves against. */
interface Router {
  /** Template → the file behind it, less the RSC and segment rewrites. */
  readonly fileOfTemplate: ReadonlyMap<string, string>;
  readonly routing: RoutingRules;
}

function fileOfTemplate(entries: readonly RouteEntry[]): Map<string, string> {
  return new Map(
    entries
      .filter((entry) => !isInternalTemplate(entry.template))
      .map((entry) => [entry.template, entry.entrypointId]),
  );
}

/**
 * The file Next.js serves `pathname` with: a template of that exact name, or
 * else the first of Next.js's own dynamic route rules that matches — matched
 * case-insensitively, as `resolveRoutes` does. `dynamicRoutes` is in Next.js's
 * priority order (static segment before `[param]` before `[...catchAll]`
 * before `[[...optional]]`), Pages Router data URLs included.
 *
 * A destination's positional captures are filled in from the match first: next
 * 16.4's `collapseAdapterRoutes` folds a run of fallback shells (`/en/[slug]`,
 * `/fr/[slug]`) into one rule whose destination is `/$1/[slug]`.
 */
function resolveFile(
  pathname: string,
  { fileOfTemplate: files, routing }: Router,
): string | undefined {
  const exact = files.get(pathname);
  if (exact !== undefined) {
    return exact;
  }
  for (const route of routing.dynamicRoutes ?? []) {
    const match = new RegExp(route.sourceRegex, "i").exec(pathname);
    if (match) {
      const template = route.destination?.split("?")[0].replace(
        /\$([1-9]\d*)/g,
        // A group that matched nothing (an absent `.rsc` suffix) is "", as
        // in `replaceDestination`; an index past the last group stays as is.
        (literal, index: string) =>
          Number(index) < match.length ? (match[Number(index)] ?? "") : literal,
      );
      const file = template === undefined ? undefined : files.get(template);
      // A destination that names no file is passed over, as `resolveRoutes`
      // does: a collapsed rule matched case-insensitively fills in `/EN/[slug]`.
      if (file !== undefined) {
        return file;
      }
    }
  }
  return undefined;
}

/**
 * The URL shapes a path-to-regexp rewrite source matches, as template-like
 * paths: each literal segment kept, each parameter replaced by `[name]`, and —
 * when the last one is optional (`:path*`, `:slug?`) — the path without it too.
 */
function rewriteSourceUrls(source: string | undefined): string[] {
  if (!source?.startsWith("/")) {
    return [];
  }
  const segments: string[] = [];
  let optionalFrom: number | undefined;
  for (const segment of source.split("/").slice(1)) {
    if (!/[:()*?+{}[\]]/.test(segment)) {
      segments.push(segment);
      continue;
    }
    optionalFrom = /^:\w+[*?]$/.test(segment) ? segments.length : undefined;
    segments.push(`[${/:(\w+)/.exec(segment)?.[1] ?? "param"}]`);
  }
  const urls = [`/${segments.join("/")}`];
  if (optionalFrom !== undefined) {
    urls.push(`/${segments.slice(0, optionalFrom).join("/")}`);
  }
  return urls;
}

function groupLabel(group: string): string {
  return group === DEFAULT_FUNCTION_GROUP
    ? `the "${DEFAULT_FUNCTION_GROUP}" group`
    : `group "${group}"`;
}

function prefixBasePath(route: string, basePath: string): string {
  return `${basePathPrefix(basePath)}${route}`;
}

/** `template` without `basePath` (`/` for the base itself), `undefined` if outside it. */
function stripBasePath(template: string, basePath: string): string | undefined {
  if (!basePath) {
    return template;
  }
  return hasPathPrefix(template, basePath)
    ? template.slice(basePath.length) || "/"
    : undefined;
}

function withBasePath(path: string, basePath: string): string {
  return path === "/" ? basePath || "/" : `${basePath}${path}`;
}
