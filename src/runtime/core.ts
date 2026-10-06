/* eslint-disable import/no-extraneous-dependencies */
/**
 * The runtime core: one `handle(request, sink)` that both shells wrap.
 *
 * The Lambda shell (`lambda.mts`) and the container shell (`server.mts`) do
 * nothing but turn their input into a {@link RuntimeRequest} and their output into
 * a {@link ResponseSink}. Everything else — synthesizing `req`/`res`, dispatch,
 * middleware, entrypoint invocation, static files, image optimization, gzip,
 * `waitUntil` — happens here, so the container e2e suite exercises the same code
 * Lambda runs. That is deliberate: the container path used to get real
 * `node:http` objects from Lambda Web Adapter, which meant container tests proved
 * nothing about Lambda.
 */
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { caseCanonicalPath } from "./case-redirect";
import {
  Dispatcher,
  outOfBandRouteParams,
  StatusTarget,
  statusTargets,
} from "./dispatch";
import {
  EntrypointHandler,
  EntrypointRegistry,
  RouteInOtherGroupError,
} from "./entrypoints";
import { ShimIncomingMessage, toIncomingHttpHeaders } from "./http/request";
import {
  asServerResponse,
  ResponseHead,
  ShimServerResponse,
} from "./http/response";
import { pipeToSink, ResponseSink } from "./http/sink";
import { InternalImageResponse, RuntimeImageOptimizer } from "./image";
import {
  AdapterManifest,
  deployedManifestPath,
  FUNCTION_GROUP_ENV_VAR,
  MANIFEST_FILE_NAME,
  REVALIDATED_PAGE_HOOK,
} from "./manifest";
import { MiddlewareRunner } from "./middleware";
import {
  loadEnvFiles,
  registerInstrumentation,
  setupNodeEnvironment,
  useNextFrom,
} from "./next-modules";
import { publicDirKey, resolvePublicFiles } from "./public-files";
import { serveS3PublicFile, serveStaticFile } from "./static-files";
import { catchUpTags } from "./tag-manifest";
import { drained, firstValue, toSearch, withoutPathPrefix } from "./util";

/** One request, normalized by a shell. */
export interface RuntimeRequest {
  readonly method: string;
  /** Origin-form target exactly as received: path + query, never absolute. */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body?: Readable | Buffer;
  readonly remoteAddress?: string;
  /** `false` behind a TLS-terminating ALB. Only affects the synthesized socket. */
  readonly encrypted?: boolean;
  /**
   * Aborted when the client disconnects. Wiring it to `res.destroy()` is what
   * makes `request.signal.onabort` fire inside route handlers.
   */
  readonly signal?: AbortSignal;
  /**
   * Whether `x-forwarded-host` names the host the client asked for. Only the
   * shell can know: it is `true` for a Function URL event whose SigV4 Lambda
   * verified. That is any IAM-authorized invoker — in practice CloudFront's
   * Origin Access Control, whose viewer-request function overwrites the header
   * with the viewer's `Host` (CloudFront has to replace `Host` itself with the
   * Function URL's domain), plus principals granted `lambda:InvokeFunctionUrl`,
   * who could replace the function's code anyway. It is also what
   * `proxyExternal` drops OAC's signature on. Everywhere else the header is
   * whatever the client sent, and it is
   * ignored, as `next start` ignores it without `experimental.trustHostHeader`.
   */
  readonly trustForwardedHost?: boolean;
  /**
   * Set by {@link NextjsRuntime.handleInternally} for the in-process requests it
   * makes: called with the `RouteInOtherGroupError` the route threw, instead of
   * logging the misrouted-request warning, which describes a CloudFront or API
   * Gateway problem this is not.
   */
  readonly onRouteInOtherGroup?: (error: RouteInOtherGroupError) => void;
}

/**
 * `RevalidateFn`'s argument (`next/dist/server/lib/router-utils/router-server-context`),
 * restated because that module is not part of `next`'s published type surface.
 */
interface RevalidateConfig {
  readonly urlPath: string;
  readonly headers: { [key: string]: string | string[] };
  readonly opts: { unstable_onlyGenerated?: boolean };
}

export interface NextjsRuntimeOptions {
  /**
   * Absolute path to the deployment root — the staged tree every manifest key
   * resolves against. `LAMBDA_TASK_ROOT` for Functions, the image `WORKDIR` for
   * Containers; both shells derive it from their own location instead.
   */
  readonly deploymentRoot: string;
  readonly manifest: AdapterManifest;
  /** `CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME`. */
  readonly bucket?: string;
  /** `CDK_NEXTJS_STATIC_ASSETS_KEY_PREFIX`. */
  readonly bucketKeyPrefix?: string;
}

export class NextjsRuntime {
  private readonly entrypoints: EntrypointRegistry;
  private readonly dispatcher: Dispatcher;
  private readonly middleware?: MiddlewareRunner;
  private readonly images: RuntimeImageOptimizer;
  /** The 500 ladder; see `statusTargets`. */
  private readonly errorTargetFor: (url: URL | undefined) => StatusTarget;
  /** The assets bucket, when `public/` files are served from it. */
  private readonly publicBucket?: string;

  public constructor(private readonly options: NextjsRuntimeOptions) {
    const { manifest, deploymentRoot } = options;
    this.entrypoints = new EntrypointRegistry(deploymentRoot, manifest);
    // Listed once, at cold start; see `resolvePublicFiles`.
    const publicFiles = resolvePublicFiles(deploymentRoot, manifest);
    this.dispatcher = new Dispatcher({
      manifest,
      publicFiles: publicFiles.files,
    });
    // On disk otherwise, with `.next/static`.
    this.publicBucket = publicFiles.inS3 ? options.bucket : undefined;
    this.errorTargetFor = statusTargets(manifest, 500);
    this.images = new RuntimeImageOptimizer({
      deploymentRoot,
      manifest,
      bucket: this.publicBucket ?? "",
      bucketKeyPrefix: options.bucketKeyPrefix ?? "",
      fetchInternal: (href, req, maximumBody) =>
        this.fetchInternal(href, req, maximumBody),
    });
    // The runner is shared — it memoizes the loaded middleware module — while the
    // `invokeMiddleware` callback it produces is per request.
    this.middleware = manifest.middleware
      ? new MiddlewareRunner({
          middleware: manifest.middleware,
          root: deploymentRoot,
        })
      : undefined;
  }

  public get manifest(): AdapterManifest {
    return this.options.manifest;
  }

  public async handle(
    request: RuntimeRequest,
    sink: ResponseSink,
  ): Promise<void> {
    const { manifest } = this.options;
    const pending: Array<Promise<unknown>> = [];
    const waitUntil = (promise: Promise<unknown>) => {
      pending.push(promise);
    };

    const body = splitBody(request.body, this.middleware !== undefined);
    const req = new ShimIncomingMessage({
      method: request.method,
      url: request.url,
      headers: withoutInternalHeaders(
        request.headers,
        request.url,
        manifest.config.basePath,
      ),
      body: body.forRequest,
      remoteAddress: request.remoteAddress,
      encrypted: request.encrypted,
      trustForwardedHost: request.trustForwardedHost,
    });
    const res = new ShimServerResponse();
    // Next.js reads `res.req` in a few error paths.
    res.req = req;
    request.signal?.addEventListener("abort", () => res.destroy(), {
      once: true,
    });

    // The rejection handler is attached here rather than at the `await` below.
    // `route()` awaits real I/O, so a stream that breaks while it runs would
    // leave this promise rejected with no handler attached for a full event-loop
    // turn — and Node 24 defaults to `--unhandled-rejections=throw`, which on
    // the container shell takes the whole task down and aborts every other
    // in-flight request on it. A mid-stream EPIPE from one client disconnect is
    // not grounds for that.
    //
    // The error is logged, not rethrown: the stream broke after (or while) the
    // head went out — a client disconnect, or `sendError` destroying a
    // half-written response — and neither is an invocation failure. Rethrowing
    // would make Lambda retry a request the client already abandoned.
    const finished = pipeToSink(req, res, sink, {
      compress: manifest.config.compress,
    }).catch((error: unknown) => {
      console.error("The response stream did not complete:", error);
    });

    // For the error page's locale; unset when the throw is `absoluteUrl`'s.
    let url: URL | undefined;
    try {
      // Before anything parses the target, including `absoluteUrl` - `new URL`
      // reads a leading `//` as protocol-relative and would take the first path
      // segment for the host.
      const collapsed = collapseRepeatedSlashes(request.url);
      if (collapsed !== undefined) {
        sendRedirect(res, collapsed, 308);
      } else {
        // Inside the try: `absoluteUrl` builds a `URL` out of the request line
        // and the forwarded headers, and a throw here has to reach the error
        // ladder like any other. Outside it, on the Lambda shells — whose
        // handlers wrap nothing — the same throw is an invocation error and a
        // 502.
        url = absoluteUrl(request);
        await this.route(req, res, url, body, waitUntil, request);
      }
    } catch (error) {
      await this.sendError(req, res, waitUntil, error, url);
    }

    await finished;

    // Lambda freezes the execution environment the moment the handler resolves —
    // there is no post-response keepalive — so background work registered with
    // `waitUntil` (notably ISR revalidation) has to be awaited here. After the
    // response stream has closed, so client latency is unaffected; billed
    // duration extends, which is the correct trade against a revalidation that
    // never completes.
    //
    // Drained until nothing new arrives, not awaited once: `waitUntil` keeps
    // being called after the response — Next's `AfterContext` registers its
    // callback queue on the first `after()`, and an `after(promise)` made from
    // inside a running callback, or a background regeneration that itself calls
    // `after()`, registers more. A single `allSettled` snapshots the array and
    // lets Lambda freeze on that late work.
    let settledCount = 0;
    while (settledCount < pending.length) {
      const batch = pending.slice(settledCount);
      settledCount = pending.length;
      const settled = await Promise.allSettled(batch);
      for (const result of settled) {
        if (result.status === "rejected") {
          console.error("A waitUntil() promise rejected:", result.reason);
        }
      }
    }
  }

  private async route(
    req: ShimIncomingMessage,
    res: ShimServerResponse,
    url: URL,
    body: SplitBody,
    waitUntil: (promise: Promise<unknown>) => void,
    request: RuntimeRequest,
  ): Promise<void> {
    const result = await this.dispatcher.dispatch({
      method: req.method ?? "GET",
      url,
      headers: new Headers(toWebHeaders(req.headers)),
      body: body.forDispatch,
      invokeMiddleware: this.middleware?.invokerFor({
        waitUntil,
        signal: request.signal,
      }),
    });
    body.releaseUnread(result.kind === "middleware-responded");

    applyHeaders(res, result.responseHeaders);
    if (result.status !== undefined) {
      res.statusCode = result.status;
    }

    switch (result.kind) {
      case "entrypoint": {
        let handler: EntrypointHandler;
        try {
          handler = await this.entrypoints.load(result.entrypoint);
        } catch (error) {
          if (!(error instanceof RouteInOtherGroupError)) throw error;
          // A URL the edge sent here only because of its case goes to its
          // canonical spelling, which the edge routes to the owning group.
          const canonical = caseCanonicalPath(
            url.pathname,
            result.resolvedPathname,
            this.options.manifest,
          );
          if (canonical) {
            sendRedirect(res, `${canonical}${url.search}`, 308);
            return;
          }
          if (request.onRouteInOtherGroup) {
            // Explained by the caller of `handleInternally`, which knows why it
            // happened.
            request.onRouteInOtherGroup(error);
          } else {
            // Logged, because it is also what a misrouted group looks like; see
            // `RouteInOtherGroupError` for why it is a 404.
            console.warn(error.message);
          }
          await this.sendUnmatched(
            req,
            res,
            waitUntil,
            { pathname: url.pathname, requestHeaders: result.requestHeaders },
            url,
          );
          return;
        }
        // The invocation target, not the requested URL: `resolveRoutes` has
        // applied rewrites, stripped i18n prefixes, and appended the `nxtP`
        // route params as query values. That is exactly the contract Next.js
        // documents for a proxy in front of a function — `RouteModule.prepare`
        // recovers `params` from these query values — so that contract, not
        // `requestMeta.params`, is how params get passed. The one exception is
        // a capture the contract would corrupt; see `outOfBandRouteParams`.
        const outOfBand = outOfBandRouteParams(
          result.invocationTarget.query,
          result.resolvedPathname,
        );
        const invocationQuery =
          outOfBand?.query ?? result.invocationTarget.query;
        const { pathname } = result.invocationTarget;
        const search = toSearch(invocationQuery);
        req.url = search ? `${pathname}?${search}` : pathname;
        // Middleware may have rewritten request headers via
        // `NextResponse.next({ request: { headers } })`.
        req.headers = toIncomingHttpHeaders(result.requestHeaders);
        // Here, not in `refreshTags`: Next.js awaits that inside the first
        // `'use cache'` lookup, and a wait there cuts the static stage short.
        // Only for a page: nothing else has a static stage to protect, and a
        // route handler that reads the cache waits in `refreshTags` instead.
        if (result.entrypoint.type === "app-page") {
          await catchUpTags();
        }
        await handler(req, asServerResponse(res), {
          waitUntil,
          requestMeta: {
            // The resolved query, stated rather than left to be re-derived.
            //
            // `RouteModule.prepare` runs `handleRewrites` against `req.url`
            // unconditionally, and `req.url` is the *already rewritten* target.
            // A `beforeFiles` rewrite whose condition still holds after it has
            // been applied therefore gets applied twice: in
            // `test/e2e/link-with-api-rewrite` the rule
            // `/:path(.*)` + `has: query json=true` -> `/api/json?from=/:path`
            // matched `/api/json?json=true&from=/some/route/for` a second time
            // and overwrote `from` with `/api/json`. `next start` escapes it
            // because its router leaves `req.url` as the URL the client sent, so
            // the one pass `prepare` makes is the only one.
            //
            // `prepare` prefers this meta over its own `parsedUrl.query`
            // ("when deployed proxies will add query values from resolving the
            // routes to pass to function"), which is the documented division of
            // labour for a proxy in front of a function - and it is the same
            // division the `req.url` above relies on. Setting it does not stop
            // the second rewrite pass, it just stops that pass from being what
            // the route sees.
            query: { ...invocationQuery },
            // Set only for a capture the query contract cannot carry, and then
            // in place of it rather than alongside.
            ...(outOfBand ? { params: outOfBand.params } : {}),
            // Without this, `RouteModule.prepare` falls back to
            // `http://localhost${req.url}` and every absolute URL a route
            // handler builds is wrong. `relativeProjectDir` is deliberately
            // *not* passed: the runtime `chdir`s to the project dir, so the
            // value Next.js inlined at build time ("") is already correct, and
            // `app-page-runtime.js` ignores the requestMeta override anyway.
            initURL: url.href,
            // Feeds `routerServerContext.hostname` (`route-module.js`
            // `getRouterServerContext`). Includes the port, because it is
            // concatenated into absolute URLs.
            hostname: url.host,
            // Both routers call this for a `notFound: true` / `notFound()` that
            // the entrypoint itself cannot render, and fall back to
            // `res.end('This page could not be found')` — no status, no app 404
            // page — when it is absent. The `req`/`res` they pass are the ones
            // handed in just above, so the captured pair is used instead of
            // re-deriving them.
            render404: async () => {
              await this.sendNotFound(
                req,
                res,
                waitUntil,
                this.dispatcher.notFoundFor(url),
              );
            },
            // `res.revalidate()` from a Pages API route. Without it, Next.js
            // falls back to `fetch('https://' + req.headers.host + urlPath)` —
            // and only when `experimental.trustHostHeader` is set, which it is
            // not, so `res.revalidate()` threw
            //
            //   Failed to revalidate /: Invariant: missing internal
            //   router-server-methods this is an internal bug
            //
            // and `test/e2e/revalidate-reason` saw `stale` where `next start`
            // reports `on-demand`: the route still re-rendered, just as an
            // ordinary stale regeneration rather than the on-demand one it
            // asked for.
            //
            // Answering it in process rather than by setting
            // `trustHostHeader`: the fetch path would leave the function, cross
            // CloudFront and come back — a second billed invocation, a
            // dependency on `x-prerender-revalidate` surviving the edge, and a
            // reason to trust a client-supplied `Host`. Next.js's own
            // non-serverless answer is the same shape as this one
            // (`NextServer#revalidate` runs its request handler against a
            // mocked `req`/`res`).
            revalidate: (config: RevalidateConfig) =>
              this.revalidate(config, request),
          },
        });
        // A Pages API route owns the end of its response: `stream.pipe(res)`,
        // an `externalResolver` proxy, or a callback that calls `res.json()`
        // later all return from the handler before they are done writing, and
        // ending here sent an empty 200 and made their writes throw
        // `ERR_STREAM_WRITE_AFTER_END`. `next start`'s `apiResolver` leaves it
        // open too — one that never ends stalls, there as here. `handle` awaits
        // the response itself, so nothing is cut short by returning.
        if (!res.writableEnded && result.entrypoint.type !== "page-api") {
          res.end();
        }
        return;
      }

      case "static-file": {
        const statusPage =
          result.source === "server"
            ? this.statusPageStatus(result.pathname)
            : undefined;
        // `next start` serves a `public/` or `_next/static` file to GET and
        // HEAD only, and `send` would serve it to any method. The same goes for
        // an auto-exported Pages Router page (`base-server.js`
        // `renderToResponseWithComponentsImpl`: a string `Component` answers
        // anything else with a 405), except the 404 and 500 pages.
        if (
          req.method !== "GET" &&
          req.method !== "HEAD" &&
          (result.source !== "server" ||
            (statusPage === undefined && result.filePath.endsWith(".html")))
        ) {
          sendMethodNotAllowed(res);
          return;
        }
        // "ensure correct status is set when visiting a status page directly":
        // `next start` answers `/404` with a 404 and `/500` with a 500, not the
        // 200 their prerendered HTML would otherwise go out with.
        if (statusPage !== undefined) {
          res.statusCode = statusPage;
        }
        const etag = this.options.manifest.config.generateEtags;
        const publicDir = `${publicDirKey(this.options.manifest)}/`;
        const served =
          (await serveStaticFile(
            req,
            res,
            this.options.deploymentRoot,
            result.filePath,
            { etag },
          )) ||
          // Listed but not staged: a Lambda root, whose `public/` is in S3.
          (result.source === "public" &&
            !!this.publicBucket &&
            (await serveS3PublicFile(req, res, {
              bucket: this.publicBucket,
              keyPrefix: this.options.bucketKeyPrefix ?? "",
              file: result.filePath.slice(publicDir.length),
              etag,
            })));
        if (!served) {
          // The routing rule that matched a build asset already set its
          // year-long `immutable` Cache-Control, which `sendUnmatched`
          // replaces: under it the 404 would be cached at the edge and in
          // browsers for that long, and a chunk that shows up on the next
          // deploy would stay missing.
          await this.sendUnmatched(req, res, waitUntil, result, url);
        }
        return;
      }

      case "image-optimization":
        if (!this.images.isEnabled()) {
          await this.sendUnmatched(
            req,
            res,
            waitUntil,
            { pathname: url.pathname, requestHeaders: result.requestHeaders },
            url,
          );
          return;
        }
        req.headers = toIncomingHttpHeaders(result.requestHeaders);
        await this.images.handle(req, res, result.url, waitUntil);
        return;

      case "redirect":
        sendRedirect(res, result.location, result.status);
        return;

      case "external-rewrite":
        await proxyExternal(req, res, result.url, result.requestHeaders);
        return;

      case "middleware-responded":
        await sendWebResponse(res, result.response);
        return;

      case "response":
        res.end();
        return;

      case "not-found":
        await this.sendUnmatched(req, res, waitUntil, result, url);
        return;
    }
  }

  /**
   * 404 or 500 when `pathname` is the prerendered `/404` or `/500` page — under
   * `basePath` and, in an i18n app, any locale (`/fr/404`) — and `undefined`
   * otherwise. `next start` matches the page, not the URL, so the locale does
   * not matter.
   */
  private statusPageStatus(pathname: string): number | undefined {
    const { basePath, i18n } = this.options.manifest.config;
    let page = withoutPathPrefix(pathname, basePath);
    const locales = (i18n as { locales?: readonly string[] } | null)?.locales;
    for (const locale of locales ?? []) {
      const stripped = withoutPathPrefix(page, `/${locale}`);
      if (stripped !== page) {
        page = stripped;
        break;
      }
    }
    if (page === "/404") return 404;
    if (page === "/500") return 500;
    return undefined;
  }

  /**
   * `next start`'s answer to a path nothing serves (`router-server.js`, the
   * "404 case"), for both ways of getting here: dispatch matched nothing, or it
   * matched a build asset that is not in the package.
   *
   * No-store, always. A prerendered `/_not-found` would otherwise send its
   * cache entry's year-long `s-maxage`, and the CDN would keep the 404 past the
   * deploy that adds the route. Set rather than forced: Next's page handlers
   * only write a `Cache-Control` when none is set (`sendRenderResult`,
   * `pages-handler.js`), which is exactly how `next start`'s own no-store here
   * survives the render. `render404` is not this path: a `notFound()` from an
   * ISR page is cacheable for that page's revalidate period.
   *
   * A missing `_next/static` file, and a GET or HEAD whose `Sec-Fetch-Dest`
   * says it cannot display HTML (an `<img>`, a script, a font), get a
   * plain-text `Not Found` instead of the rendered page — nothing would show
   * it, and rendering it is the expensive part.
   *
   * Everything else renders the app's 404 as the path that was asked for, not
   * as `/_not-found`: the App Router serializes the canonical URL into the RSC
   * payload, so a client hydrated off a `/_not-found` payload reports the wrong
   * `usePathname()` and pushes the wrong history entry. It renders with the
   * request headers middleware set, too — a CSP nonce, say.
   */
  private async sendUnmatched(
    req: ShimIncomingMessage,
    res: ShimServerResponse,
    waitUntil: (promise: Promise<unknown>) => void,
    result: { readonly pathname: string; readonly requestHeaders: Headers },
    url: URL,
  ): Promise<void> {
    res.setHeader("Cache-Control", NO_STORE);
    const { basePath, assetPrefix } = this.options.manifest.config;
    const pathname = withoutPathPrefix(
      withoutPathPrefix(result.pathname, basePath),
      assetPrefix,
    );
    if (
      pathname.startsWith("/_next/static/") ||
      ((req.method === "GET" || req.method === "HEAD") &&
        NON_HTML_SEC_FETCH_DESTS.has(
          firstValue(req.headers["sec-fetch-dest"]) ?? "",
        ))
    ) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return;
    }
    req.headers = toIncomingHttpHeaders(result.requestHeaders);
    await this.sendNotFound(
      req,
      res,
      waitUntil,
      this.dispatcher.notFoundFor(url),
      `${result.pathname}${url.search}`,
    );
  }

  /**
   * One on-demand revalidation, run against this runtime rather than over the
   * network. Wired in as `requestMeta.revalidate`; see the comment there.
   *
   * The response is thrown away — only its status matters — but it goes through
   * the full {@link handle}, so the entrypoint sees a request with
   * `x-prerender-revalidate` on it and writes the fresh entry through the cache
   * handler exactly as a request from outside would. `handle` awaits its own
   * `waitUntil` work, so the new entry is committed before `res.revalidate()`
   * resolves, which is what callers that revalidate and then redirect depend on.
   *
   * The accept/throw rule is `NextServer#revalidate`'s, verbatim: a revalidation
   * is successful if it was cached or answered 200, and `notFound: true`
   * legitimately answers 404 for an `unstable_onlyGenerated` caller. Anything
   * else throws, and `res.revalidate()` turns it into `Failed to revalidate
   * <path>: <message>`.
   */
  private async revalidate(
    config: RevalidateConfig,
    origin: RuntimeRequest,
  ): Promise<void> {
    const { head, otherGroup } = await this.handleInternally(
      {
        method: "GET",
        url: config.urlPath,
        // The caller's authority, not the revalidated path's: it is what
        // `absoluteUrl` builds the request URL from, and a revalidation is for
        // the origin being served. The forwarded pair with it — behind
        // CloudFront `host` is the Function URL, and a render that built its
        // absolute URLs from that would cache links to the raw function.
        headers: {
          ...config.headers,
          host: origin.headers.host,
          ...pickDefined(origin.headers, [
            "x-forwarded-host",
            "x-forwarded-proto",
          ]),
        },
        encrypted: origin.encrypted,
        trustForwardedHost: origin.trustForwardedHost,
      },
      {},
    );

    const status = head?.statusCode ?? 500;
    if (otherGroup) {
      const self = process.env[FUNCTION_GROUP_ENV_VAR];
      // A page packaged into another `functionGroups` group: it is rendered in
      // process, and this function does not have the page's code. Checked
      // first because it renders as a 404, which `unstable_onlyGenerated`
      // would otherwise accept.
      throw new Error(
        `Invalid response ${status}: "${config.urlPath}" belongs to ` +
          `\`functionGroups\` group "${otherGroup.owner}", and ` +
          `res.revalidate() can only revalidate pages in the group it runs ` +
          `in ("${self}"). Call it from an API route in group ` +
          `"${otherGroup.owner}", or use revalidatePath()/revalidateTag(), ` +
          `which work from any group.`,
      );
    }
    if (
      head?.headers["x-nextjs-cache"] !== "REVALIDATED" &&
      status !== 200 &&
      !(status === 404 && config.opts.unstable_onlyGenerated)
    ) {
      throw new Error(`Invalid response ${status}`);
    }

    await invalidateRevalidatedPage(config.urlPath, this.options.manifest);
  }

  /**
   * An image optimization source that is not a file: `<Image src="/api/avatar">`
   * served by a route handler. Wired in as the optimizer's `fetchInternal`, and
   * run in process for the reasons {@link revalidate} is — `next start` fetches
   * the source from itself over loopback, which here would be a second billed
   * invocation through CloudFront.
   *
   * Only the authority is forwarded, as `next start`'s `fetchInternalImage`
   * forwards none of the viewer's headers: the source is cached and served to
   * everyone, so it must not depend on one viewer's cookies.
   */
  private async fetchInternal(
    href: string,
    req: ShimIncomingMessage,
    maximumBody: number,
  ): Promise<InternalImageResponse> {
    const request: RuntimeRequest = {
      method: "GET",
      url: href,
      headers: pickDefined(req.headers, [
        "host",
        "x-forwarded-host",
        "x-forwarded-proto",
      ]),
      encrypted: (req.socket as { encrypted?: boolean } | undefined)?.encrypted,
      trustForwardedHost: req.trustForwardedHost,
    };
    const { head, body, otherGroup, tooLarge } = await this.handleInternally(
      request,
      { maximumBody },
    );
    if (tooLarge) {
      return { statusCode: 0, headers: {}, body: Buffer.alloc(0), tooLarge };
    }
    if (otherGroup) {
      // The edge sends every `/_next/image` request to the default group, and
      // the source is rendered in process, so a route packaged into another
      // group is out of reach: the optimizer answers (and logs) a 502.
      return {
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        otherGroup: otherGroup.owner,
      };
    }
    return {
      statusCode: head?.statusCode ?? 0,
      headers: head?.headers ?? {},
      body,
    };
  }

  /**
   * One request through {@link handle}, answered to this runtime instead of a
   * client: the head, the body when it is wanted, and the error when the route
   * is packaged into another `functionGroups` group. `handle` awaits the
   * request's `waitUntil` work too, so whatever the render wrote is committed by
   * the time this resolves.
   *
   * The body is kept only when `maximumBody` is set. One past it fails the
   * response stream, which stops the route writing, and comes back as
   * `tooLarge` rather than held in memory.
   */
  private async handleInternally(
    request: RuntimeRequest,
    options: { readonly maximumBody?: number },
  ): Promise<{
    head?: ResponseHead;
    body: Buffer;
    otherGroup?: RouteInOtherGroupError;
    tooLarge: boolean;
  }> {
    let head: ResponseHead | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let otherGroup: RouteInOtherGroupError | undefined;
    const onRouteInOtherGroup = (error: RouteInOtherGroupError) => {
      otherGroup = error;
    };
    await this.handle(
      { ...request, onRouteInOtherGroup },
      {
        begin(responseHead) {
          head = responseHead;
          return new Writable({
            write(chunk: Buffer, _encoding, callback) {
              if (options.maximumBody === undefined) return callback();
              size += chunk.byteLength;
              if (size > options.maximumBody) {
                tooLarge = true;
                return callback(new Error("Over images.maximumResponseBody"));
              }
              chunks.push(Buffer.from(chunk));
              callback();
            },
          });
        },
      },
    );
    return {
      head,
      body: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks),
      otherGroup,
      tooLarge,
    };
  }

  /**
   * App Router builds an invocable `/_not-found`, Pages Router a prerendered
   * `404.html` (per locale under i18n) or else `/_error`; see `statusTargets`.
   */
  private async sendNotFound(
    req: ShimIncomingMessage,
    res: ShimServerResponse,
    waitUntil: (promise: Promise<unknown>) => void,
    target: StatusTarget,
    /**
     * What to render the 404 as. Omitted by `render404`, which is called
     * mid-render with `req.url` already pointing at the route that gave up —
     * the path Next.js would render that 404 for.
     */
    requestedUrl?: string,
  ): Promise<void> {
    res.statusCode = 404;

    if (target.kind === "entrypoint") {
      const handler = await this.entrypoints.load(target.entrypoint);
      req.url = requestedUrl ?? req.url;
      // App Router's `/_not-found` is a page render too: see `route`.
      if (target.entrypoint.type === "app-page") {
        await catchUpTags();
      }
      await handler(req, asServerResponse(res), { waitUntil });
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    if (
      target.kind === "static-file" &&
      (await this.sendHtmlFile(res, target))
    ) {
      return;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("This page could not be found.");
  }

  /**
   * Turn a thrown error into a response, rendering the app's error page when it
   * has one.
   *
   * Next.js's own page handlers catch, report and then *rethrow* ("rethrow so
   * that we can handle serving error page", `pages-handler.ts`), which makes the
   * error page the host's job — the same division of labor as `render404`. Without
   * this ladder every throw answered a bare `text/plain` 500 and a custom
   * `pages/_error` was dead code (`test/e2e/async-modules`, whose `/make-error`
   * throws in `getServerSideProps`).
   *
   * Once the head is out there is nothing to say — destroying the stream is what
   * tells the client the response is truncated rather than complete.
   */
  private async sendError(
    req: ShimIncomingMessage,
    res: ShimServerResponse,
    waitUntil: (promise: Promise<unknown>) => void,
    error: unknown,
    /** The request, as received: which locale's prerendered 500 to send. */
    url: URL | undefined,
  ): Promise<void> {
    console.error("Unhandled error while handling the request:", error);
    if (res.headersSent) {
      res.destroy(asError(error));
      return;
    }
    res.statusCode = 500;
    // A failed render may have set headers describing a body that never
    // arrived. Every rung below sends a different body, so they go first: a
    // stale `Content-Length` on a 500.html of another size hangs the client or
    // desyncs a keep-alive connection.
    res.removeHeader("Content-Length");
    res.removeHeader("ETag");
    // Every rung, the error-page entrypoint included: otherwise the throwing
    // render's `s-maxage` (or a `headers()` rule's) rides along and CloudFront
    // caches the 500. `next start` sets it before rendering the error page too.
    res.setHeader("Cache-Control", NO_STORE);
    const target = this.errorTargetFor(url);

    if (target.kind === "entrypoint") {
      try {
        const handler = await this.entrypoints.load(target.entrypoint);
        // `req.url` is left alone: the error page renders for the URL that was
        // asked for, and `_error`'s `getInitialProps` reads the status off `res`,
        // which is why the 500 above is set first.
        await handler(req, asServerResponse(res), { waitUntil });
        if (!res.writableEnded) {
          res.end();
        }
        return;
      } catch (errorPageError) {
        console.error(
          "The error page itself failed to render:",
          errorPageError,
        );
        if (res.headersSent) {
          res.destroy(asError(errorPageError));
          return;
        }
      }
    }

    if (
      target.kind === "static-file" &&
      (await this.sendHtmlFile(res, target))
    ) {
      return;
    }

    // Again: an error page that threw may have described its own body too.
    res.removeHeader("Content-Length");
    res.removeHeader("ETag");
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", NO_STORE);
    res.end("Internal Server Error");
  }

  /**
   * A prerendered 404 or 500 page, or `false` when it cannot be read and the
   * caller's plain-text fallback should answer. Read rather than `serveStatic`,
   * which keeps the status already set but would answer a `Range` request with
   * a 206 of the error page, and add `ETag`, `Last-Modified` and, where none is
   * set yet, a public `Cache-Control` to it.
   */
  private async sendHtmlFile(
    res: ShimServerResponse,
    target: { readonly filePath: string },
  ): Promise<boolean> {
    let html: Buffer;
    try {
      html = await readFile(join(this.options.deploymentRoot, target.filePath));
    } catch {
      return false;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return true;
  }
}

/**
 * What next sends with an error it rendered itself. Without it a `Cache-Control`
 * left behind by the render that threw can get a 500 cached at the edge.
 */
const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

/**
 * `Sec-Fetch-Dest` values that can never display an HTML response, from
 * `next/dist/server/lib/is-non-html-sec-fetch-dest.js`. Restated rather than
 * required, because that module is recent and the app's `next` may predate it:
 * a failed require here would turn every 404 into a 500. Excludes `document`,
 * `iframe` and the like, and `empty` — `fetch()`, which is how RSC requests go.
 */
const NON_HTML_SEC_FETCH_DESTS: ReadonlySet<string> = new Set([
  "audio",
  "audioworklet",
  "font",
  "image",
  "json",
  "manifest",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "webidentity",
  "worker",
  "xslt",
]);

/**
 * `INTERNAL_HEADERS` from `next/dist/server/lib/server-ipc/utils.js` (Next
 * 16.3), which `next start` deletes from every request before routing it
 * (`filterInternalHeaders` in `router-server.js`). They are signals between
 * Next's own router and render layers; honoring one a client sent lets it steer
 * those layers — `next-resume` makes a PPR page resume from a postponed state
 * the client supplies. Restated rather than required, like
 * {@link NON_HTML_SEC_FETCH_DESTS}.
 */
const INTERNAL_HEADERS: ReadonlySet<string> = new Set([
  "x-middleware-rewrite",
  "x-middleware-redirect",
  "x-middleware-set-cookie",
  "x-middleware-skip",
  "x-middleware-override-headers",
  "x-middleware-next",
  "x-now-route-matches",
  "x-matched-path",
  "x-nextjs-data",
  "x-next-resume-state-length",
  "next-resume",
]);

/**
 * The request headers with {@link INTERNAL_HEADERS} removed, and `x-nextjs-data`
 * put back for a `_next/data` request, which is what `next start`'s
 * `resolveRoutes` does (`setIsNextDataRequest`) right after stripping it: the
 * header is internal, but Next's handlers and middleware still read it — it is
 * how a data request gets `x-nextjs-matched-path` — so a real data request has
 * to keep it.
 */
export function withoutInternalHeaders(
  headers: IncomingHttpHeaders,
  target: string,
  basePath: string,
): IncomingHttpHeaders {
  const filtered: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!INTERNAL_HEADERS.has(name)) {
      filtered[name] = value;
    }
  }
  const pathname = withoutPathPrefix(target.split("?")[0], basePath);
  if (pathname.startsWith("/_next/data/") && pathname.endsWith(".json")) {
    filtered["x-nextjs-data"] = "1";
  }
  return filtered;
}

/** Every route to invalidate, each once, in one CloudFront invalidation. */
type RevalidatedPageHook = (routes: readonly string[]) => Promise<void>;

/**
 * Invalidate the CDN copies of a page `res.revalidate()` just regenerated: its
 * HTML and RSC payload, and its Pages Router `_next/data` JSON. Without this the
 * fresh entry sat behind CloudFront's copy of the old one for the page's whole
 * `s-maxage` — a year, for an on-demand-only ISR page. `revalidatePath` and
 * `revalidateTag` go through the cache handler's `revalidateTag`, which already
 * invalidates; `res.revalidate()` does not touch it.
 *
 * Every route is without `basePath`, which the hook prefixes. A no-op outside
 * the Global constructs, where no hook is registered.
 */
async function invalidateRevalidatedPage(
  urlPath: string,
  manifest: AdapterManifest,
): Promise<void> {
  const hook = (globalThis as Record<symbol, unknown>)[
    REVALIDATED_PAGE_HOOK
  ] as RevalidatedPageHook | undefined;
  if (typeof hook !== "function") {
    return;
  }
  const route = withoutPathPrefix(
    urlPath.split("?")[0],
    manifest.config.basePath,
  );
  try {
    // One call, deduplicated: the default locale's two pairs share a data
    // route, and each invalidation path counts against CloudFront's quota.
    await hook([...new Set(revalidatedPageRoutes(route, manifest).flat())]);
  } catch (error) {
    // The regeneration itself succeeded; the edge catches up at `s-maxage`.
    console.warn(`Could not invalidate the CDN copy of ${urlPath}:`, error);
  }
}

/**
 * The `[route, dataRoute]` pairs a revalidated page is cached under at the edge.
 *
 * In an i18n app the Next client always puts the locale in a data href, the
 * default locale included (`/_next/data/<id>/en/blog.json`, and `…/en.json` for
 * the root), so the unprefixed data route names nothing CloudFront holds. The
 * page is one locale's — `res.revalidate("/blog")` regenerates the default
 * locale's, `"/fr/blog"` French — and the default locale's HTML is reachable,
 * and cached, both with and without its prefix, so its two pairs share a data
 * route, which the caller sends once.
 */
export function revalidatedPageRoutes(
  route: string,
  manifest: Pick<AdapterManifest, "buildId" | "config">,
): Array<[string, string]> {
  const dataRoute = (page: string) =>
    `/_next/data/${manifest.buildId}${
      page === "/" ? "/index" : page.replace(/\/+$/, "")
    }.json`;
  const i18n = manifest.config.i18n as {
    readonly locales?: readonly string[];
    readonly defaultLocale?: string;
  } | null;
  if (!i18n?.defaultLocale) {
    return [[route, dataRoute(route)]];
  }
  const { defaultLocale } = i18n;
  const segment = route.split("/")[1] ?? "";
  const locale = (i18n.locales ?? []).includes(segment)
    ? segment
    : defaultLocale;
  const page =
    locale === segment ? withoutPathPrefix(route, `/${segment}`) : route;
  const localized = page === "/" ? `/${locale}` : `/${locale}${page}`;
  // The root's data route is the locale itself, not `/<locale>/index`.
  const localizedData = `/_next/data/${manifest.buildId}${localized.replace(/\/+$/, "")}.json`;
  return locale === defaultLocale
    ? [
        [page, localizedData],
        [localized, localizedData],
      ]
    : [[localized, localizedData]];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Read the manifest and pin the layout it describes.
 *
 * `process.cwd()` is load-bearing and there is exactly one chance to get it
 * right: Next.js inlines `relative(buildCwd, projectDir)` into every entrypoint
 * and resolves it against the *runtime* cwd to find
 * `required-server-files.json`, the prerender manifest, and the app's chunks.
 * `assertBuildCwd` in `build-outputs.ts` keeps that inlined value `""`, so the
 * whole invariant reduces to "cwd is the staged project dir" — asserted rather
 * than assumed, because getting it wrong produces a
 * `Cannot find module …/required-server-files.json` from inside compiled Next.js
 * code with no indication that the layout is the problem.
 */
export async function loadRuntime(
  deploymentRoot: string,
): Promise<NextjsRuntime> {
  const manifestPath = deployedManifestPath(deploymentRoot);
  let manifest: AdapterManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Could not read the cdk-nextjs adapter manifest at "${manifestPath}". ` +
        `The deployment package is incomplete: synth copies ` +
        `${MANIFEST_FILE_NAME} in next to the bundled runtime.`,
      { cause: error },
    );
  }

  const projectDir = join(deploymentRoot, manifest.relativeProjectDir);
  const probe = join(
    projectDir,
    manifest.config.distDir,
    "required-server-files.json",
  );
  try {
    await readFile(probe);
  } catch (error) {
    throw new Error(
      `The deployment root "${deploymentRoot}" does not contain the staged ` +
        `Next.js project: expected "${probe}" to exist. Every built entrypoint ` +
        `resolves its own paths against process.cwd(), so this layout is part ` +
        `of the contract, not a convenience.`,
      { cause: error },
    );
  }
  // `next start` forces this, and externalized packages (React for Pages Router
  // SSR, anything in `serverExternalPackages`) pick their dev or prod build from
  // it at require time. The Containers Dockerfiles set it and the Functions
  // constructs do too; this covers a hand-wired function. Before any `require`.
  // (`next`'s typings declare NODE_ENV read-only.)
  (process.env as Record<string, string | undefined>).NODE_ENV ??= "production";
  process.chdir(projectDir);
  // Before anything can serve a request: the runtime's own `next` imports resolve
  // out of the staged app, not out of the shell's directory. See `next-modules.ts`.
  useNextFrom(projectDir);
  // Before any entrypoint can read them at module scope.
  loadEnvFiles(projectDir);
  // Then, before any entrypoint (or middleware) can be loaded: Next's own
  // node-environment bootstrap. See `setupNodeEnvironment`.
  setupNodeEnvironment();
  // And last, once the environment is ready: `register()`, before any entrypoint
  // or middleware module is evaluated. See `registerInstrumentation`.
  await registerInstrumentation(projectDir, manifest.config.distDir);

  return new NextjsRuntime({
    deploymentRoot,
    manifest,
    bucket: process.env.CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME,
    bucketKeyPrefix: process.env.CDK_NEXTJS_STATIC_ASSETS_KEY_PREFIX,
  });
}

/**
 * A syntactically valid `host[:port]`: a registered name or a bracketed IPv6
 * literal, optionally with a port. Anything else cannot be the authority of a
 * URL.
 */
const HOST_AUTHORITY = /^(?:\[[0-9A-Fa-f:.]+\]|[0-9A-Za-z._-]+)(?::\d{1,5})?$/;

/**
 * The first value that is actually usable as an authority, or `undefined`.
 *
 * `x-forwarded-host` can arrive as a list when more than one proxy appends to
 * it. Validating is what keeps a malformed value from making the `URL`
 * constructor throw — which on the Lambda shells is an invocation error and a
 * 502, not a response.
 */
function validAuthority(
  value: string | string[] | undefined,
): string | undefined {
  const candidate = firstValue(value)?.split(",")[0].trim();
  return candidate && HOST_AUTHORITY.test(candidate) ? candidate : undefined;
}

/**
 * `resolveRoutes` needs an absolute URL, and it becomes the origin every
 * absolute URL the app builds starts with — `req.nextUrl.origin` in middleware,
 * `initURL` for a route handler — so its host has to be one the client cannot
 * pick.
 *
 * That is `Host` on every deployment but one: CloudFront forwards the viewer's
 * `Host` to a container origin (`ALL_VIEWER`), an ALB passes it through, and API
 * Gateway sets its own domain. The exception is a Lambda Function URL, where
 * CloudFront has to send the URL's own domain as `Host` and puts the viewer's in
 * `x-forwarded-host`; see {@link RuntimeRequest.trustForwardedHost}. Anywhere
 * else the header is the client's, and honoring it let a request with
 * `X-Forwarded-Host: evil.example` point a password-reset link at evil.example —
 * and, on Global Containers, have CloudFront cache that page, since the header
 * is not in its cache key.
 */
function absoluteUrl(request: RuntimeRequest): URL {
  const host =
    (request.trustForwardedHost
      ? validAuthority(request.headers["x-forwarded-host"])
      : undefined) ??
    validAuthority(request.headers.host) ??
    "localhost";
  // Behind CloudFront on Global Containers the container shell has already put
  // the viewer's protocol here; see `trustCloudFrontProto` in http/node-server.ts.
  const forwardedProto = firstValue(request.headers["x-forwarded-proto"])
    ?.split(",")[0]
    .trim()
    .toLowerCase();
  // Client-supplied where no proxy overwrites it, but harmless: the host is
  // already fixed, and anything but these two would not parse.
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : request.encrypted === false
        ? "http"
        : "https";
  return new URL(request.url, `${proto}://${host}`);
}

function pickDefined(
  headers: IncomingHttpHeaders,
  names: readonly string[],
): IncomingHttpHeaders {
  const picked: IncomingHttpHeaders = {};
  for (const name of names) {
    if (headers[name] !== undefined) {
      picked[name] = headers[name];
    }
  }
  return picked;
}

/**
 * `normalizeRepeatedSlashes` (`next/dist/shared/lib/utils.js`), applied where
 * Next.js applies it: before routing, as a 308 to the collapsed path.
 * `base-server.ts` does `if (urlNoQuery?.match(/(\\|\/\/)/))
 * res.redirect(normalizeRepeatedSlashes(req.url), 308)`, so `/a//b` and `/a\b`
 * both answer a redirect to `/a/b` rather than a 404 - and `@next/routing`'s
 * `resolveRoutes` does not do it for us, which is how `//` reached this runtime as
 * a 500 and `/api//json` as a 404.
 *
 * Encoded backslashes are left alone, as Next.js leaves them: `%5C` is a literal
 * character in a path segment, not a separator.
 *
 * Returns `undefined` when there is nothing to collapse, which is the common case.
 */
function collapseRepeatedSlashes(target: string): string | undefined {
  const parts = target.split("?");
  const pathname = parts[0];
  if (!/\\|\/\//.test(pathname)) {
    return undefined;
  }
  const query = parts.length > 1 ? `?${parts.slice(1).join("?")}` : "";
  return pathname.replace(/\\/g, "/").replace(/\/\/+/g, "/") + query;
}

export interface SplitBody {
  /** What `req` reads: the entrypoint's copy. */
  readonly forRequest?: Readable | Buffer;
  /** What `resolveRoutes` hands middleware. */
  readonly forDispatch: ReadableStream;
  /**
   * Called once dispatch has returned, with whether middleware answered the
   * request itself. Lets go of whichever copy nothing will read any more.
   */
  releaseUnread(middlewareResponded: boolean): void;
}

/**
 * `resolveRoutes` hands `requestBody` to middleware, which consumes it, while the
 * entrypoint needs the same bytes — the same problem `next-server` solves with
 * `getCloneableBody()`. Only split when there is middleware to feed: teeing costs
 * a buffer copy of every upload on a path that would otherwise be a straight pipe.
 *
 * A `tee()` buffers, for the branch that is behind, every chunk the other one
 * has read — so a branch that is never read holds the whole body. Middleware
 * that doesn't read the body is the common case (and its matcher may not even
 * have run it), after which the entrypoint streaming an upload would pile all
 * of it up in the middleware branch: the whole upload in memory, on a
 * container that serves other requests. So once dispatch returns, the branch
 * with no reader left is cancelled — the middleware one, or the entrypoint one
 * when middleware answered and `req` will never be read. Cancelling one
 * branch leaves the source and the other branch running.
 */
export function splitBody(
  body: Readable | Buffer | undefined,
  hasMiddleware: boolean,
): SplitBody {
  const releaseNothing = (): void => {};
  if (body === undefined) {
    return {
      forDispatch: new Blob([]).stream(),
      releaseUnread: releaseNothing,
    };
  }
  if (!hasMiddleware) {
    return {
      forRequest: body,
      forDispatch: new Blob([]).stream(),
      releaseUnread: releaseNothing,
    };
  }
  if (Buffer.isBuffer(body)) {
    // Already fully in memory, so "teeing" is just reading it twice.
    return {
      forRequest: body,
      forDispatch: new Blob([body]).stream(),
      releaseUnread: releaseNothing,
    };
  }
  const [forMiddleware, forEntrypoint] = Readable.toWeb(body).tee();
  const forRequest = Readable.fromWeb(forEntrypoint as never);
  return {
    forRequest,
    forDispatch: forMiddleware as ReadableStream,
    releaseUnread(middlewareResponded) {
      if (middlewareResponded) {
        // `fromWeb` holds the branch's reader, so it is destroyed rather than
        // cancelled; its `_destroy` cancels the reader.
        forRequest.destroy();
      } else if (!forMiddleware.locked) {
        // Locked means middleware took a reader: it is reading, or has read,
        // the body itself, and a locked stream cannot be cancelled anyway.
        forMiddleware.cancel().catch(() => {});
      }
    },
  };
}

/** `IncomingHttpHeaders` → the flat entries a `Headers` constructor accepts. */
function toWebHeaders(headers: IncomingHttpHeaders): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    for (const single of Array.isArray(value) ? value : [value]) {
      entries.push([name, single]);
    }
  }
  return entries;
}

/**
 * `headers()` rules, the immutable `cache-control` for build assets, and anything
 * middleware set with `NextResponse.next({ headers })`. Applied before the
 * entrypoint runs so that a route can still override its own.
 */
function applyHeaders(res: ShimServerResponse, headers: Headers): void {
  for (const [name, value] of headers.entries()) {
    // `entries()` yields `set-cookie` once per cookie, so appending the whole
    // `getSetCookie()` array here would emit N² of them — two cookies set by
    // middleware arrived as ["a=1","b=2","a=1","b=2"]. Handled once, outside.
    if (name === "set-cookie") {
      continue;
    }
    res.setHeader(name, value);
  }
  for (const cookie of headers.getSetCookie()) {
    res.appendHeader("set-cookie", cookie);
  }
}

/**
 * Mirrors Next.js's own redirect response (`base-server.ts`): the destination is
 * also the body, and a 308 carries a `Refresh` header because some clients and
 * intermediaries still do not implement 308.
 */
function sendRedirect(
  res: ShimServerResponse,
  location: string,
  status: number,
): void {
  res.statusCode = status;
  res.setHeader("Location", location);
  if (status === 308) {
    res.setHeader("Refresh", `0;url=${location}`);
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(location);
}

/**
 * `next start`'s answer to a POST, PUT or DELETE for a static file: 405 with
 * `Allow: GET, HEAD` (`router-server.js`). It renders that through `/_error`;
 * this is the plain-text equivalent, since the status and `Allow` are what a
 * client acts on.
 */
function sendMethodNotAllowed(res: ShimServerResponse): void {
  res.statusCode = 405;
  res.setHeader("Allow", "GET, HEAD");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed");
}

/**
 * Request headers {@link proxyExternal} does not forward. The upstream's own
 * `Host` must win; the rest describe our connection, not the proxied one, and
 * undici throws on most of them, which would answer the request with a 500.
 * Next.js's list for the requests it makes with undici (`ipcForbiddenHeaders`,
 * `next/dist/server/lib/server-ipc/utils.js`), plus `host` and `upgrade`, minus
 * `content-encoding`: Next strips that over a body it has already decoded, while
 * this one is forwarded as received, still encoded.
 */
const PROXY_DROPPED_HEADERS: readonly string[] = [
  "host",
  "upgrade",
  "accept-encoding",
  "keepalive",
  "keep-alive",
  "transfer-encoding",
  "connection",
  "expect",
];

/**
 * The SigV4 signature Origin Access Control put on a request to the Function
 * URL, also dropped by {@link proxyExternal} when the request was IAM-verified:
 * forwarded, it would let the third-party origin replay the request against
 * the Function URL. Anywhere else these are the client's own, and are
 * forwarded as `next start` forwards them.
 */
const SIGV4_HEADERS: readonly string[] = [
  "authorization",
  "x-amz-date",
  "x-amz-content-sha256",
  "x-amz-security-token",
];

/** A `next.config` rewrite whose destination is another origin. */
async function proxyExternal(
  req: ShimIncomingMessage,
  res: ShimServerResponse,
  url: URL,
  requestHeaders: Headers,
): Promise<void> {
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const headers = new Headers(requestHeaders);
  for (const name of PROXY_DROPPED_HEADERS) {
    headers.delete(name);
  }
  if (req.trustForwardedHost) {
    for (const name of SIGV4_HEADERS) {
      headers.delete(name);
    }
  }
  const upstream = await fetch(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    redirect: "manual",
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
  await sendWebResponse(res, upstream);
}

/**
 * Headers describing the framing of a body that is no longer the body being
 * sent, dropped from every `Response` {@link sendWebResponse} forwards.
 *
 * A proxied origin's `Response` came back from `fetch`, and so, often, did
 * middleware's own (`return fetch(upstream)` in `proxy.ts`, since middleware
 * runs in process and its `fetch` is undici). undici decodes the body — gzip,
 * deflate, br, zstd — and leaves `content-encoding` and `content-length`
 * describing the encoded bytes it already threw away. Forwarding them emits
 * plaintext labelled `gzip` (the browser fails the whole response with
 * `ERR_CONTENT_DECODING_FAILED`) under a `Content-Length` that is too short,
 * and `shouldGzip` then declines to compress it because `content-encoding` is
 * already set, so nothing downstream repairs it. `transfer-encoding` is
 * hop-by-hop: it described the upstream connection, not this one.
 *
 * Stock Next.js drops the same three from every middleware response
 * (`FORBIDDEN_HEADERS` in `next/dist/server/web/sandbox/sandbox.js`), so
 * middleware cannot label a body it encoded itself there either.
 */
const STALE_FRAMING_HEADERS: ReadonlySet<string> = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

/** Stream a `Response` — middleware's own, or a proxied origin's — into `res`. */
async function sendWebResponse(
  res: ShimServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) {
    res.statusMessage = response.statusText;
  }
  const headers = new Headers(response.headers);
  for (const name of STALE_FRAMING_HEADERS) {
    headers.delete(name);
  }
  applyHeaders(res, headers);
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    // Leaving the loop cancels the body, which is what stops a proxied origin
    // from being read to the end for a client that has already gone.
    if (res.destroyed) {
      return;
    }
    // Paced by the client: without waiting for `drain`, a large proxied body
    // headed for a slow client is buffered whole in memory.
    const accepted = res.write(chunk);
    // Set by the sink when it compresses. Without it the chunk sits in zlib's
    // buffer, and a streamed body — server-sent events through a rewrite, a
    // middleware `ReadableStream` — reaches the client all at once, at the end.
    // Next.js flushes after every chunk for the same reason (`pipe-readable`).
    res.flush?.();
    if (!accepted && !(await drained(res))) {
      return;
    }
  }
  res.end();
}
