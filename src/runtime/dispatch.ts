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
  ResolveRoutesResult,
  RouteInvocationTarget,
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
  /** Dynamic segment captures, both positional and `nxtP`-named. */
  readonly routeMatches: Record<string, string>;
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

  public constructor(private readonly options: DispatcherOptions) {
    const { manifest } = options;
    this.routes = asRoutes(manifest.routing);
    this.i18n = asI18n(manifest.config.i18n);
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

  public async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    // Copied because `resolveRoutes` is free to mutate what it is handed, and
    // the caller's headers object outlives this call.
    const requestHeaders = new Headers(request.headers);
    let middlewareRequestHeaders: Headers | undefined;
    let middlewareRewrite: URL | undefined;

    const result = await resolveRoutes({
      url: request.url,
      buildId: this.manifest.buildId,
      basePath: this.manifest.config.basePath,
      headers: requestHeaders,
      requestBody: request.body,
      pathnames: this.manifest.pathnames,
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
      return { kind: "redirect", ...redirect, responseHeaders };
    }

    const { resolvedPathname } = result;
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
            pathname: result.invocationTarget?.pathname ?? resolvedPathname,
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
 * `ResolveRoutesResult.redirect` is documented, but every redirect actually
 * observed — the i18n default-locale 308, the `trailingSlash` 308, and a
 * middleware `NextResponse.redirect()` — arrives instead as a bare `status` with
 * `location` in `resolvedHeaders`. `next.config` `redirects()` too: they compile
 * to routes carrying `headers: { Location }` plus `status`. Both shapes are
 * handled because the documented field is the one a future `next` may start
 * using; exported so the unreachable-today one is still tested.
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
 */
function repairRouteParamQuery(
  query: ResolveRoutesQuery,
  routeMatches: Record<string, string>,
): ResolveRoutesQuery {
  let repaired: ResolveRoutesQuery | undefined;
  for (const [key, value] of Object.entries(routeMatches)) {
    if (!key.startsWith("nxtP")) continue;
    if (!(key in query) || query[key] === value) continue;
    repaired ??= { ...query };
    repaired[key] = value;
  }
  return repaired ?? query;
}

/**
 * App Router builds an invocable `/_not-found`; Pages Router builds `/_error`.
 * Apps with neither (or with only a statically exported 404) fall back to the
 * prerendered `/404` HTML, then to nothing.
 */
function resolveNotFoundTarget(manifest: AdapterManifest): NotFoundTarget {
  const { basePath } = manifest.config;
  for (const suffix of ["/_not-found", "/_error"]) {
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
