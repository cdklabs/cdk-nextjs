/* eslint-disable import/no-extraneous-dependencies */
/**
 * The middleware runner: the `invokeMiddleware` callback `resolveRoutes` calls,
 * and nothing more.
 *
 * Deliberately small. Two things that look like they belong here do not:
 *
 * - **Matcher evaluation.** `resolveRoutes` gates middleware itself from
 *   `routes.middlewareMatchers`, which Next builds with the
 *   `x-prerender-revalidate` `missing` rule already injected — so ISR
 *   revalidation requests skip user middleware with no work here.
 * - **The `x-middleware-*` header protocol.** `@next/routing` exports
 *   `responseToMiddlewareResult`, which translates
 *   `x-middleware-override-headers` / `x-middleware-request-*` /
 *   `x-middleware-rewrite` / `location` / `x-middleware-refresh` into a
 *   `MiddlewareResult`. Hand-rolling that is how the previous implementation
 *   drifted from `next start`.
 */
import { join } from "node:path";
import { responseToMiddlewareResult } from "@next/routing";
import { MiddlewareInvoker } from "./dispatch";
import { loadBuiltModule, requireFunctionExport } from "./load-module";
import { AdapterMiddleware } from "./manifest";

/**
 * The adapter-facing export of `.next/server/middleware.js`.
 *
 * Web-style (`Request` in, `Response` out) even for `runtime: "nodejs"` — see
 * `next/dist/build/templates/middleware.js`. Next's own `next-server` reaches
 * the same module through its *default* export with an internal
 * `{ handler, request, page }` options object; that path is not ours.
 */
export type MiddlewareHandler = (
  request: Request,
  ctx: MiddlewarePerRequest,
) => Promise<Response>;

/** Per-request context handed to {@link MiddlewareHandler}. */
export interface MiddlewarePerRequest {
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly signal?: AbortSignal;
  readonly requestMeta?: unknown;
}

export interface MiddlewareRunnerOptions {
  readonly middleware: AdapterMiddleware;
  /**
   * Absolute path the manifest's repo-root-relative `filePath`s resolve against
   * — the staging tree root, which is `process.cwd()` at runtime.
   */
  readonly root: string;
  /** Test seam, and step 4's hook for a preloaded handler. */
  readonly loadHandler?: () => Promise<MiddlewareHandler>;
}

/**
 * Methods that cannot carry a body. `new Request(url, { body })` throws for
 * these, so the stream is simply not attached.
 */
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export class MiddlewareRunner {
  /**
   * Memoized across requests: loading `.next/server/middleware.js` pulls in the
   * app's whole middleware closure, which is cold-start-expensive and must not
   * be repeated. Held as the promise so concurrent first requests share it.
   */
  private handler?: Promise<MiddlewareHandler>;

  public constructor(private readonly options: MiddlewareRunnerOptions) {}

  /**
   * The `invokeMiddleware` callback for one request. Created per request because
   * `waitUntil` / `signal` / `requestMeta` are per-request while the loaded
   * handler is not.
   */
  public invokerFor(
    perRequest: MiddlewarePerRequest = {},
    /**
     * Receives the raw `Response` middleware returned. `resolveRoutes` reports
     * `middlewareResponded: true` without carrying the response, so this is the
     * only way the caller can stream middleware's own body.
     */
    onResponse?: (response: Response) => void,
  ): MiddlewareInvoker {
    return async ({ url, headers, requestBody, method }) => {
      const handler = await this.load();
      const hasBody = !BODYLESS_METHODS.has(method.toUpperCase());
      const request = new Request(url, {
        method,
        headers,
        body: hasBody ? requestBody : undefined,
        // Required by undici whenever the body is a stream, and absent from
        // TypeScript's `RequestInit`.
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);

      let response: Response;
      try {
        response = await handler(request, perRequest);
      } catch (error) {
        // Middleware runs on every request, so an unattributed stack here is
        // expensive to debug. Rethrown, not swallowed: the caller turns it into
        // a 500, the same as `next start`.
        throw new Error(
          `Middleware (${this.options.middleware.filePath}) threw while ` +
            `handling ${method} ${url.pathname}`,
          { cause: error },
        );
      }

      onResponse?.(response);

      // Mutates `headers` in place as well as returning the result, which is
      // why dispatch hands it a copy it owns.
      return responseToMiddlewareResult(response, headers, url);
    };
  }

  private load(): Promise<MiddlewareHandler> {
    this.handler ??= this.options.loadHandler
      ? this.options.loadHandler()
      : loadMiddlewareHandler(this.options.root, this.options.middleware);
    return this.handler;
  }
}

export function createMiddlewareRunner(
  options: MiddlewareRunnerOptions,
): MiddlewareRunner {
  return new MiddlewareRunner(options);
}

/** `require` the built middleware module and pull `handler` off it. */
async function loadMiddlewareHandler(
  root: string,
  middleware: AdapterMiddleware,
): Promise<MiddlewareHandler> {
  const absolute = join(root, middleware.filePath);
  let exports: unknown;
  try {
    exports = await loadBuiltModule(absolute);
  } catch (error) {
    throw new Error(
      `Could not load middleware from "${absolute}" (manifest filePath ` +
        `"${middleware.filePath}"). The deployment package is incomplete.`,
      { cause: error },
    );
  }
  return requireFunctionExport<MiddlewareHandler>(
    exports,
    "handler",
    () => `Middleware at "${absolute}"`,
  );
}
