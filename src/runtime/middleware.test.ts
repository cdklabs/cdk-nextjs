import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher, DispatchRequest } from "./dispatch";
import { AdapterManifest } from "./manifest";
import {
  createMiddlewareRunner,
  MiddlewareHandler,
  MiddlewarePerRequest,
} from "./middleware";
import appPlayground from "../adapter/__fixtures__/app-playground.json";
import {
  BuildCompleteContext,
  buildAdapterManifest,
} from "../adapter/build-outputs";

const fixtureContext = structuredClone(
  appPlayground,
) as unknown as BuildCompleteContext;
// The fixture's project dir is a synthetic `/repo/…` path, so the build cwd has
// to be stated; see `assertBuildCwd`.
const manifest: AdapterManifest = buildAdapterManifest(fixtureContext, {
  buildCwd: fixtureContext.projectDir,
}).manifest;

const ORIGIN = "https://example.test";

function request(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): DispatchRequest {
  return {
    method: init.method ?? "GET",
    url: new URL(url, ORIGIN),
    headers: new Headers({ host: "example.test", ...init.headers }),
    body: new ReadableStream({
      start(controller) {
        if (init.body !== undefined) {
          controller.enqueue(new TextEncoder().encode(init.body));
        }
        controller.close();
      },
    }),
  };
}

function runnerFor(handler: MiddlewareHandler) {
  return createMiddlewareRunner({
    middleware: manifest.middleware!,
    root: "/unused-because-loadHandler-is-set",
    loadHandler: async () => handler,
  });
}

/** Dispatch a request through a `Dispatcher` backed by `handler`. */
function dispatchThrough(
  handler: MiddlewareHandler,
  dispatchRequest: DispatchRequest,
  perRequest?: MiddlewarePerRequest,
) {
  const runner = runnerFor(handler);
  return createDispatcher({
    manifest,
    invokeMiddleware: runner.invokerFor(perRequest),
  }).dispatch(dispatchRequest);
}

describe("MiddlewareRunner request construction", () => {
  it("gives middleware the real method, url and headers", async () => {
    const seen: Request[] = [];
    await dispatchThrough(
      async (incoming) => {
        seen.push(incoming);
        return next();
      },
      request("/isr/1?q=1", { headers: { "x-caller": "yes" } }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe(`${ORIGIN}/isr/1?q=1`);
    expect(seen[0].headers.get("x-caller")).toBe("yes");
  });

  it("attaches the body for methods that can have one", async () => {
    const bodies: (string | null)[] = [];
    await dispatchThrough(
      async (incoming) => {
        bodies.push(await incoming.text());
        return next();
      },
      request("/api/health", { method: "POST", body: "payload" }),
    );
    expect(bodies).toEqual(["payload"]);
  });

  it("omits the body for GET and HEAD", async () => {
    // `new Request(url, { body })` throws for these, so the runner must not
    // attach the stream at all.
    for (const method of ["GET", "HEAD", "get"]) {
      const seen: Request[] = [];
      await dispatchThrough(
        async (incoming) => {
          seen.push(incoming);
          return next();
        },
        request("/isr/1", { method }),
      );
      expect(seen[0].body).toBeNull();
    }
  });

  it("passes waitUntil and requestMeta straight through", async () => {
    const waited: Promise<unknown>[] = [];
    const requestMeta = { relativeProjectDir: "app-playground" };
    let received: MiddlewarePerRequest | undefined;
    await dispatchThrough(
      async (_incoming, ctx) => {
        received = ctx;
        ctx.waitUntil?.(Promise.resolve("logged"));
        return next();
      },
      request("/isr/1"),
      { waitUntil: (promise) => waited.push(promise), requestMeta },
    );
    expect(received?.requestMeta).toBe(requestMeta);
    expect(waited).toHaveLength(1);
  });

  it("loads the handler at most once across requests", async () => {
    let loads = 0;
    const runner = createMiddlewareRunner({
      middleware: manifest.middleware!,
      root: "/unused",
      loadHandler: async () => {
        loads += 1;
        return async () => next();
      },
    });
    const dispatcher = createDispatcher({
      manifest,
      invokeMiddleware: runner.invokerFor(),
    });
    await dispatcher.dispatch(request("/isr/1"));
    await dispatcher.dispatch(request("/isr/2"));
    // A fresh invoker for a later request must reuse the loaded handler.
    await createDispatcher({
      manifest,
      invokeMiddleware: runner.invokerFor(),
    }).dispatch(request("/isr/3"));
    expect(loads).toBe(1);
  });

  it("attributes a middleware throw to middleware", async () => {
    await expect(
      dispatchThrough(async () => {
        throw new Error("boom");
      }, request("/isr/1")),
    ).rejects.toThrow(
      /Middleware \(.*middleware\.js\) threw while handling GET/,
    );
  });
});

describe("MiddlewareRunner response translation", () => {
  it("treats NextResponse.next() as a pass-through", async () => {
    const result = await dispatchThrough(async () => next(), request("/isr/1"));
    expect(result.kind).toBe("entrypoint");
  });

  it("forwards request headers set via the x-middleware-* protocol", async () => {
    // This is the real wire format behind `NextResponse.next({ request: { headers } })`,
    // and the reason dispatch captures `MiddlewareResult.requestHeaders`:
    // `resolveRoutes` itself drops them.
    const result = await dispatchThrough(
      async () =>
        new Response(null, {
          status: 200,
          headers: {
            "x-middleware-next": "1",
            "x-middleware-override-headers": "host,x-user",
            "x-middleware-request-host": "example.test",
            "x-middleware-request-x-user": "42",
          },
        }),
      request("/isr/1"),
    );
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.requestHeaders.get("x-user")).toBe("42");
  });

  it("returns response headers middleware set", async () => {
    const result = await dispatchThrough(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "x-middleware-next": "1", "x-flag": "on" },
        }),
      request("/isr/1"),
    );
    expect(result.responseHeaders.get("x-flag")).toBe("on");
  });

  it("turns an internal x-middleware-rewrite into the rewritten entrypoint", async () => {
    const result = await dispatchThrough(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "x-middleware-rewrite": `${ORIGIN}/api/health` },
        }),
      request("/isr/1"),
    );
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.resolvedPathname).toBe("/api/health");
  });

  it("turns an external x-middleware-rewrite into a proxy target", async () => {
    const result = await dispatchThrough(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "x-middleware-rewrite": "https://upstream.test/x" },
        }),
      request("/isr/1"),
    );
    expect(result.kind).toBe("external-rewrite");
  });

  it("turns a location header into a redirect", async () => {
    const result = await dispatchThrough(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: `${ORIGIN}/login` },
        }),
      request("/isr/1"),
    );
    // A same-origin `location` comes back relative: `resolveRoutes` emits the
    // path, not the absolute URL middleware wrote. Matches `next start`.
    expect(result).toMatchObject({
      kind: "redirect",
      status: 307,
      location: "/login",
    });
  });

  it("treats a middleware-authored response as the response", async () => {
    // No `x-middleware-next` and no rewrite: middleware answered the request.
    const result = await dispatchThrough(
      async () => new Response("denied", { status: 401 }),
      request("/isr/1"),
    );
    expect(result.kind).toBe("middleware-responded");
  });
});

describe("MiddlewareRunner module loading", () => {
  /** Writes a CJS middleware module and returns the root to resolve it from. */
  async function writeModule(source: string) {
    const root = await mkdtemp(join(tmpdir(), "cdk-nextjs-middleware-"));
    await writeFile(join(root, "middleware.js"), source);
    return root;
  }

  const invoke = (root: string) =>
    createMiddlewareRunner({
      middleware: { id: "/_middleware", filePath: "middleware.js", env: {} },
      root,
    }).invokerFor()({
      method: "GET",
      url: new URL(`${ORIGIN}/isr/1`),
      headers: new Headers({ host: "example.test" }),
      requestBody: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });

  it("loads a module that exports handler directly", async () => {
    const root = await writeModule(
      `exports.handler = async () => new Response(null, { headers: { "x-middleware-next": "1", "x-flag": "sync" } });`,
    );
    const result = await invoke(root);
    expect(result.responseHeaders?.get("x-flag")).toBe("sync");
  });

  it("awaits a module whose exports are a promise", async () => {
    // Turbopack's async-module shape: `module.exports` is a Promise. A real
    // `.next/server/middleware.js` built by Turbopack looks exactly like this.
    const root = await writeModule(
      `module.exports = Promise.resolve({ handler: async () => new Response(null, { headers: { "x-middleware-next": "1", "x-flag": "async" } }) });`,
    );
    const result = await invoke(root);
    expect(result.responseHeaders?.get("x-flag")).toBe("async");
  });

  it("reports a missing module as an incomplete package", async () => {
    const root = await mkdtemp(join(tmpdir(), "cdk-nextjs-middleware-"));
    await expect(invoke(root)).rejects.toThrow(
      /Could not load middleware from .*middleware\.js.*deployment package is incomplete/s,
    );
  });

  it("reports a module without a handler export", async () => {
    const root = await writeModule(`module.exports = { nope: 1 };`);
    await expect(invoke(root)).rejects.toThrow(
      /does not export a `handler` function \(got undefined\)/,
    );
  });
});

/** The wire form of `NextResponse.next()`. */
function next(): Response {
  return new Response(null, {
    status: 200,
    headers: { "x-middleware-next": "1" },
  });
}
