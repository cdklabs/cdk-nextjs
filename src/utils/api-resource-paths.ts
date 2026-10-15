/**
 * API Gateway resource paths for `NextjsApi`'s function groups: which paths
 * each group's routes become, which parents those paths need, and which group
 * — if any — answers each parent. Paths are segment arrays relative to the
 * `basePath` resource.
 */
import {
  assertKnownFunctionGroups,
  GroupBehavior,
  splitGroupRoute,
} from "../adapter/function-groups";
import { LOG_PREFIX } from "../constants";
import { PublicDirEntry } from "../nextjs-build/nextjs-build";

/**
 * What API Gateway accepts as a resource path part, per CDK's own check in
 * `Resource`: `[a-zA-Z0-9:._-$]`, plus an optional trailing `+`.
 */
export const API_PATH_PART = /^[a-zA-Z0-9:._\-$]+$/;

/** A resource path and the group whose `ANY` method it gets. */
export interface ApiRoutePath<T> {
  readonly path: string[];
  readonly owner: T;
}

/**
 * A resource created only as the parent of a route path, and the group that
 * answers it: `undefined` leaves it to the default function.
 */
export interface ApiParentPath<T> {
  readonly path: string[];
  readonly owner: T | undefined;
}

/**
 * The group pattern validation accepts every character a CloudFront path
 * pattern can hold, and API Gateway's path parts hold fewer: `~`, `@`, `+`,
 * `&` and quotes pass it and then fail `addResource` with an error that names
 * neither the group nor the pattern. Say which, and what to do instead.
 */
export function assertApiRoutable(route: string, groupName: string): void {
  const { segments } = splitGroupRoute(route);
  const invalid = segments.find((segment) => !API_PATH_PART.test(segment));
  if (invalid === undefined) {
    return;
  }
  throw new Error(
    `${LOG_PREFIX} functionGroups pattern "${route}" (group "${groupName}") ` +
      `has a segment, "${invalid}", that an API Gateway resource path part ` +
      "cannot hold: only [a-zA-Z0-9:._-$] are allowed. Route that path from " +
      "a pattern higher up the tree (e.g. its parent directory with `/**`), " +
      "or use NextjsGlobalFunctions, whose CloudFront behaviors allow it.",
  );
}

/**
 * Refuse a group route that shares a resource with a `public/` entry.
 *
 * A public directory `docs` is `docs/{proxy+}` with a `GET` to S3. `/docs/**`
 * adds `ANY` to that same resource, and API Gateway prefers the `GET`, so
 * every page load under the group went to S3; `/docs/guide/**` is a more
 * specific resource instead, and takes `/docs/guide/…` away from the public
 * files. A public file `pricing` and an exact `/pricing` are the same
 * resource the same way. `NextjsDistribution` rejects the CloudFront
 * equivalents.
 */
export function assertNoApiPublicCollision(
  route: string,
  groupName: string,
  publicDirEntries: readonly PublicDirEntry[],
): void {
  const { isSubtree, segments } = splitGroupRoute(route);
  const entry = publicDirEntries.find((it) =>
    it.isDirectory
      ? it.name === segments[0] && (isSubtree || segments.length > 1)
      : !isSubtree && segments.length === 1 && it.name === segments[0],
  );
  if (!entry) {
    return;
  }
  throw new Error(
    `${LOG_PREFIX} functionGroups pattern "${route}" (group "${groupName}") ` +
      `overlaps the top-level public/ ${entry.isDirectory ? "directory" : "file"} ` +
      `"${entry.name}", which API Gateway serves from S3 on the same ` +
      `resource path, so one of the two would never be reached. Move those ` +
      `public/ files under a directory no route uses, or group a different ` +
      `path.`,
  );
}

/**
 * Resource paths, as segment arrays, for one group pattern.
 *
 * A subtree gets `{proxy+}` as its last segment and so owns everything *under*
 * the path but not the path itself, matching both the CloudFront translation and
 * `assignRoutesToGroups`. An exact path gets no proxy segment, which leaves its
 * children falling through to the root `{proxy+}` — also the CloudFront result.
 */
export function apiResourcePaths(
  route: string,
  hasDataRoutes?: boolean,
): string[][] {
  const { isSubtree, segments: base } = splitGroupRoute(route);
  const paths = [isSubtree ? [...base, "{proxy+}"] : base];
  if (hasDataRoutes) {
    // `<buildId>` changes every build, so it is a path parameter rather than a
    // literal — the integration ignores it, the runtime reads it off the URL.
    // Unlike CloudFront's `*`, which `NextjsDistribution` had to replace with
    // the literal ID, a path parameter is exactly one segment, so
    // `/_next/data/{buildId}/blog/{proxy+}` cannot capture another group's
    // `/_next/data/<id>/docs/blog/…`. A request for an old build ID reaches
    // the group, which 404s it just as the default function would.
    const dataPrefix = ["_next", "data", "{buildId}"];
    paths.push(
      isSubtree
        ? [...dataPrefix, ...base, "{proxy+}"]
        : [
            ...dataPrefix,
            ...base.slice(0, -1),
            `${base[base.length - 1]}.json`,
          ],
    );
  }
  return paths;
}

/**
 * Every resource path the function groups' routes become, in the order they
 * should be created, each with the name of the group it routes to.
 *
 * The CloudFront patterns are for the edge; a resource path per route covers
 * what they do here, a `trailingSlash` form included, since API Gateway matches
 * `/pricing/` on the `pricing` resource. Throws for a behavior routed to an
 * unknown group, and for a route API Gateway can't hold or a `public/` entry
 * already holds.
 */
export function apiGroupRoutePaths(
  groups: readonly { readonly name: string }[],
  behaviors: readonly GroupBehavior[],
  publicDirEntries: readonly PublicDirEntry[],
): ApiRoutePath<string>[] {
  assertKnownFunctionGroups(groups, behaviors);
  const routePaths: ApiRoutePath<string>[] = [];
  for (const group of groups) {
    const own = behaviors.filter((behavior) => behavior.group === group.name);
    const hasDataRoutes = own.some(({ pattern }) =>
      pattern.startsWith("_next/data/"),
    );
    for (const route of new Set(own.map((behavior) => behavior.route))) {
      assertApiRoutable(route, group.name);
      assertNoApiPublicCollision(route, group.name, publicDirEntries);
      for (const path of apiResourcePaths(route, hasDataRoutes)) {
        routePaths.push({ path, owner: group.name });
      }
    }
  }
  return routePaths;
}

/**
 * The parents `routePaths` need that are not route paths themselves, in the
 * order creating the route paths in turn would first create them, and who
 * answers each.
 *
 * A parent under another group's subtree belongs to that group, as it does
 * at the edge and in `assignRoutesToGroups`: with `/api/**` and
 * `/api/reports/**`, `/api/reports` is the `api` group's. The deepest
 * covering subtree wins; the rest are left to the default function.
 */
export function apiParentPaths<T>(
  routePaths: readonly ApiRoutePath<T>[],
): ApiParentPath<T>[] {
  const key = (path: readonly string[]) => path.join("/");
  const routeKeys = new Set(routePaths.map(({ path }) => key(path)));
  /** Each subtree's base path and the owner its `{proxy+}` got. */
  const subtrees = routePaths
    .filter(({ path }) => path[path.length - 1] === "{proxy+}")
    .map(({ path, owner }): [string[], T] => [path.slice(0, -1), owner]);
  const seen = new Set<string>();
  const parents: string[][] = [];
  for (const { path } of routePaths) {
    for (let length = 1; length < path.length; length++) {
      const parent = path.slice(0, length);
      if (!seen.has(key(parent))) {
        seen.add(key(parent));
        parents.push(parent);
      }
    }
    seen.add(key(path));
  }
  return parents
    .filter((path) => !routeKeys.has(key(path)))
    .map((path) => ({
      path,
      owner: subtrees
        .filter(
          ([base]) =>
            base.length < path.length &&
            base.every((segment, i) => segment === path[i]),
        )
        .sort(([a], [b]) => b.length - a.length)[0]?.[1],
    }));
}
