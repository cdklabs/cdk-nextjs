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
import { Readable } from "node:stream";
import type { ResolveRoutesQuery } from "@next/routing";
import {
  createDispatcher,
  ErrorTarget,
  NotFoundTarget,
  resolveErrorTarget,
} from "./dispatch";
import { EntrypointRegistry } from "./entrypoints";
import {
  createIncomingMessage,
  ShimIncomingMessage,
  toIncomingHttpHeaders,
} from "./http/request";
import {
  asServerResponse,
  ShimServerResponse,
  splitSetCookie,
} from "./http/response";
import { pipeToSink, ResponseSink } from "./http/sink";
import { RuntimeImageOptimizer } from "./image";
import {
  AdapterManifest,
  deployedManifestPath,
  MANIFEST_FILE_NAME,
} from "./manifest";
import { createMiddlewareRunner, MiddlewareRunner } from "./middleware";
import { setupNodeEnvironment, useNextFrom } from "./next-modules";
import { serveStaticFile } from "./static-files";

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
  private readonly middleware?: MiddlewareRunner;
  private readonly images: RuntimeImageOptimizer;
  /**
   * Resolved here rather than on the Dispatcher, which is per request: the throw
   * this answers can happen before one exists.
   */
  private readonly errorTarget: ErrorTarget;

  public constructor(private readonly options: NextjsRuntimeOptions) {
    const { manifest, deploymentRoot } = options;
    this.entrypoints = new EntrypointRegistry(deploymentRoot, manifest);
    this.errorTarget = resolveErrorTarget(manifest);
    this.images = new RuntimeImageOptimizer({
      deploymentRoot,
      manifest,
      bucket: options.bucket ?? "",
      bucketKeyPrefix: options.bucketKeyPrefix ?? "",
    });
    // The runner is shared — it memoizes the loaded middleware module — while the
    // `invokeMiddleware` callback it produces is per request.
    this.middleware = manifest.middleware
      ? createMiddlewareRunner({
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
    const req = createIncomingMessage({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: body.forRequest,
      remoteAddress: request.remoteAddress,
      encrypted: request.encrypted,
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

    try {
      // Inside the try: `absoluteUrl` builds a `URL` out of the request line and
      // the forwarded headers, and a throw here has to reach the error ladder
      // like any other. Outside it, on the Lambda shells — whose handlers wrap
      // nothing — the same throw is an invocation error and a 502.
      const url = absoluteUrl(request);
      await this.route(req, res, url, body.forDispatch, waitUntil, request);
    } catch (error) {
      await this.sendError(req, res, waitUntil, error);
    }

    await finished;

    // Lambda freezes the execution environment the moment the handler resolves —
    // there is no post-response keepalive — so background work registered with
    // `waitUntil` (notably ISR revalidation) has to be awaited here. After the
    // response stream has closed, so client latency is unaffected; billed
    // duration extends, which is the correct trade against a revalidation that
    // never completes.
    if (pending.length > 0) {
      const settled = await Promise.allSettled(pending);
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
    requestBody: ReadableStream,
    waitUntil: (promise: Promise<unknown>) => void,
    request: RuntimeRequest,
  ): Promise<void> {
    // `middlewareResponse` is the reason the dispatcher is built per request:
    // `resolveRoutes` reports `middlewareResponded` without carrying the
    // `Response`, so the runner hands it back through this closure — and a
    // closure shared across requests would cross-talk under the concurrency the
    // container shell has.
    let middlewareResponse: Response | undefined;
    const dispatcher = createDispatcher({
      manifest: this.options.manifest,
      invokeMiddleware: this.middleware?.invokerFor(
        { waitUntil, signal: request.signal },
        (response) => {
          middlewareResponse = response;
        },
      ),
    });

    const result = await dispatcher.dispatch({
      method: req.method ?? "GET",
      url,
      headers: new Headers(toWebHeaders(req.headers)),
      body: requestBody,
    });

    applyHeaders(res, result.responseHeaders);
    if (result.status !== undefined) {
      res.statusCode = result.status;
    }

    switch (result.kind) {
      case "entrypoint": {
        const handler = await this.entrypoints.load(result.entrypoint);
        // The invocation target, not the requested URL: `resolveRoutes` has
        // applied rewrites, stripped i18n prefixes, and appended the `nxtP`
        // route params as query values. That is exactly the contract Next.js
        // documents for a proxy in front of a function — `RouteModule.prepare`
        // recovers `params` from these query values — and it is why nothing here
        // passes `requestMeta.params`.
        req.url = formatTarget(result.invocationTarget);
        // Middleware may have rewritten request headers via
        // `NextResponse.next({ request: { headers } })`.
        req.headers = toIncomingHttpHeaders(result.requestHeaders);
        await handler(req, asServerResponse(res), {
          waitUntil,
          requestMeta: {
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
              await this.sendNotFound(req, res, waitUntil, dispatcher.notFound);
            },
          },
        });
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      case "static-file": {
        const served = await serveStaticFile(
          req,
          res,
          this.options.deploymentRoot,
          result.filePath,
        );
        if (!served) {
          await this.sendNotFound(req, res, waitUntil, dispatcher.notFound);
        }
        return;
      }

      case "image-optimization":
        req.headers = toIncomingHttpHeaders(result.requestHeaders);
        await this.images.handle(req, res, result.url);
        return;

      case "redirect":
        sendRedirect(res, result.location, result.status);
        return;

      case "external-rewrite":
        await proxyExternal(req, res, result.url, result.requestHeaders);
        return;

      case "middleware-responded":
        await sendWebResponse(res, middlewareResponse);
        return;

      case "response":
        res.end();
        return;

      case "not-found":
        req.headers = toIncomingHttpHeaders(result.requestHeaders);
        // Rendered as the path that was asked for, not as `/_not-found`: the
        // App Router serializes the canonical URL into the RSC payload, so a
        // client hydrated off a `/_not-found` payload reports the wrong
        // `usePathname()` and pushes the wrong history entry. `next start`
        // renders the not-found module against the original URL too.
        await this.sendNotFound(
          req,
          res,
          waitUntil,
          result.notFound,
          `${result.pathname}${url.search}`,
        );
        return;
    }
  }

  /**
   * App Router builds an invocable `/_not-found`, Pages Router `/_error`, and an
   * app with neither may still have prerendered `404.html`. The ladder is
   * resolved once at construction by the Dispatcher.
   */
  private async sendNotFound(
    req: ShimIncomingMessage,
    res: ShimServerResponse,
    waitUntil: (promise: Promise<unknown>) => void,
    target: NotFoundTarget,
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
      await handler(req, asServerResponse(res), { waitUntil });
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    if (target.kind === "static-file") {
      // Read rather than `serveStatic`: `send` owns the status code and would
      // answer 200 for the 404 body.
      try {
        const html = await readFile(
          join(this.options.deploymentRoot, target.filePath),
        );
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      } catch {
        // Fall through to the plain-text 404.
      }
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
  ): Promise<void> {
    console.error("Unhandled error while handling the request:", error);
    if (res.headersSent) {
      res.destroy(asError(error));
      return;
    }
    res.statusCode = 500;
    const target = this.errorTarget;

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

    if (target.kind === "static-file") {
      try {
        const html = await readFile(
          join(this.options.deploymentRoot, target.filePath),
        );
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", NO_STORE);
        res.end(html);
        return;
      } catch {
        // Fall through to the plain-text 500.
      }
    }

    // A failed render may have set headers describing a body that never arrived.
    res.removeHeader("Content-Length");
    res.removeHeader("ETag");
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", NO_STORE);
    res.end("Internal Server Error");
  }
}

/**
 * What next sends with an error it rendered itself. Without it a `Cache-Control`
 * left behind by the render that threw can get a 500 cached at the edge.
 */
const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

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
  process.chdir(projectDir);
  // Before anything can serve a request: the runtime's own `next` imports resolve
  // out of the staged app, not out of the shell's directory. See `next-modules.ts`.
  useNextFrom(projectDir);
  // Then, before any entrypoint (or middleware) can be loaded: Next's own
  // node-environment bootstrap. See `setupNodeEnvironment`.
  setupNodeEnvironment();

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
 * The first forwarded value that is actually usable as an authority, or
 * `undefined`.
 *
 * Both headers can arrive as a list when more than one proxy appends to them,
 * and the value reaches us straight from the client on the deployments whose
 * edge does not overwrite it: the CloudFront function that pins
 * `x-forwarded-host` is only attached for function compute
 * (`NextjsDistribution`), so Containers (`ALL_VIEWER`) and the Regional types
 * forward whatever the viewer sent. Validating is what keeps a header like
 * `X-Forwarded-Host: exa mple.com` from making the `URL` constructor throw —
 * which on the Lambda shells is an invocation error and a 502, not a response.
 */
function forwardedAuthority(
  value: string | string[] | undefined,
): string | undefined {
  const candidate = first(value)?.split(",")[0].trim();
  return candidate && HOST_AUTHORITY.test(candidate) ? candidate : undefined;
}

/**
 * `resolveRoutes` needs an absolute URL. The forwarded headers are trusted
 * because every supported deployment puts CloudFront, an ALB, or API Gateway in
 * front, and all three set them; `x-forwarded-host` wins over `host` because
 * CloudFront rewrites `host` to the origin domain. Only their *syntax* is
 * checked, not their value — an app that must not accept an arbitrary
 * `x-forwarded-host` needs the edge to overwrite it.
 */
function absoluteUrl(request: RuntimeRequest): URL {
  const host =
    forwardedAuthority(request.headers["x-forwarded-host"]) ??
    forwardedAuthority(request.headers.host) ??
    "localhost";
  const forwardedProto = first(request.headers["x-forwarded-proto"])
    ?.split(",")[0]
    .trim()
    .toLowerCase();
  // Same reasoning as the authority: client-supplied on the deployments whose
  // edge does not overwrite it, and anything but these two would not parse.
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : request.encrypted === false
        ? "http"
        : "https";
  return new URL(request.url, `${proto}://${host}`);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `resolveRoutes` hands `requestBody` to middleware, which consumes it, while the
 * entrypoint needs the same bytes — the same problem `next-server` solves with
 * `getCloneableBody()`. Only split when there is middleware to feed: teeing costs
 * a buffer copy of every upload on a path that would otherwise be a straight pipe.
 */
function splitBody(
  body: Readable | Buffer | undefined,
  hasMiddleware: boolean,
): { forRequest?: Readable | Buffer; forDispatch: ReadableStream } {
  if (body === undefined) {
    return { forDispatch: emptyStream() };
  }
  if (!hasMiddleware) {
    return { forRequest: body, forDispatch: emptyStream() };
  }
  if (Buffer.isBuffer(body)) {
    // Already fully in memory, so "teeing" is just reading it twice.
    return { forRequest: body, forDispatch: bufferStream(body) };
  }
  const [forMiddleware, forEntrypoint] = Readable.toWeb(body).tee();
  return {
    forRequest: Readable.fromWeb(forEntrypoint as never),
    forDispatch: forMiddleware as ReadableStream,
  };
}

function emptyStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function bufferStream(body: Buffer): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
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

function formatTarget(target: {
  pathname: string;
  query: ResolveRoutesQuery;
}): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(target.query)) {
    for (const single of Array.isArray(value) ? value : [value]) {
      search.append(name, single);
    }
  }
  const query = search.toString();
  return query ? `${target.pathname}?${query}` : target.pathname;
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
  // The upstream's own `Host` must win, and the hop-by-hop headers describe our
  // connection, not the proxied one.
  for (const name of ["host", "connection", "transfer-encoding"]) {
    headers.delete(name);
  }
  const upstream = await fetch(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    redirect: "manual",
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
  await sendWebResponse(res, upstream, { bodyWasDecoded: true });
}

interface SendWebResponseOptions {
  /**
   * The body no longer matches the `content-encoding` and `content-length` the
   * upstream sent, so both are dropped.
   *
   * True for anything that came back from `fetch`: undici decodes the body —
   * gzip, deflate, br, zstd — and leaves those two headers in place describing
   * the encoded bytes it already threw away. Forwarding them emits plaintext
   * labelled `gzip` (the browser fails the whole response with
   * `ERR_CONTENT_DECODING_FAILED`) under a `Content-Length` that is too short,
   * and `shouldGzip` then declines to compress it because `content-encoding` is
   * already set, so nothing downstream repairs it. Not true for middleware's own
   * `Response`, whose body is whatever the app produced: middleware that encodes
   * its own body and labels it means it.
   */
  readonly bodyWasDecoded?: boolean;
}

/** Stream a `Response` — middleware's own, or a proxied origin's — into `res`. */
async function sendWebResponse(
  res: ShimServerResponse,
  response: Response | undefined,
  options: SendWebResponseOptions = {},
): Promise<void> {
  if (!response) {
    // `resolveRoutes` said middleware responded but the runner never saw a
    // `Response`. Unreachable unless the two disagree, and a silent 200 with an
    // empty body would be far harder to diagnose than this.
    throw new Error(
      "Middleware responded but its Response was not captured. This is a bug " +
        "in the cdk-nextjs runtime, not in your app.",
    );
  }
  res.statusCode = response.status;
  if (response.statusText) {
    res.statusMessage = response.statusText;
  }
  response.headers.forEach((value, name) => {
    if (name === "set-cookie") {
      for (const cookie of splitSetCookie(value)) {
        res.appendHeader("set-cookie", cookie);
      }
      return;
    }
    if (
      options.bodyWasDecoded &&
      (name === "content-encoding" || name === "content-length")
    ) {
      // See `SendWebResponseOptions.bodyWasDecoded`.
      return;
    }
    res.setHeader(name, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
}
