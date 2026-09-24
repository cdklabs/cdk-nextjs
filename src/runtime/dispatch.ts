/* eslint-disable import/no-extraneous-dependencies */
/**
 * Request dispatch: URL in, routing decision out.
 *
 * All route matching is delegated to `@next/routing`'s `resolveRoutes`, the
 * first-party package `next start` was refactored to expose. Reimplementing
 * redirects/rewrites/i18n/dynamic-route matching is what previous versions of
 * this construct did, and it is the thing this rewrite exists to delete.
 *
 * This module is pure decision-making: it never touches the filesystem, never
 * requires an entrypoint, and never builds a `Response`. It returns a
 * {@link DispatchResult} and the caller (the runtime core, step 4) acts on it.
 * That split is what makes it unit-testable against the committed
 * `onBuildComplete` fixtures with no AWS and no Next.js server.
 */
import {
  MiddlewareContext,
  MiddlewareResult,
  ResolveRoutesParams,
  ResolveRoutesQuery,
  ResolveRoutesQueryValue,
  ResolveRoutesResult,
  RouteInvocationTarget,
  detectDomainLocale,
  detectLocale,
  resolveRoutes,
} from "@next/routing";
import { AdapterEntrypoint, AdapterManifest } from "./manifest";

/**
 * Runs the app's middleware. Supplied by `MiddlewareRunner` in `./middleware`.
 *
 * `MiddlewareContext` carries no method — `resolveRoutes` never needs one — but
 * middleware very much does (`if (request.method === "POST")`), so dispatch adds
 * it from the request it was given.
 */
export type MiddlewareInvoker = (
  ctx: MiddlewareContext & { readonly method: string },
) => Promise<MiddlewareResult>;

export interface DispatcherOptions {
  readonly manifest: AdapterManifest;
  /**
   * Required whenever `manifest.middleware` is non-null. `resolveRoutes` decides
   * *whether* to call it from `routing.middlewareMatchers`; we only supply the
   * how.
   */
  readonly invokeMiddleware?: MiddlewareInvoker;
}

export interface DispatchRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  /**
   * Always a stream — `resolveRoutes` requires one because middleware may read
   * the body. Use an already-closed stream for GET/HEAD.
   */
  readonly body: ReadableStream;
}

interface DispatchResultBase {
  /**
   * Headers to merge into the response: `headers()` rules, the immutable
   * `cache-control` for `_next/static`, and anything middleware set via
   * `NextResponse.next({ headers })`. Never request headers.
   */
  readonly responseHeaders: Headers;
  /** Status forced by a matched route, if any. */
  readonly status?: number;
}

/** A route we must invoke. */
export interface DispatchEntrypointResult extends DispatchResultBase {
  readonly kind: "entrypoint";
  readonly entrypoint: AdapterEntrypoint;
  /** The matched template, i.e. the `manifest.entrypoints` key. */
  readonly resolvedPathname: string;
  /** The *concrete* pathname + query to invoke the route with. */
  readonly invocationTarget: RouteInvocationTarget;
  readonly query: ResolveRoutesQuery;
  /**
   * Dynamic segment captures, both positional and `nxtP`-named. A group the
   * match left unset is still a key here, with no value — see
   * {@link repairRouteParamQuery}.
   */
  readonly routeMatches: Record<string, string | undefined>;
  /** Request headers as middleware left them. */
  readonly requestHeaders: Headers;
}

/** A file in `manifest.staticFiles`: read off disk, not invoked. */
export interface DispatchStaticFileResult extends DispatchResultBase {
  readonly kind: "static-file";
  readonly pathname: string;
  /** Repo-root-relative key inside the deployment root. */
  readonly filePath: string;
}

/** `/_next/image`: our own optimizer, deliberately reached after middleware. */
export interface DispatchImageOptimizationResult extends DispatchResultBase {
  readonly kind: "image-optimization";
  readonly url: URL;
  readonly requestHeaders: Headers;
}

export interface DispatchRedirectResult extends DispatchResultBase {
  readonly kind: "redirect";
  readonly location: string;
  readonly status: number;
}

/** A rewrite to another origin: proxy the request through. */
export interface DispatchExternalRewriteResult extends DispatchResultBase {
  readonly kind: "external-rewrite";
  readonly url: URL;
  readonly requestHeaders: Headers;
}

/** Middleware returned its own response; the runner is holding it. */
export interface DispatchMiddlewareRespondedResult extends DispatchResultBase {
  readonly kind: "middleware-responded";
}

/** A matched route forced a status with nothing to invoke. */
export interface DispatchDirectResponseResult extends DispatchResultBase {
  readonly kind: "response";
  readonly status: number;
}

export interface DispatchNotFoundResult extends DispatchResultBase {
  readonly kind: "not-found";
  /** What failed to resolve. For logging. */
  readonly pathname: string;
  readonly notFound: NotFoundTarget;
  readonly requestHeaders: Headers;
}

export type DispatchResult =
  | DispatchEntrypointResult
  | DispatchStaticFileResult
  | DispatchImageOptimizationResult
  | DispatchRedirectResult
  | DispatchExternalRewriteResult
  | DispatchMiddlewareRespondedResult
  | DispatchDirectResponseResult
  | DispatchNotFoundResult;

/**
 * How to produce a 404 body. Resolved once from the manifest; picking between
 * locale variants and honoring `notFound()` from a route is the runtime core's
 * job, not dispatch's.
 */
export type NotFoundTarget =
  | {
      readonly kind: "entrypoint";
      readonly pathname: string;
      readonly entrypoint: AdapterEntrypoint;
    }
  | {
      readonly kind: "static-file";
      readonly pathname: string;
      readonly filePath: string;
    }
  | { readonly kind: "none" };

/**
 * `ctx.routing` is persisted into the manifest verbatim and typed `unknown`
 * there, because the manifest must not depend on `@next/routing` (it is also
 * read at synth by the CDK constructs). Dispatch is the one place that knows
 * the real shape, so the cast lives here.
 *
 * `ctx.routing` is a superset of `ResolveRoutesParams["routes"]` — it also
 * carries `rsc` — which is why this is a cast and not an assignment.
 */
function asRoutes(routing: unknown): ResolveRoutesParams["routes"] {
  return routing as ResolveRoutesParams["routes"];
}

/**
 * Likewise for `i18n`: `NextConfigComplete["i18n"]` is wider than
 * `ResolveRoutesParams["i18n"]` (extra fields, and `localeDetection?: boolean`
 * against `false`), and the manifest stores the config value as-is.
 */
function asI18n(i18n: unknown | null): ResolveRoutesParams["i18n"] | undefined {
  return i18n ? (i18n as ResolveRoutesParams["i18n"]) : undefined;
}

export class Dispatcher {
  /** Resolved once at construction; see {@link NotFoundTarget}. */
  public readonly notFound: NotFoundTarget;

  private readonly routes: ResolveRoutesParams["routes"];
  private readonly i18n: ResolveRoutesParams["i18n"] | undefined;
  private readonly staticFiles: Record<string, string>;
  private readonly imagePathname: string;
  private readonly invokeMiddleware: MiddlewareInvoker;
  /** {@link manifest}'s, plus the `trailingSlash` variants. */
  private readonly pathnames: string[];
  private readonly trailingSlash: boolean;

  public constructor(private readonly options: DispatcherOptions) {
    const { manifest } = options;
    this.routes = asRoutes(manifest.routing);
    this.i18n = asI18n(manifest.config.i18n);
    this.trailingSlash = manifest.config.trailingSlash;
    this.pathnames = this.trailingSlash
      ? withTrailingSlashVariants(manifest.pathnames)
      : manifest.pathnames;
    this.staticFiles = manifest.staticFiles;
    this.imagePathname = `${manifest.config.basePath}/_next/image`;
    this.notFound = resolveNotFoundTarget(manifest);

    if (manifest.middleware && !options.invokeMiddleware) {
      throw new Error(
        "This build has middleware, so the Dispatcher needs an " +
          "`invokeMiddleware` implementation. Refusing to route without it: " +
          "silently skipping middleware would change auth and rewrite behavior.",
      );
    }
    // `resolveRoutes` requires the callback even when no middleware matcher can
    // fire, so give it a no-op rather than making the field optional.
    this.invokeMiddleware = options.invokeMiddleware ?? (async () => ({}));
  }

  public get manifest(): AdapterManifest {
    return this.options.manifest;
  }

  /**
   * Drop the `trailingSlash` slash a resolved pathname may carry, so it can be
   * looked up in `entrypoints`/`staticFiles` and rendered under the same cache
   * key as its prerender. A no-op unless the app sets `trailingSlash`.
   */
  private normalizePathname(pathname: string | undefined): string | undefined {
    if (!this.trailingSlash || pathname === undefined) return pathname;
    return pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  }

  /** The request path with `basePath` removed, which is what i18n applies to. */
  private withoutBasePath(pathname: string): string {
    const { basePath } = this.manifest.config;
    return basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || "/"
      : pathname;
  }

  /**
   * Put the locale in front of a request for the app's root *here*, when the
   * locale is the one the request is already in.
   *
   * `resolveRoutes` prefixes the locale itself, as `${basePath}/${locale}${pathname}`
   * — which for the root turns `/` into `/en-US/`. The slash-stripping 308 that
   * `next build` always compiles into `routing.beforeMiddleware` then matches it,
   * so `GET /` came back as a redirect no `next start` sends: measured against
   * `test/e2e/i18n-support-catchall`, where `/` answers 200. Next.js's own router
   * special-cases exactly this (`resolve-routes.ts`: `pathname === '/' ?
   * `/${defaultLocale}` : …`).
   *
   * Only the root, and only when no redirect is owed: a request whose detected
   * locale is *not* the default has to reach `resolveRoutes`, which answers it
   * with the 307 Next.js sends — after middleware has had the request, which is
   * the ordering that matters and the reason this does not redirect itself.
   */
  private withRootLocale(url: URL, headers: Headers): URL {
    const i18n = this.i18n;
    if (!i18n) return url;
    const pathname = this.withoutBasePath(url.pathname);
    if (pathname !== "/") return url;

    const defaultLocale =
      detectDomainLocale(i18n.domains, url.hostname)?.defaultLocale ??
      i18n.defaultLocale;
    const detected = detectLocale({
      pathname,
      hostname: url.hostname,
      cookieHeader: headers.get("cookie") ?? undefined,
      acceptLanguageHeader: headers.get("accept-language") ?? undefined,
      i18n,
    });
    if (detected.locale !== defaultLocale) return url;

    const prefixed = new URL(url.toString());
    prefixed.pathname = `${this.manifest.config.basePath}/${defaultLocale}`;
    return prefixed;
  }

  /**
   * Repair the two things `resolveRoutes` gets wrong about a redirect it built
   * from the locale-prefixed root — the same `${basePath}/${locale}${pathname}`
   * concatenation as in {@link withRootLocale}, this time reported as a location:
   *
   * - the stray trailing slash (`/nl/`, where Next.js sends `/nl`), which
   *   otherwise costs a second round trip to the 308 that strips it, and
   * - the absolute URL, where Next.js sends a path. Both are legal, but a test
   *   asserting `headers.location` sees the difference, and so does any client
   *   comparing it to a link.
   */
  private normalizeRedirectLocation(location: string, request: URL): string {
    let resolved: URL;
    try {
      resolved = new URL(location, request);
    } catch {
      return location;
    }
    if (resolved.origin !== request.origin) return location;

    const target = this.withoutBasePath(resolved.pathname);
    const isLocaleRoot =
      this.i18n !== undefined &&
      !this.trailingSlash &&
      this.withoutBasePath(request.pathname) === "/" &&
      this.i18n.locales.some((locale) => target === `/${locale}/`);
    if (isLocaleRoot) {
      resolved.pathname = resolved.pathname.slice(0, -1);
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  }

  public async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    // Copied because `resolveRoutes` is free to mutate what it is handed, and
    // the caller's headers object outlives this call.
    const requestHeaders = new Headers(request.headers);
    let middlewareRequestHeaders: Headers | undefined;
    let middlewareRewrite: URL | undefined;

    const result = await resolveRoutes({
      url: this.withRootLocale(request.url, requestHeaders),
      buildId: this.manifest.buildId,
      basePath: this.manifest.config.basePath,
      headers: requestHeaders,
      requestBody: request.body,
      pathnames: this.pathnames,
      routes: this.routes,
      i18n: this.i18n,
      invokeMiddleware: async (ctx) => {
        const middleware = await this.invokeMiddleware({
          ...ctx,
          method: request.method,
        });
        // `resolveRoutes` drops `MiddlewareResult.requestHeaders` entirely: it
        // neither returns them nor mutates the `headers` passed in. Capturing
        // them here is what keeps `NextResponse.next({ request: { headers } })`
        // working.
        if (middleware.requestHeaders) {
          middlewareRequestHeaders = middleware.requestHeaders;
        }
        // Captured for the same reason: `resolveRoutes` routes the rewritten URL
        // internally but never reports it back, and `/_next/image` is matched
        // here rather than by `resolveRoutes` (see below), so this is the only
        // way to see the path middleware actually asked for.
        if (middleware.rewrite) {
          middlewareRewrite = middleware.rewrite;
        }
        return middleware;
      },
    });

    const responseHeaders = new Headers(result.resolvedHeaders ?? undefined);
    // `@next/routing` echoes the rewrite it followed into `resolvedHeaders`;
    // Next.js's own router consumes that header rather than sending it, and so do
    // we — it is an internal routing signal, and forwarding it would expose the
    // app's post-middleware paths to clients.
    responseHeaders.delete("x-middleware-rewrite");
    const forwardedHeaders = middlewareRequestHeaders ?? requestHeaders;
    const status = result.status;

    if (result.middlewareResponded) {
      return { kind: "middleware-responded", responseHeaders, status };
    }

    if (result.externalRewrite) {
      return {
        kind: "external-rewrite",
        url: result.externalRewrite,
        requestHeaders: forwardedHeaders,
        responseHeaders,
        status,
      };
    }

    const redirect = toRedirect(result, responseHeaders);
    if (redirect) {
      return {
        kind: "redirect",
        ...redirect,
        location: this.normalizeRedirectLocation(
          redirect.location,
          request.url,
        ),
        responseHeaders,
      };
    }

    // Both are keys into `entrypoints`/`staticFiles`, which never carry a
    // trailing slash; see {@link withTrailingSlashVariants}.
    const resolvedPathname = this.normalizePathname(result.resolvedPathname);
    if (resolvedPathname !== undefined) {
      const entrypoint = this.manifest.entrypoints[resolvedPathname];
      if (entrypoint) {
        const routeMatches = result.routeMatches ?? {};
        const query = repairRouteParamQuery(
          result.resolvedQuery ?? {},
          routeMatches,
        );
        return {
          kind: "entrypoint",
          entrypoint,
          resolvedPathname,
          // `invocationTarget` is always present alongside `resolvedPathname` in
          // practice; the fallback keeps a `next` shape change from crashing.
          invocationTarget: {
            pathname:
              this.normalizePathname(result.invocationTarget?.pathname) ??
              resolvedPathname,
            query,
          },
          query,
          routeMatches,
          requestHeaders: forwardedHeaders,
          responseHeaders,
          status,
        };
      }
      const filePath = this.staticFiles[resolvedPathname];
      if (filePath !== undefined) {
        return {
          kind: "static-file",
          pathname: resolvedPathname,
          filePath,
          responseHeaders,
          status,
        };
      }
    }

    if (status !== undefined) {
      return { kind: "response", status, responseHeaders };
    }

    // Unresolved. `/_next/image` is not an adapter output type at all, so it can
    // never appear in `pathnames` and always lands here. That is the intended
    // design, not a gap: image optimization has to run *after* middleware, and
    // dispatch is the first point where that is true.
    //
    // Matched against the rewritten URL when middleware rewrote one, because
    // middleware may be what puts the request on the image path at all: the
    // API Gateway examples rewrite `/_next/image` to `/<stage>/_next/image` so
    // that `basePath` lines up, and comparing the URL as received would miss it.
    const resolvedUrl = middlewareRewrite ?? request.url;
    if (resolvedUrl.pathname === this.imagePathname) {
      return {
        kind: "image-optimization",
        url: resolvedUrl,
        requestHeaders: forwardedHeaders,
        responseHeaders,
      };
    }

    return {
      kind: "not-found",
      pathname: resolvedPathname ?? resolvedUrl.pathname,
      notFound: this.notFound,
      requestHeaders: forwardedHeaders,
      responseHeaders,
    };
  }
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  return new Dispatcher(options);
}

/**
 * Normalize the two shapes `resolveRoutes` reports a redirect in.
 *
 * `ResolveRoutesResult.redirect` is documented, and an i18n locale-detection 307
 * arrives that way, but the rest — the slash-stripping 308, a middleware
 * `NextResponse.redirect()` — arrive instead as a bare `status` with `location`
 * in `resolvedHeaders`. `next.config` `redirects()` too: they compile to routes
 * carrying `headers: { Location }` plus `status`. Both shapes are handled, and
 * {@link Dispatcher.normalizeRedirectLocation} then puts the location itself in
 * the form Next.js sends.
 */
export function toRedirect(
  result: ResolveRoutesResult,
  responseHeaders: Headers,
): { location: string; status: number } | undefined {
  if (result.redirect) {
    return {
      location: result.redirect.url.href,
      status: result.redirect.status,
    };
  }
  const location = responseHeaders.get("location");
  if (
    location !== null &&
    result.status !== undefined &&
    result.status >= 300 &&
    result.status < 400
  ) {
    return { location, status: result.status };
  }
  return undefined;
}

/**
 * Add `<pathname>/` alongside every route pathname, for a `trailingSlash` app.
 *
 * `trailingSlash: true` makes `/a/` the canonical URL — Next.js compiles a
 * `priority` 308 from `/a` to `/a/` into `routing.beforeMiddleware`, and that
 * redirect is the *first* thing `resolveRoutes` applies. But the build's output
 * pathnames have no trailing slash (`/a`, `/api/revalidate`), and
 * `@next/routing` matches them by exact string equality with no normalization of
 * its own. So every canonical URL in such an app resolved to nothing: browsers
 * followed the 308 to `/a/` and got a 404, and `fetch('/api/revalidate')` got
 * the 404 *page* — measured against next.js's `test/e2e/app-dir/trailingslash`,
 * where 6 of 8 cases failed this way. Dynamic routes escaped it only because
 * their `sourceRegex` happens to end in `(?:/)?`.
 *
 * Normalizing the request URL before `resolveRoutes` instead would be wrong: the
 * add-slash redirect matches the *slashless* path, so a normalized `/a/` would
 * come back as a 308 to `/a/` and loop. Teaching the match about the slash and
 * normalizing it off the *result* ({@link Dispatcher.normalizePathname}) keeps
 * the redirect exactly as Next.js compiled it.
 *
 * Pathnames whose last segment has an extension are skipped: those are static
 * files, and Next.js compiles the opposite redirect for them (`/x.js/` → 308
 * `/x.js`), which this must not shadow.
 */
function withTrailingSlashVariants(pathnames: string[]): string[] {
  const variants: string[] = [];
  for (const pathname of pathnames) {
    variants.push(pathname);
    if (pathname !== "/" && !/\.[^/]+$/.test(pathname)) {
      variants.push(`${pathname}/`);
    }
  }
  return variants;
}

/**
 * Correct the `nxtP` route params in a resolved query from `routeMatches`.
 *
 * `@next/routing` expands a dynamic route's destination
 * (`/[id]/[id2]?nxtPid=$nxtPid&nxtPid2=$nxtPid2`) by looping over the source
 * regex's named groups and doing one global string replace per group name. Group
 * names are substituted in insertion order, so `$nxtPid` — a *prefix* of
 * `$nxtPid2` — is replaced first and leaves the trailing `2` behind as a
 * literal: `/a/b` resolves with `nxtPid2=a2` instead of `nxtPid2=b`. Next.js
 * recovers `params` from exactly these query values (`RouteModule.prepare`), so
 * the page renders `id2: "a2"` — measured against
 * `test/e2e/app-dir/use-params`, whose fixture is `app/[id]/[id2]/page.tsx`.
 *
 * `routeMatches` is the raw capture map, before any destination expansion, so it
 * is the authority for every param it names. Only keys the expansion already
 * produced are overwritten: adding others would invent params for a rewrite that
 * deliberately dropped them.
 *
 * The same prefix collision reaches positional placeholders (`$1` inside `$10`,
 * so a route with ten or more captures), and `next.config` `rewrites()`
 * destinations that interpolate their own query values. Those are not route
 * params and are left alone — there is no second source of truth to repair them
 * from.
 *
 * The second correction is the opposite shape: a param the route *has* but the
 * request did not fill. An optional catchall's group is the only one a match can
 * leave unset — `^/optional\-catchall(?:/(?<nxtPparams>.+?))?(?:/)?$` against
 * `/optional-catchall` — and both `routeMatches` and the expanded query keep the
 * key with no value: `{ nxtPparams: undefined }`, which the `@next/routing` types
 * do not admit. The key is what matters, not the value. `RouteModule.prepare`
 * recovers a param for every `nxtP` key it finds, so a layout reading `params`
 * renders a segment that was never requested — as `["undefined"]`, because
 * `URLSearchParams.append` stringifies — where `next start` gives it no `params`
 * key at all. Measured against `test/e2e/app-dir/layout-params`, whose fixture is
 * `app/optional-catchall/[[...params]]`. No other param shape can be legitimately
 * unfilled — a required segment captures `[^/]+?` and a required catchall `.+?` —
 * so an unfilled value `routeMatches` does not vouch for is always this.
 */
export function repairRouteParamQuery(
  query: ResolveRoutesQuery,
  routeMatches: Record<string, string | undefined>,
): ResolveRoutesQuery {
  let repaired: ResolveRoutesQuery | undefined;
  for (const [key, value] of Object.entries(routeMatches)) {
    if (!key.startsWith("nxtP") || value === undefined) continue;
    if (!(key in query) || query[key] === value) continue;
    repaired ??= { ...query };
    repaired[key] = value;
  }
  for (const [key, value] of Object.entries(repaired ?? query)) {
    if (!key.startsWith("nxtP") || isFilledParam(value)) continue;
    if (isFilledParam(routeMatches[key])) continue;
    repaired ??= { ...query };
    delete repaired[key];
  }
  return repaired ?? query;
}

/**
 * Route params to hand Next.js out-of-band, for the one request shape the `nxtP`
 * query contract cannot carry: a capture containing an encoded `/`. `undefined`
 * — the common case — means the contract is lossless and nothing special is
 * needed.
 *
 * The contract normally is lossless, which is why {@link NextjsRuntime} passes
 * route params as query values everywhere else. But `RouteModule.prepare`
 * recovers them by running `normalizeQueryParams` — which calls
 * `decodeQueryPathParameter`, a **second** `decodeURIComponent`, on every
 * de-prefixed value because "when deployed to Vercel the value may be encoded" —
 * and then `normalizeDynamicRouteParams`, which splits a string repeat param on
 * `/` because "query values from the proxy aren't already split into arrays".
 * Two decodes and a split: `nxtPrest=..%252F..%252Fserver-reference-manifest`
 * (what the contract asks for, and what we send) arrives as the three params
 * `['..', '..', 'server-reference-manifest']` rather than the one the client
 * requested. The resolved pathname built back out of those is
 * `/pages-cache/../../server-reference-manifest`, and `normalizePagePath` throws
 * `Requested and resolved page mismatch` on it when the cache asks for a key —
 * so a `_next/data` request for a catch-all whose segment contains `%2F` 500s.
 * Measured against `test/e2e/incremental-cache-path-traversal`. No encoding can
 * fix it from this side: whatever survives two decodes still gets split.
 *
 * `next start` never hits it because its `router-server` sets
 * `requestMeta.params` instead, which `prepare` takes as-is
 * (`route-module.ts`: `getRequestMeta(req, 'params')`) with no decode and no
 * split. That is what this reproduces — narrowly, only for the affected
 * requests, so that the documented query contract stays the path for everything
 * else.
 *
 * The `nxtP` values have to leave the query as well as arrive in `params`.
 * `prepare` prefers the query over `params` when both parse and are the same
 * size, so leaving them in would just restore the split. Dropping them also
 * matches `next start`, which has no `nxtP` query at all.
 */
export function outOfBandRouteParams(
  query: ResolveRoutesQuery,
  resolvedPathname: string,
):
  | { params: Record<string, string | string[]>; query: ResolveRoutesQuery }
  | undefined {
  const entries = Object.entries(query);
  if (
    !entries.some(
      ([key, value]) =>
        key.startsWith("nxtP") &&
        typeof value === "string" &&
        ENCODED_PATH_DELIMITER.test(value),
    )
  ) {
    return undefined;
  }
  // Which params are repeats — `[...rest]`, `[[...rest]]` — decides array versus
  // string, the same distinction `normalizeDynamicRouteParams` makes from the
  // route's own `groups`. `resolvedPathname` is the matched route, brackets and
  // all.
  const repeats = new Set<string>();
  for (const match of resolvedPathname.matchAll(/\[\[?\.\.\.([^\]]+?)\]\]?/g)) {
    repeats.add(match[1]);
  }
  const params: Record<string, string | string[]> = {};
  const remaining: ResolveRoutesQuery = {};
  for (const [key, value] of entries) {
    if (!key.startsWith("nxtP")) {
      remaining[key] = value;
      continue;
    }
    // Anything but a filled string is a param we cannot restate — an optional
    // catchall the request left unset, or a repeated key. Rather than hand
    // `prepare` a param set that is missing one, leave the whole request on the
    // query contract.
    if (typeof value !== "string" || value === "") return undefined;
    const name = key.slice("nxtP".length);
    params[name] = repeats.has(name)
      ? value.split("/").map(decodePathParam)
      : decodePathParam(value);
  }
  return { params, query: remaining };
}

/** An encoded `/`: the delimiter the query contract's split would consume. */
const ENCODED_PATH_DELIMITER = /%2f/i;

/** `decodeQueryPathParameter`, which tolerates a value that is not encoded. */
function decodePathParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Whether a route param carries a segment, as opposed to `""` or nothing. */
function isFilledParam(value: ResolveRoutesQueryValue | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/**
 * The order next itself uses, in `base-server.ts`'s `renderErrorToResponse`:
 * App Router's `/_not-found`, then Pages Router's `/404`, then `/_error`. `/404`
 * has to come before `/_error` — it is the app's *custom* 404, and `/_error` is
 * the built-in "404: This page could not be found". A `pages/404.js` is usually
 * prerendered to HTML, so it reaches us as a static file rather than an
 * entrypoint; it stays invocable when something forces a per-request render,
 * which `pages/_app.js` having `getInitialProps` does. Measured against
 * `test/e2e/404-page-app`, where every URL got the built-in page.
 *
 * Apps with none of the three fall back to the prerendered `/404` HTML, then to
 * nothing.
 */
function resolveNotFoundTarget(manifest: AdapterManifest): NotFoundTarget {
  const { basePath } = manifest.config;
  for (const suffix of ["/_not-found", "/404", "/_error"]) {
    const pathname = `${basePath}${suffix}`;
    const entrypoint = manifest.entrypoints[pathname];
    if (entrypoint) {
      return { kind: "entrypoint", pathname, entrypoint };
    }
  }
  const staticNotFound = `${basePath}/404`;
  const filePath = manifest.staticFiles[staticNotFound];
  if (filePath !== undefined) {
    return { kind: "static-file", pathname: staticNotFound, filePath };
  }
  return { kind: "none" };
}

/**
 * How to produce a 500 body. Same shapes as {@link NotFoundTarget}, and resolved
 * the same way — once, from the manifest.
 */
export type ErrorTarget = NotFoundTarget;

/**
 * The order next itself uses, in `base-server.ts`'s `renderErrorToResponse`:
 * `/500` — App Router's first, then Pages Router's — and then `/_error`, which is
 * the built-in error page unless the app wrote its own. `pages/500.js` is a
 * `STATIC_STATUS_PAGES` entry and so is normally prerendered to HTML, which is why
 * the static file is checked before `/_error` rather than after it: next would
 * serve that prerender in preference to `/_error` too.
 *
 * Only reached when an entrypoint *throws*. Next.js's page handlers deliberately
 * rethrow ("rethrow so that we can handle serving error page",
 * `pages-handler.ts`), leaving the error page to whatever is hosting them —
 * measured against `test/e2e/async-modules`, whose `/make-error` throws in
 * `getServerSideProps` and expects the app's `pages/_error`.
 */
export function resolveErrorTarget(manifest: AdapterManifest): ErrorTarget {
  const { basePath } = manifest.config;
  const error500 = `${basePath}/500`;
  const entrypoint500 = manifest.entrypoints[error500];
  if (entrypoint500) {
    return {
      kind: "entrypoint",
      pathname: error500,
      entrypoint: entrypoint500,
    };
  }
  const filePath = manifest.staticFiles[error500];
  if (filePath !== undefined) {
    return { kind: "static-file", pathname: error500, filePath };
  }
  const errorPathname = `${basePath}/_error`;
  const errorEntrypoint = manifest.entrypoints[errorPathname];
  if (errorEntrypoint) {
    return {
      kind: "entrypoint",
      pathname: errorPathname,
      entrypoint: errorEntrypoint,
    };
  }
  return { kind: "none" };
}
