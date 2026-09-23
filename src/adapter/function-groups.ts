/**
 * `functionGroups` resolution: the rules shared by `next build` and synth.
 *
 * Splitting has to be decided twice, in two processes. `onBuildComplete` stages
 * one deployment tree per group while `next build` is still running; the
 * constructs turn the *same* patterns into CloudFront behaviors or API Gateway
 * resources at synth. If the two disagree, CloudFront sends a request to a
 * function whose zip lacks its entrypoint — so the rules live here, once, and
 * both sides call them.
 *
 * Nothing in this file imports `aws-cdk-lib`: it is bundled into the adapter by
 * esbuild. The public JSII struct consumers actually write (`NextjsFunctionGroup`,
 * which adds per-group `overrides`) is in `src/nextjs-compute/nextjs-functions.ts`
 * and is structurally assignable to {@link FunctionGroupSpec}.
 */

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

/**
 * Which group the running function *is*. Set per Lambda at synth, read by the
 * runtime only to make a misroute say so; see `ownedRouteError`.
 */
export const FUNCTION_GROUP_ENV_VAR = "CDK_NEXTJS_FUNCTION_GROUP";

/** The part of a group the build side needs. */
export interface FunctionGroupSpec {
  readonly name: string;
  readonly routes: string[];
}

/** One route template and the entrypoint it invokes. */
export interface RouteEntry {
  /** Basepath-prefixed route template, exactly as `manifest.entrypoints` keys it. */
  readonly template: string;
  /** `AdapterEntrypoint.id`. Two templates sharing one are never split apart. */
  readonly entrypointId: string;
}

const NAME_PATTERN = /^[a-zA-Z0-9-]+$/;
const SUBTREE_SUFFIX = "/**";

/**
 * Read {@link FUNCTION_GROUPS_ENV_VAR}. `undefined` — not the empty array — when
 * unset, because "no splitting" and "split into nothing" are different requests
 * and only the first is valid.
 */
export function parseFunctionGroupsEnv(
  value: string | undefined,
): FunctionGroupSpec[] | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${errorPrefix()}${FUNCTION_GROUPS_ENV_VAR} is not valid JSON: ${error}. ` +
        `It is set by cdk-nextjs itself, so this means something else in the ` +
        `build environment overwrote it.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${errorPrefix()}${FUNCTION_GROUPS_ENV_VAR} must be a JSON array of ` +
        `{ name, routes } objects.`,
    );
  }
  return parsed.map((entry) => {
    const group = entry as Partial<FunctionGroupSpec>;
    if (typeof group.name !== "string" || !Array.isArray(group.routes)) {
      throw new Error(
        `${errorPrefix()}${FUNCTION_GROUPS_ENV_VAR} entry ` +
          `${JSON.stringify(entry)} is not a { name, routes } object.`,
      );
    }
    return { name: group.name, routes: group.routes };
  });
}

/**
 * Splitting and `i18n` are mutually exclusive, and it is a CloudFront limit
 * again.
 *
 * With `i18n` configured, every route template is locale-prefixed
 * (`/en/pricing`, `/de/pricing`), so honoring a `/pricing` group would take one
 * behavior *per locale per pattern* — a budget of 25 behaviors spent in a handful
 * of routes. The alternative, a `*` in the locale position, matches any first
 * segment and would capture routes belonging to other groups. Neither is
 * something to do silently, so refuse instead.
 */
export function assertNoI18nSplitting(i18n: unknown): void {
  if (i18n === null || i18n === undefined) {
    return;
  }
  throw new Error(
    `${errorPrefix()}\`functionGroups\` cannot be combined with \`i18n\`. ` +
      `With i18n every route is locale-prefixed, so routing a group at the edge ` +
      `would need one CloudFront behavior per locale per pattern, against a ` +
      `limit of 25 for the whole distribution. Deploy one function for every ` +
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
      `${errorPrefix()}\`functionGroups\` is an empty array. Omit the prop ` +
        `entirely to deploy one function for every route, which is the default.`,
    );
  }

  const seenNames = new Set<string>();
  const patternOwner = new Map<string, string>();

  for (const group of groups) {
    if (group.name === DEFAULT_FUNCTION_GROUP) {
      throw new Error(
        `${errorPrefix()}"${DEFAULT_FUNCTION_GROUP}" is a reserved group name: ` +
          `it is the implicit group every unassigned route falls into.`,
      );
    }
    if (!NAME_PATTERN.test(group.name)) {
      throw new Error(
        `${errorPrefix()}Group name "${group.name}" must match ` +
          `${NAME_PATTERN} — it becomes a construct id and part of a Lambda ` +
          `function name.`,
      );
    }
    if (seenNames.has(group.name)) {
      throw new Error(
        `${errorPrefix()}Two groups are both named "${group.name}".`,
      );
    }
    seenNames.add(group.name);

    if (group.routes.length === 0) {
      throw new Error(
        `${errorPrefix()}Group "${group.name}" owns no routes. Every group is a ` +
          `Lambda function, so an empty one would deploy and never be reached.`,
      );
    }
    for (const route of group.routes) {
      validateRoutePattern(route, group.name);
      const owner = patternOwner.get(route);
      if (owner !== undefined) {
        throw new Error(
          `${errorPrefix()}Pattern "${route}" appears in both group "${owner}" ` +
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
      `${errorPrefix()}${where} must start with "/". Patterns are URL paths as ` +
        `the browser requests them.`,
    );
  }
  if (route === "/") {
    throw new Error(
      `${errorPrefix()}${where} cannot be routed. CloudFront has no path ` +
        `pattern that matches only "/" — the default behavior serves it — so the ` +
        `home page always belongs to the "${DEFAULT_FUNCTION_GROUP}" group. ` +
        `Group the routes around it instead.`,
    );
  }
  if (route === SUBTREE_SUFFIX) {
    throw new Error(
      `${errorPrefix()}${where} would own every route, leaving the default ` +
        `group empty. Splitting exists to divide routes between functions; ` +
        `omit \`functionGroups\` to deploy them all in one.`,
    );
  }
  if (/[[\]]/.test(route)) {
    throw new Error(
      `${errorPrefix()}${where} contains a dynamic segment. Patterns become ` +
        `CloudFront behavior path patterns, which support only "*" and "?", so ` +
        `"${route}" could only deploy as a wildcard that also captures its ` +
        `siblings. Use a subtree instead: "/blog/**" owns "/blog/[slug]".`,
    );
  }
  if (/\((.*)\)/.test(route)) {
    throw new Error(
      `${errorPrefix()}${where} contains a route group segment. Route groups ` +
        `like "(marketing)" organize files and never appear in a URL, so they ` +
        `cannot be routed on. Use the URL path the route is served at.`,
    );
  }
  const withoutSubtree = route.endsWith(SUBTREE_SUFFIX)
    ? route.slice(0, -SUBTREE_SUFFIX.length)
    : route;
  if (/[*?]/.test(withoutSubtree)) {
    throw new Error(
      `${errorPrefix()}${where} contains a wildcard somewhere other than a ` +
        `trailing "/**". The only two forms are an exact path ("/pricing") and ` +
        `a subtree ("/api/reports/**").`,
    );
  }
  if (route.includes("//")) {
    throw new Error(`${errorPrefix()}${where} contains an empty path segment.`);
  }
}

/**
 * Split every route template across the groups, longest matching pattern first.
 *
 * Returns a record keyed by group name and always containing
 * {@link DEFAULT_FUNCTION_GROUP}, so callers can iterate it as the complete set
 * of functions to deploy. The default group is allowed to be empty of *templates*
 * — it still serves `/_next/image`, any static file, and anything the
 * distribution's catch-all behavior sends it.
 *
 * `basePath` is prepended to each pattern before matching, because manifest
 * templates are basePath-prefixed and consumers write the routes their app
 * declares.
 */
export function assignRoutesToGroups(
  groups: readonly FunctionGroupSpec[],
  entries: readonly RouteEntry[],
  options: { basePath: string },
): Record<string, string[]> {
  validateFunctionGroups(groups);

  const assigned: Record<string, string[]> = {
    [DEFAULT_FUNCTION_GROUP]: [],
  };
  for (const group of groups) {
    assigned[group.name] = [];
  }

  // Most specific first, so the first match is the winner and "longest wins"
  // needs no second pass. Segment count before string length: "/a/b" is more
  // specific than "/along", and only the segment count is meaningful in a URL.
  const patterns = groups
    .flatMap((group) =>
      group.routes.map((route) => ({
        group: group.name,
        route,
        match: prefixBasePath(route, options.basePath),
      })),
    )
    .sort((a, b) => specificity(b.match) - specificity(a.match));

  const matchedPatterns = new Set<string>();
  // An entrypoint is a *file*; two templates can share one (a Pages Router page
  // and its `/_next/data/<buildId>/…json` sibling). Splitting them across zips
  // would stage the same file twice and route one of them to a function that
  // has it by accident, so ownership is recorded per entrypoint and reused.
  const groupOfEntrypoint = new Map<string, string>();

  for (const entry of entries) {
    const hit = patterns.find((pattern) =>
      matchesPattern(pattern.match, entry.template),
    );
    if (hit) {
      matchedPatterns.add(`${hit.group}\u0000${hit.route}`);
      groupOfEntrypoint.set(entry.entrypointId, hit.group);
    }
  }

  for (const entry of entries) {
    const group =
      groupOfEntrypoint.get(entry.entrypointId) ?? DEFAULT_FUNCTION_GROUP;
    assigned[group].push(entry.template);
  }

  // A pattern matching nothing is a typo, and a typo here is invisible: the
  // route stays in the default group and the split silently does less than it
  // was asked to. Cheap to catch, so catch it.
  for (const group of groups) {
    for (const route of group.routes) {
      if (!matchedPatterns.has(`${group.name}\u0000${route}`)) {
        throw new Error(
          `${errorPrefix()}Group "${group.name}" pattern "${route}" matches no ` +
            `route in this build. Patterns match route templates as Next.js ` +
            `declares them (e.g. "/blog/[slug]" is matched by "/blog/**"), and ` +
            `prerendered pages and static assets are served from S3 and need no ` +
            `group.`,
        );
      }
    }
  }

  for (const key of Object.keys(assigned)) {
    assigned[key] = [...assigned[key]].sort();
  }
  return assigned;
}

/**
 * CloudFront / API Gateway path patterns for one group pattern, without a
 * leading slash — the form `NextjsDistribution.getPathPattern` expects, so the
 * basePath is added there rather than here.
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
  options: { hasDataRoutes: boolean; trailingSlash?: boolean },
): string[] {
  const isSubtree = route.endsWith(SUBTREE_SUFFIX);
  const base = isSubtree ? route.slice(0, -SUBTREE_SUFFIX.length) : route;
  const bare = base.replace(/^\//, "");
  const patterns = [isSubtree ? `${bare}/*` : bare];
  if (!isSubtree && options.trailingSlash && bare) {
    patterns.push(`${bare}/`);
  }
  if (options.hasDataRoutes) {
    // The build ID sits between `_next/data` and the route, and changes every
    // build, so it is the one place a `*` is load-bearing rather than a fallback.
    patterns.push(
      isSubtree ? `_next/data/*/${bare}/*` : `_next/data/*/${bare}.json`,
    );
  }
  return patterns;
}

/** Sort key for "longest matching pattern wins". */
function specificity(pattern: string): number {
  const base = pattern.endsWith(SUBTREE_SUFFIX)
    ? pattern.slice(0, -SUBTREE_SUFFIX.length)
    : pattern;
  // Segments dominate; length only breaks ties between equal-depth patterns.
  return segmentCount(base) * 10000 + base.length;
}

function segmentCount(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/**
 * A subtree owns what is *under* it, not the path itself: `/api/reports/**`
 * becomes CloudFront `api/reports/*`, which does not match `/api/reports`.
 * Claiming the parent too would package a route into a group the edge never
 * routes there. Write both patterns to own both.
 */
function matchesPattern(pattern: string, template: string): boolean {
  if (pattern.endsWith(SUBTREE_SUFFIX)) {
    return template.startsWith(pattern.slice(0, -SUBTREE_SUFFIX.length) + "/");
  }
  return template === pattern;
}

function prefixBasePath(route: string, basePath: string): string {
  if (!basePath) {
    return route;
  }
  return `${basePath.replace(/\/$/, "")}${route}`;
}

/**
 * `LOG_PREFIX` lives in `src/constants.ts`, which the adapter bundle already
 * pulls in — but this file is imported by the constructs too, and the message
 * shape is identical on both sides, so it is inlined rather than shared.
 */
function errorPrefix(): string {
  return "[cdk-nextjs] `functionGroups`: ";
}
