/* eslint-disable import/no-extraneous-dependencies */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import { S3Client } from "@aws-sdk/client-s3";
import {
  loadRuntime,
  NextjsRuntime,
  revalidatedPageRoutes,
  RuntimeRequest,
  splitBody,
  withoutInternalHeaders,
} from "./core";
import {
  BuildCompleteContext,
  buildAdapterManifest,
} from "../adapter/build-outputs";
import { createIncomingMessage } from "./http/request";
import { ResponseHead } from "./http/response";
import { ResponseSink } from "./http/sink";
import {
  AdapterManifest,
  deployedManifestPath,
  PUBLIC_FILES_FILE_NAME,
  RUNTIME_DIR_NAME,
} from "./manifest";
import appPlayground from "../adapter/__fixtures__/app-playground.json";

/**
 * Every entrypoint in the staged tree is this module. It reports back what the
 * runtime handed it — the rewritten `req.url`, the `requestMeta` fields Next.js
 * reads, the cwd — which is the whole contract between the runtime and a real
 * built entrypoint, and it is otherwise only observable by running Next.js.
 */
const ENTRYPOINT_STUB = `
const { writeFileSync } = require("node:fs");
exports.handler = async (req, res, ctx) => {
  const url = new URL(req.url, "https://stub.test");
  if (url.searchParams.has("boomEverywhere")) {
    throw new Error("the error page exploded too");
  }
  // Same recursion guard as \`render404\` below: the error page is rendered for
  // the URL that was asked for, so an unguarded throw would repeat forever.
  if (url.searchParams.has("boom") && !__filename.includes("_error")) {
    // A render that described its body before it threw.
    res.setHeader("Content-Length", "1234");
    res.setHeader("ETag", '"stale"');
    // What \`getServerSideProps\` (or a \`headers()\` rule) can leave behind.
    res.setHeader("Cache-Control", "s-maxage=60");
    throw new Error("route exploded");
  }
  // What both routers do for \`notFound()\` they cannot render themselves. Only
  // the route that gave up does it: the runtime renders the 404 against the
  // *same* URL, so the not-found module reaching here again would recurse.
  if (url.searchParams.has("render404") && !__filename.includes("_not-found")) {
    await ctx.requestMeta.render404();
    return;
  }
  // \`res.revalidate(target)\` from a Pages API route, spelled out: the runtime
  // supplies \`requestMeta.revalidate\`, and what comes back is either nothing or
  // the \`Invalid response <status>\` this reports.
  if (url.searchParams.has("revalidate")) {
    let error = null;
    try {
      await ctx.requestMeta.revalidate({
        urlPath: url.searchParams.get("revalidate"),
        headers: { "x-prerender-revalidate": "preview-id" },
        opts: {},
      });
    } catch (err) {
      error = err.message;
    }
    res.end(JSON.stringify({ revalidated: error === null, error }));
    return;
  }
  // Lets a test see the request a revalidation rendered, whose response the
  // runtime discards.
  if (url.searchParams.has("recordOrigin")) {
    writeFileSync(process.env.CDK_NEXTJS_TEST_MARKER, ctx.requestMeta.initURL);
  }
  // Lets a revalidation target answer something other than 200.
  if (url.searchParams.has("status")) {
    res.statusCode = Number(url.searchParams.get("status"));
  }
  // What a prerendered \`/_not-found\` does: it sends the Cache-Control of its
  // own cache entry, a year for one that never revalidates — but only when the
  // response has none yet, as \`sendRenderResult\` and \`pages-handler.js\` do.
  if (url.searchParams.has("cacheControl") && !res.getHeader("Cache-Control")) {
    res.setHeader("Cache-Control", url.searchParams.get("cacheControl"));
  }
  // A route that reads its request body, reporting what arrived.
  if (url.searchParams.has("readBody")) {
    let length = 0;
    for await (const chunk of req) length += chunk.length;
    res.end(JSON.stringify({ bodyLength: length }));
    return;
  }
  // A Pages API route that returns before it is done writing: what
  // \`stream.pipe(res)\` and a callback-style \`res.json()\` both look like.
  if (url.searchParams.has("endLater")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.write("first,");
    setTimeout(() => res.end("second"), 10);
    return;
  }
  // What Next's \`AfterContext\` does: work registered with \`waitUntil\` after
  // the response, from inside work that was itself registered with it.
  if (url.searchParams.has("lateWaitUntil")) {
    ctx.waitUntil(
      new Promise((resolve) =>
        setTimeout(() => {
          ctx.waitUntil(
            new Promise((resolveLate) =>
              setTimeout(() => {
                writeFileSync(process.env.CDK_NEXTJS_TEST_MARKER, "late");
                resolveLate();
              }, 10),
            ),
          );
          resolve();
        }, 10),
      ),
    );
  }
  if (url.searchParams.has("waitUntil")) {
    ctx.waitUntil(
      new Promise((resolve) =>
        setTimeout(() => {
          writeFileSync(process.env.CDK_NEXTJS_TEST_MARKER, "done");
          resolve();
        }, 10),
      ),
    );
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    JSON.stringify({
      file: __filename,
      url: req.url,
      initURL: ctx.requestMeta && ctx.requestMeta.initURL,
      hostname: ctx.requestMeta && ctx.requestMeta.hostname,
      query: ctx.requestMeta && ctx.requestMeta.query,
      params: (ctx.requestMeta && ctx.requestMeta.params) || null,
      hasRender404: Boolean(ctx.requestMeta && ctx.requestMeta.render404),
      waitUntil: typeof ctx.waitUntil,
      cwd: process.cwd(),
      header: req.headers["x-from-middleware"] || null,
      nextResume: req.headers["next-resume"] || null,
      matchedPath: req.headers["x-matched-path"] || null,
      cookie: req.headers.cookie || null,
    }),
  );
};
`;

/**
 * `NextResponse.next({ request: { headers } })`, spelled out in the wire protocol
 * Next.js uses: `x-middleware-override-headers` lists *every* request header the
 * route should see — dropping one here is how a real app loses `accept-encoding`.
 */
const MIDDLEWARE_STUB = `
exports.handler = async (request) => {
  const headers = new Headers({ "x-middleware-next": "1" });
  const names = [];
  request.headers.forEach((value, name) => {
    names.push(name);
    headers.set("x-middleware-request-" + name, value);
  });
  names.push("x-from-middleware");
  headers.set("x-middleware-request-x-from-middleware", "yes");
  headers.set("x-middleware-override-headers", names.join(","));
  return new Response(null, { headers });
};
`;

class CollectingSink implements ResponseSink {
  public head?: ResponseHead;
  public readonly chunks: Buffer[] = [];

  public constructor(public readonly padEmptyBody = false) {}

  public begin(head: ResponseHead): Writable {
    this.head = head;
    const chunks = this.chunks;
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
  }

  public get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function write(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const FAVICON = Buffer.from("00000100-fake-icon", "utf-8");
const NOT_FOUND_HTML = "<html><body>prerendered 404</body></html>";
const ERROR_HTML = "<html><body>prerendered 500</body></html>";
/**
 * What a container image copies into `public/`. Names `send` and the exact
 * match in `@next/routing` each got wrong: a `%` that is not an escape, one that
 * looks like one next to the file it decodes to, and an `@` a browser leaves
 * alone.
 */
const PUBLIC_FILES: Record<string, string> = {
  "test.txt": "hello from public",
  "100%.png": "a literal percent",
  "a%20b.txt": "the file named with a percent",
  "a b.txt": "the file named with a space",
  "images/logo@2x.png": "at sign",
};

/**
 * Materializes the tree a deployment stages: the manifest under
 * `cdk-nextjs-runtime/`, a stub at every entrypoint `filePath`, the static files
 * the manifest points at, and the `required-server-files.json` `loadRuntime`
 * probes for.
 */
function stageDeployment(
  middlewareSource = MIDDLEWARE_STUB,
  transformManifest: (manifest: AdapterManifest) => AdapterManifest = (it) =>
    it,
): string {
  // The fixture is a real captured context, as JSON: the structural cast is the
  // point of the cast (see `build-outputs.test.ts`).
  const ctx = structuredClone(appPlayground) as unknown as BuildCompleteContext;
  const manifest = transformManifest(
    buildAdapterManifest(ctx, { buildCwd: ctx.projectDir }).manifest,
  );
  // Realpath because `loadRuntime` chdirs, and macOS's /var is a symlink to
  // /private/var: the cwd the entrypoints report would not match otherwise.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cdk-nextjs-core-")));

  write(deployedManifestPath(root), JSON.stringify(manifest));
  write(
    join(root, manifest.relativeProjectDir, ".next/required-server-files.json"),
    JSON.stringify({ version: 1, config: {} }),
  );
  // A deployed tree carries the `next` closure `next build` traced, under the
  // *project* dir rather than next to the runtime shell — which is the whole
  // reason `next-modules.ts` exists. Linking this repo's own `node_modules` in
  // reproduces that, so `serveStatic` here resolves by the same walk it does in
  // Lambda instead of the test quietly exercising a different lookup.
  symlinkSync(
    join(__dirname, "../../node_modules"),
    join(root, manifest.relativeProjectDir, "node_modules"),
  );

  for (const entrypoint of Object.values(manifest.entrypoints)) {
    write(join(root, entrypoint.filePath), ENTRYPOINT_STUB);
  }
  write(join(root, manifest.middleware!.filePath), middlewareSource);

  write(join(root, manifest.staticFiles["/favicon.ico"]), FAVICON);
  write(join(root, manifest.staticFiles["/404"]), NOT_FOUND_HTML);
  // Absent in the deployment the error-page ladder tests stage.
  if (manifest.staticFiles["/500"]) {
    write(join(root, manifest.staticFiles["/500"]), ERROR_HTML);
  }
  for (const [file, contents] of Object.entries(PUBLIC_FILES)) {
    write(join(root, manifest.relativeProjectDir, "public", file), contents);
  }
  // `.env` rather than `.env.production`: `@next/env` picks the mode from
  // NODE_ENV, which jest sets to "test".
  write(
    join(root, manifest.relativeProjectDir, ".env"),
    "CDK_NEXTJS_TEST_FROM_ENV_FILE=from-file\nCDK_NEXTJS_TEST_SET_BY_LAMBDA=from-file\n",
  );
  return root;
}

let root: string;
let runtime: NextjsRuntime;
const originalCwd = process.cwd();

beforeAll(async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  process.env.CDK_NEXTJS_TEST_SET_BY_LAMBDA = "from-lambda";
  root = stageDeployment();
  // `loadRuntime` chdirs, which is the point of it.
  runtime = await loadRuntime(root);
});

afterAll(() => {
  process.chdir(originalCwd);
  jest.restoreAllMocks();
});

/** One request through the real `handle`, with the response collected. */
async function send(
  request: Partial<RuntimeRequest> & { url: string },
  padEmptyBody = false,
): Promise<CollectingSink> {
  const sink = new CollectingSink(padEmptyBody);
  await runtime.handle(
    {
      method: "GET",
      headers: { host: "shop.example.test" },
      ...request,
    },
    sink,
  );
  return sink;
}

/** The JSON an entrypoint stub answers with. */
function stubBody(sink: CollectingSink): Record<string, unknown> {
  const encoding = sink.head?.headers["content-encoding"];
  const body = encoding === "gzip" ? gunzipSync(sink.body) : sink.body;
  return JSON.parse(body.toString("utf-8"));
}

describe("loadRuntime", () => {
  it("chdirs to the staged project dir, because entrypoints resolve against cwd", () => {
    expect(process.cwd()).toBe(join(root, "app-playground"));
  });

  it("loads the staged env files the way next start does, without overriding the function's environment", () => {
    expect(process.env.CDK_NEXTJS_TEST_FROM_ENV_FILE).toBe("from-file");
    expect(process.env.CDK_NEXTJS_TEST_SET_BY_LAMBDA).toBe("from-lambda");
  });

  it("explains a deployment package with no manifest", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cdk-nextjs-empty-"));
    await expect(loadRuntime(empty)).rejects.toThrow(
      /Could not read the cdk-nextjs adapter manifest/,
    );
  });

  it("explains a deployment package missing the staged project", async () => {
    const partial = mkdtempSync(join(tmpdir(), "cdk-nextjs-partial-"));
    write(
      deployedManifestPath(partial),
      readFileSync(deployedManifestPath(root), "utf-8"),
    );
    await expect(loadRuntime(partial)).rejects.toThrow(
      /does not contain the staged Next.js project/,
    );
  });
});

describe("NextjsRuntime.handle", () => {
  it("invokes the matched entrypoint with the requestMeta Next.js reads", async () => {
    const sink = await send({ url: "/" });
    expect(sink.head?.statusCode).toBe(200);
    const body = stubBody(sink);
    expect(body.file).toBe(
      join(root, "app-playground/.next/server/app/page.js"),
    );
    expect(body.url).toBe("/");
    // Without `initURL`, `RouteModule.prepare` falls back to `http://localhost`.
    expect(body.initURL).toBe("https://shop.example.test/");
    expect(body.hostname).toBe("shop.example.test");
    expect(body.hasRender404).toBe(true);
    expect(body.waitUntil).toBe("function");
    expect(body.cwd).toBe(join(root, "app-playground"));
  });

  it("trusts x-forwarded-host over the host CloudFront rewrote, when the shell says to", async () => {
    const sink = await send({
      url: "/",
      headers: {
        host: "origin.cloudfront.internal",
        "x-forwarded-host": "www.example.test",
      },
      trustForwardedHost: true,
    });
    expect(stubBody(sink).initURL).toBe("https://www.example.test/");
  });

  // Only the CloudFront function in front of *function* compute overwrites this
  // header, so on Containers and the Regional types it arrives from the client:
  // honoring it let `X-Forwarded-Host: evil.example` point every absolute URL
  // the app built, a password-reset link say, at evil.example.
  it("ignores x-forwarded-host unless the shell trusts it, like next start", async () => {
    const sink = await send({
      url: "/",
      headers: {
        host: "shop.example.test",
        "x-forwarded-host": "evil.example",
      },
    });
    expect(stubBody(sink).initURL).toBe("https://shop.example.test/");
    expect(stubBody(sink).hostname).toBe("shop.example.test");
  });

  // A value that cannot be a URL authority made `new URL` throw, and on the
  // Lambda shells — whose handlers wrap nothing — that is an invocation error and
  // a 502 rather than a response.
  it.each([
    ["a space", "exa mple.test"],
    ["a scheme", "https://www.example.test"],
    ["a path", "www.example.test/evil"],
    ["credentials", "user@www.example.test"],
    ["nothing", ""],
  ])(
    "ignores an x-forwarded-host containing %s and falls back to host",
    async (_label, forwarded) => {
      const sink = await send({
        url: "/",
        headers: {
          host: "shop.example.test",
          "x-forwarded-host": forwarded,
        },
        trustForwardedHost: true,
      });
      expect(sink.head?.statusCode).toBe(200);
      expect(stubBody(sink).initURL).toBe("https://shop.example.test/");
    },
  );

  // Multiple proxies each append, and only the first value is this hop's.
  it("takes the first value of a comma-joined x-forwarded-host", async () => {
    const sink = await send({
      url: "/",
      headers: {
        host: "origin.cloudfront.internal",
        "x-forwarded-host": "www.example.test, inner.example.test",
      },
      trustForwardedHost: true,
    });
    expect(stubBody(sink).initURL).toBe("https://www.example.test/");
  });

  it("ignores an x-forwarded-proto that is not http or https", async () => {
    const sink = await send({
      url: "/",
      headers: {
        host: "shop.example.test",
        "x-forwarded-proto": "javascript",
      },
    });
    expect(stubBody(sink).initURL).toBe("https://shop.example.test/");
  });

  it("hands a dynamic route its params as nxtP query values", async () => {
    const sink = await send({ url: "/isr/42" });
    const body = stubBody(sink);
    expect(body.file).toBe(
      join(root, "app-playground/.next/server/app/isr/[id]/page.js"),
    );
    // The documented deployed-proxy contract: `prepare()` recovers `params`
    // from these, which is why `requestMeta.params` is left unset.
    expect(body.url).toBe("/isr/42?nxtPid=42");
    expect(body.query).toEqual({ nxtPid: "42" });
    expect(body.params).toBeNull();
  });

  it("hands over a capture with an encoded delimiter as requestMeta.params", async () => {
    // The one exception to the contract above, because two decodes and a split
    // would turn this into three params and make `normalizePagePath` throw; see
    // `outOfBandRouteParams`. The `nxtP` value has to *leave* the query — and
    // therefore the URL — or `prepare` prefers it and the split is back.
    const sink = await send({ url: "/isr/a%2Fb" });
    const body = stubBody(sink);
    expect(body.url).toBe("/isr/a%2Fb");
    expect(body.query).toEqual({});
    expect(body.params).toEqual({ id: "a/b" });
  });

  it("runs middleware and applies the request headers it overrode", async () => {
    const sink = await send({ url: "/" });
    expect(stubBody(sink).header).toBe("yes");
  });

  it("serves a static file out of the staged tree", async () => {
    const sink = await send({ url: "/favicon.ico" });
    expect(sink.head?.statusCode).toBe(200);
    expect(sink.body).toEqual(FAVICON);
    // Typed from the route's extension, not the file's: a static metadata route
    // is staged as `favicon.ico.body`, and `.body` is not a media type. See
    // `setBodyFileContentType` in static-files.ts.
    expect(sink.head?.headers["content-type"]).toBe("image/x-icon");
  });

  it("serves public/ off disk, under the name the file actually has", async () => {
    const body = async (url: string) => {
      const sink = await send({ url });
      expect(sink.head?.statusCode).toBe(200);
      return sink.body.toString("utf-8");
    };
    expect(await body("/test.txt")).toBe("hello from public");
    // `send` decodes the path it is given, so a raw filesystem path failed to
    // decode (`100%.png`, an empty 400) or decoded to another file.
    expect(await body("/100%25.png")).toBe("a literal percent");
    expect(await body("/a%2520b.txt")).toBe("the file named with a percent");
    expect(await body("/a%20b.txt")).toBe("the file named with a space");
    // Both ways a link can spell it.
    expect(await body("/images/logo@2x.png")).toBe("at sign");
    expect(await body("/images/logo%402x.png")).toBe("at sign");
  });

  it("answers 405 to a public/ file requested with a method other than GET", async () => {
    // `send` serves any method; `next start` does not.
    const sink = await send({ url: "/test.txt", method: "DELETE" });
    expect(sink.head?.statusCode).toBe(405);
    expect(sink.head?.headers.allow).toBe("GET, HEAD");
    expect(sink.body.toString("utf-8")).not.toContain("hello from public");
  });

  it("answers an unknown path through the /_not-found entrypoint", async () => {
    const sink = await send({ url: "/nope?q=1" });
    expect(sink.head?.statusCode).toBe(404);
    expect(stubBody(sink).file).toBe(
      join(root, "app-playground/.next/server/app/_not-found/page.js"),
    );
    // The requested path, not `/_not-found`: the App Router puts this in the RSC
    // payload as the canonical URL, so rendering the module against its own
    // pathname would hand the client the wrong `usePathname()` and history entry.
    expect(stubBody(sink).url).toBe("/nope?q=1");
  });

  it("answers an unknown path no-store, whatever the /_not-found entry sends", async () => {
    // A prerendered `/_not-found` is a cache HIT with a year-long `s-maxage`,
    // and the CDN would keep this 404 for that long — past the deploy that adds
    // the route. `next start` answers an unmatched path no-store.
    const sink = await send({
      url: `/nope?cacheControl=${encodeURIComponent("s-maxage=31536000")}`,
    });
    expect(sink.head?.statusCode).toBe(404);
    expect(sink.head?.headers["cache-control"]).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("renders the 404 page when a route calls requestMeta.render404()", async () => {
    const sink = await send({ url: "/?render404=1" });
    expect(sink.head?.statusCode).toBe(404);
    // Whatever the route that gave up was rendering, for the same reason.
    expect(stubBody(sink).url).toBe("/?render404=1");
  });

  it("leaves a render404() 404 the Cache-Control its route gave it", async () => {
    // `notFound()` from an ISR page is a cacheable result of that page, kept for
    // its revalidate period, so the no-store for unmatched paths must not
    // reach it.
    const sink = await send({
      url: `/?render404=1&cacheControl=${encodeURIComponent("s-maxage=60")}`,
    });
    expect(sink.head?.statusCode).toBe(404);
    expect(sink.head?.headers["cache-control"]).toBe("s-maxage=60");
  });

  it("runs requestMeta.revalidate() against itself, not over the network", async () => {
    const sink = await send({ url: "/?revalidate=%2F" });
    expect(sink.head?.statusCode).toBe(200);
    expect(stubBody(sink)).toEqual({ revalidated: true, error: null });
  });

  it("renders a revalidation for the public origin the caller was served on", async () => {
    const marker = join(root, "revalidate-origin-marker");
    process.env.CDK_NEXTJS_TEST_MARKER = marker;
    try {
      await send({
        url: "/?revalidate=%2F%3FrecordOrigin%3D1",
        headers: {
          host: "abc123.lambda-url.us-east-1.on.aws",
          "x-forwarded-host": "shop.example.test",
          "x-forwarded-proto": "https",
        },
        trustForwardedHost: true,
      });
      expect(readFileSync(marker, "utf-8")).toBe(
        "https://shop.example.test/?recordOrigin=1",
      );
    } finally {
      delete process.env.CDK_NEXTJS_TEST_MARKER;
    }
  });

  it("fails a revalidation whose target did not answer 200", async () => {
    const sink = await send({ url: "/?revalidate=%2F%3Fstatus%3D500" });
    expect(stubBody(sink)).toEqual({
      revalidated: false,
      error: "Invalid response 500",
    });
  });

  describe("invalidating the CDN copy of a revalidated page", () => {
    const hookKey = Symbol.for("cdk-nextjs.invalidateRevalidatedPage");
    const globals = globalThis as Record<symbol, unknown>;
    afterEach(() => {
      delete globals[hookKey];
    });

    it("hands the cache handler's hook the page and its _next/data route", async () => {
      const hook = jest.fn(async () => {});
      globals[hookKey] = hook;
      await send({ url: "/?revalidate=%2Fisr%2F42" });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith([
        "/isr/42",
        `/_next/data/${runtime.manifest.buildId}/isr/42.json`,
      ]);
    });

    it("names the root's data route index.json", async () => {
      const hook = jest.fn(async () => {});
      globals[hookKey] = hook;
      await send({ url: "/?revalidate=%2F" });
      expect(hook).toHaveBeenCalledWith([
        "/",
        `/_next/data/${runtime.manifest.buildId}/index.json`,
      ]);
    });

    it("invalidates nothing when the revalidation failed", async () => {
      const hook = jest.fn(async () => {});
      globals[hookKey] = hook;
      await send({ url: "/?revalidate=%2F%3Fstatus%3D500" });
      expect(hook).not.toHaveBeenCalled();
    });

    it("still reports success when the invalidation fails", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      globals[hookKey] = async () => {
        throw new Error("TooManyInvalidationsInProgress");
      };
      const sink = await send({ url: "/?revalidate=%2F" });
      expect(stubBody(sink)).toEqual({ revalidated: true, error: null });
      warn.mockRestore();
    });
  });

  it("strips the internal headers next start does not honor from a client", async () => {
    const sink = await send({
      url: "/",
      headers: {
        host: "shop.example.test",
        "next-resume": "1",
        "x-matched-path": "/admin",
      },
    });
    expect(stubBody(sink)).toMatchObject({
      nextResume: null,
      matchedPath: null,
    });
  });

  it("fetches an image source from a route handler, in process and without cookies", async () => {
    const images = (
      runtime as unknown as {
        images: {
          options: {
            fetchInternal: (
              href: string,
              req: ReturnType<typeof createIncomingMessage>,
            ) => Promise<{
              statusCode: number;
              headers: Record<string, unknown>;
              body: Buffer;
            }>;
          };
        };
      }
    ).images;
    const viewer = createIncomingMessage({
      method: "GET",
      url: "/_next/image?url=%2Fapi%2Fhealth%3Favatar%3D42&w=64&q=75",
      headers: { host: "shop.example.test", cookie: "session=secret" },
    });
    const response = await images.options.fetchInternal(
      "/api/health?avatar=42",
      viewer,
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body.toString("utf-8"));
    expect(body.file).toContain("api/health");
    expect(body.url).toBe("/api/health?avatar=42");
    expect(body.initURL).toBe("https://shop.example.test/api/health?avatar=42");
    expect(body.cookie).toBeNull();
  });

  it("redirects a trailing slash, with the Refresh fallback for a 308", async () => {
    const sink = await send({ url: "/isr/42/" });
    expect(sink.head?.statusCode).toBe(308);
    expect(sink.head?.headers.location).toBe("/isr/42");
    expect(sink.head?.headers.refresh).toBe("0;url=/isr/42");
    expect(sink.body.toString("utf-8")).toBe("/isr/42");
  });

  it("gzips a streamed HTML response for a client that accepts it", async () => {
    const sink = await send({
      url: "/",
      headers: { host: "shop.example.test", "accept-encoding": "gzip" },
    });
    expect(sink.head?.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(sink.body).toString("utf-8")).toContain("initURL");
  });

  it("awaits waitUntil work before resolving, since Lambda freezes on return", async () => {
    const marker = join(root, "waituntil-marker");
    process.env.CDK_NEXTJS_TEST_MARKER = marker;
    try {
      await send({ url: "/?waitUntil=1" });
      // Written by a timer the entrypoint registered, after the response ended.
      expect(readFileSync(marker, "utf-8")).toBe("done");
    } finally {
      delete process.env.CDK_NEXTJS_TEST_MARKER;
    }
  });

  it("serves the prerendered 500 when an entrypoint throws before sending a head", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const sink = await send({ url: "/?boom=1" });
    expect(sink.head?.statusCode).toBe(500);
    expect(sink.body.toString("utf-8")).toBe(ERROR_HTML);
    // A `Cache-Control` the render that threw had already set would otherwise
    // stay on the response and get the 500 cached at the edge.
    expect(sink.head?.headers["cache-control"]).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(error).toHaveBeenCalledWith(
      "Unhandled error while handling the request:",
      expect.objectContaining({ message: expect.stringContaining("exploded") }),
    );
    error.mockRestore();
  });

  it("streams middleware's own Response when it answers the request", async () => {
    // A second deployment, because the middleware module is memoized per runtime.
    const responding = await loadRuntime(
      stageDeployment(`
exports.handler = async () =>
  new Response("denied", {
    status: 401,
    statusText: "Unauthorized",
    headers: [
      ["content-type", "text/plain"],
      ["set-cookie", "sid=; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"],
      ["set-cookie", "flag=1; Path=/"],
    ],
  });
`),
    );
    const sink = new CollectingSink();
    await responding.handle(
      { method: "GET", url: "/", headers: { host: "shop.example.test" } },
      sink,
    );
    // `resolveRoutes` only reports that middleware responded; the body comes
    // back through the runner's `onResponse` callback.
    expect(sink.head?.statusCode).toBe(401);
    expect(sink.head?.statusMessage).toBe("Unauthorized");
    expect(sink.head?.cookies).toEqual([
      "sid=; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "flag=1; Path=/",
    ]);
    expect(sink.body.toString("utf-8")).toBe("denied");
  });

  it("answers a missing build asset no-store, not under its immutable rule", async () => {
    // In the manifest but not on disk — `stageDeployment` writes no chunks, the
    // way a Lambda package ships none (they are on S3 behind CloudFront).
    const sink = await send({ url: "/_next/static/chunks/0-qsb3zz6f4c7.js" });
    expect(sink.head?.statusCode).toBe(404);
    expect(sink.head?.headers["cache-control"]).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  // `next start` answers these without rendering the 404 page (`router-server.js`,
  // the "404 case"): nothing would display it, and rendering is the cost.
  it.each([
    ["a missing build asset", "/_next/static/chunks/0-qsb3zz6f4c7.js"],
    ["a build asset no deploy produced", "/_next/static/chunks/stale-0000.js"],
  ])("answers %s with a plain-text Not Found", async (_name, url) => {
    const sink = await send({ url });
    expect(sink.head?.statusCode).toBe(404);
    expect(sink.head?.headers["content-type"]).toBe(
      "text/plain; charset=utf-8",
    );
    expect(sink.head?.headers["cache-control"]).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(sink.body.toString("utf-8")).toBe("Not Found");
  });

  it.each(["image", "script", "font", "style"])(
    "answers an unknown path fetched as a %s subresource with a plain-text Not Found",
    async (dest) => {
      const sink = await send({
        url: "/nope.png",
        headers: { host: "shop.example.test", "sec-fetch-dest": dest },
      });
      expect(sink.head?.statusCode).toBe(404);
      expect(sink.head?.headers["cache-control"]).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      expect(sink.body.toString("utf-8")).toBe("Not Found");
    },
  );

  it.each([
    // A navigation, and `fetch()` — which is how an RSC request goes.
    ["a document", "GET", "document"],
    ["a fetch", "GET", "empty"],
    // `next start` only short-circuits GET and HEAD.
    ["an image POST", "POST", "image"],
  ])("still renders the 404 page for %s", async (_name, method, dest) => {
    const sink = await send({
      url: "/nope",
      method,
      headers: { host: "shop.example.test", "sec-fetch-dest": dest },
    });
    expect(sink.head?.statusCode).toBe(404);
    expect(stubBody(sink).file).toContain("_not-found");
  });

  it("settles and destroys the response when the sink cannot take the head", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    // What the Lambda sink's `writeHead` does with a header value it rejects.
    const handled = runtime.handle(
      { method: "GET", url: "/", headers: { host: "shop.example.test" } },
      {
        begin() {
          throw new TypeError("Invalid character in header content");
        },
      },
    );
    await expect(handled).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "The response stream did not complete:",
      expect.objectContaining({ message: expect.stringContaining("header") }),
    );
    error.mockRestore();
  });

  it("streams an upload through middleware to the route intact", async () => {
    const chunk = Buffer.alloc(64 * 1024, 1);
    const sink = await send({
      url: "/?readBody=1",
      method: "POST",
      body: Readable.from(Array.from({ length: 32 }, () => chunk)),
    });
    expect(stubBody(sink)).toEqual({ bodyLength: 32 * chunk.length });
  });

  it("reads middleware's body only as fast as the client takes it", async () => {
    const pulls = { count: 0 };
    (globalThis as Record<string, unknown>).__cdkNextjsPulls = pulls;
    const streaming = await loadRuntime(
      stageDeployment(`
exports.handler = async () =>
  new Response(
    new ReadableStream({
      pull(controller) {
        const pulls = globalThis.__cdkNextjsPulls;
        pulls.count += 1;
        if (pulls.count > 1000) controller.close();
        else controller.enqueue(new Uint8Array(16 * 1024));
      },
    }),
  );
`),
    );
    // A client that takes nothing until released.
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const sink: ResponseSink = {
      begin: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            void blocked.then(() => callback());
          },
        }),
    };
    const handled = streaming.handle(
      { method: "GET", url: "/", headers: { host: "shop.example.test" } },
      sink,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 1000 chunks are 16 MiB; a few highWaterMarks' worth is all that may be
    // buffered for a client that is not reading.
    expect(pulls.count).toBeLessThan(50);
    release!();
    await handled;
    expect(pulls.count).toBe(1001);
  });

  it("pads an empty body when the shell asks, so API Gateway does not 502", async () => {
    const sink = await send(
      {
        url: "/",
        headers: { host: "shop.example.test", "if-none-match": "x" },
      },
      true,
    );
    // A real 304 is not reachable through a stub entrypoint, so this only
    // asserts the padding does not corrupt a normal body.
    expect(sink.body.length).toBeGreaterThan(1);
  });

  it("emits each cookie middleware set exactly once", async () => {
    // `Headers.entries()` yields `set-cookie` once per cookie, so appending the
    // whole `getSetCookie()` array per entry emitted N² of them: two cookies
    // arrived at the browser as a=1, b=2, a=1, b=2. A duplicated `Set-Cookie` is
    // not harmless either - a session cookie and its own copy race.
    const continuing = await loadRuntime(
      stageDeployment(`
exports.handler = async () =>
  new Response(null, {
    headers: [
      ["x-middleware-next", "1"],
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2; Path=/"],
    ],
  });
`),
    );
    const sink = new CollectingSink();
    await continuing.handle(
      { method: "GET", url: "/", headers: { host: "shop.example.test" } },
      sink,
    );
    expect(sink.head?.cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});

/**
 * Next.js's page handlers report an error and then rethrow, leaving the error page
 * to whatever hosts them, so this ladder is the only thing that makes a
 * `pages/_error` reachable. `test/e2e/async-modules` is the measurement:
 * `/make-error` throws in `getServerSideProps` and expects "hello error".
 */
describe("a Pages API route", () => {
  it("is left to end its own response, as next start leaves it", async () => {
    const pagesApi = await loadRuntime(
      stageDeployment(MIDDLEWARE_STUB, (manifest) => ({
        ...manifest,
        entrypoints: {
          ...manifest.entrypoints,
          "/api/health": {
            ...manifest.entrypoints["/api/health"],
            type: "page-api",
          },
        },
      })),
    );
    const sink = new CollectingSink();
    await pagesApi.handle(
      {
        method: "GET",
        url: "/api/health?endLater=1",
        headers: { host: "shop.example.test" },
      },
      sink,
    );
    expect(sink.body.toString("utf-8")).toBe("first,second");
  });

  it("is still ended for a route of any other kind", async () => {
    const sink = await send({ url: "/api/health?endLater=1" });
    expect(sink.body.toString("utf-8")).toBe("first,");
  });
});

describe("res.revalidate() across functionGroups", () => {
  it("says which group owns a page it cannot render", async () => {
    const grouped = await loadRuntime(
      stageDeployment(MIDDLEWARE_STUB, (manifest) => ({
        ...manifest,
        groups: {
          default: Object.keys(manifest.entrypoints).filter(
            (template) => template !== "/isr/[id]",
          ),
          blog: ["/isr/[id]"],
        },
      })),
    );
    process.env.CDK_NEXTJS_FUNCTION_GROUP = "default";
    try {
      const sink = new CollectingSink();
      await grouped.handle(
        {
          method: "GET",
          url: "/?revalidate=%2Fisr%2F1%3Fstatus%3D500",
          headers: { host: "shop.example.test" },
        },
        sink,
      );
      const { error } = JSON.parse(sink.body.toString("utf-8"));
      expect(error).toMatch(/^Invalid response 500: /);
      expect(error).toContain('group "blog"');
      expect(error).toContain('("default")');
    } finally {
      delete process.env.CDK_NEXTJS_FUNCTION_GROUP;
    }
  });
});

describe("withoutInternalHeaders", () => {
  it("drops every header on Next's internal list", () => {
    expect(
      withoutInternalHeaders(
        {
          host: "a.test",
          "next-resume": "1",
          "x-middleware-rewrite": "/x",
          "x-nextjs-data": "1",
        },
        "/blog",
        "",
      ),
    ).toEqual({ host: "a.test" });
  });

  it("marks a _next/data request as one, as next start's router does", () => {
    expect(
      withoutInternalHeaders({}, "/base/_next/data/abc/blog.json?x=1", "/base"),
    ).toEqual({ "x-nextjs-data": "1" });
    expect(withoutInternalHeaders({}, "/_next/data/abc/blog", "")).toEqual({});
  });
});

describe("the error page ladder", () => {
  /**
   * An app with a custom `pages/_error` that cannot be prerendered — one with
   * `getInitialProps`, or a `pages/_app` that has it. The fixture is App Router,
   * so both halves have to be arranged: drop the prerendered `/500` next emits by
   * default, and add the entrypoint.
   */
  const withErrorPage = (manifest: AdapterManifest): AdapterManifest => {
    const { "/500": _prerendered, ...staticFiles } = manifest.staticFiles;
    return {
      ...manifest,
      staticFiles,
      entrypoints: {
        ...manifest.entrypoints,
        "/_error": {
          ...manifest.entrypoints["/_not-found"],
          id: "/_error",
          filePath: join(
            manifest.relativeProjectDir,
            ".next/server/pages/_error.js",
          ),
        },
      },
    };
  };

  async function sendTo(
    withLadder: NextjsRuntime,
    url: string,
  ): Promise<CollectingSink> {
    const sink = new CollectingSink();
    await withLadder.handle(
      { method: "GET", url, headers: { host: "shop.example.test" } },
      sink,
    );
    return sink;
  }

  it("invokes /_error when the build has no prerendered /500", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const rendering = await loadRuntime(
      stageDeployment(MIDDLEWARE_STUB, withErrorPage),
    );
    const sink = await sendTo(rendering, "/?boom=1");
    expect(sink.head?.statusCode).toBe(500);
    // Rendered for the URL that was asked for, and with the status already set:
    // `_error`'s `getInitialProps` reads `res.statusCode` to get its own prop.
    expect(stubBody(sink).file).toContain("pages/_error.js");
    expect(stubBody(sink).url).toBe("/?boom=1");
    expect(sink.head?.headers["content-length"]).toBeUndefined();
    expect(sink.head?.headers.etag).toBeUndefined();
    // Not the throwing render's `s-maxage=60`: a cached 500 at CloudFront.
    expect(sink.head?.headers["cache-control"]).toMatch(/no-store/);
    error.mockRestore();
  });

  it("drops the failed render's Content-Length and ETag from a prerendered /500", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const sink = await send({ url: "/?boom=1" });
    expect(sink.head?.statusCode).toBe(500);
    expect(sink.body.toString("utf-8")).toBe(ERROR_HTML);
    expect(sink.head?.headers["content-length"]).toBeUndefined();
    expect(sink.head?.headers.etag).toBeUndefined();
    error.mockRestore();
  });

  it("falls back to plain text when the error page throws too", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const rendering = await loadRuntime(
      stageDeployment(MIDDLEWARE_STUB, withErrorPage),
    );
    const sink = await sendTo(rendering, "/?boomEverywhere=1");
    expect(sink.head?.statusCode).toBe(500);
    expect(sink.body.toString("utf-8")).toBe("Internal Server Error");
    expect(sink.head?.headers["cache-control"]).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(error).toHaveBeenCalledWith(
      "The error page itself failed to render:",
      expect.objectContaining({ message: expect.stringContaining("too") }),
    );
    error.mockRestore();
  });

  it("answers plain text for an app with no error page at all", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const bare = await loadRuntime(
      stageDeployment(MIDDLEWARE_STUB, (manifest) => {
        const { "/500": _prerendered, ...staticFiles } = manifest.staticFiles;
        return { ...manifest, staticFiles };
      }),
    );
    const sink = await sendTo(bare, "/?boom=1");
    expect(sink.head?.statusCode).toBe(500);
    expect(sink.body.toString("utf-8")).toBe("Internal Server Error");
    error.mockRestore();
  });
});

describe("an external rewrite", () => {
  /**
   * `NextResponse.rewrite("https://…")`: an absolute destination makes
   * `resolveRoutes` report an `externalRewrite`, which the runtime proxies with
   * `fetch` instead of routing to an entrypoint.
   */
  const EXTERNAL_REWRITE_MIDDLEWARE = `
exports.handler = async () =>
  new Response(null, {
    headers: { "x-middleware-rewrite": "https://upstream.test/from-origin" },
  });
`;

  const ORIGIN_BODY = "<html>from the origin</html>";

  /**
   * What undici hands back for a gzip origin, which is the whole point of these
   * tests: `fetch` decodes the body and leaves both `content-encoding` and the
   * *encoded* `content-length` behind, describing bytes it already discarded.
   */
  function gzipLabelledPlaintext(): Response {
    return new Response(ORIGIN_BODY, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": String(gzipSync(ORIGIN_BODY).byteLength),
      },
    });
  }

  let proxying: NextjsRuntime;
  let fetchMock: jest.SpyInstance;

  beforeAll(async () => {
    proxying = await loadRuntime(stageDeployment(EXTERNAL_REWRITE_MIDDLEWARE));
  });

  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(gzipLabelledPlaintext());
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  async function proxy(
    headers: Record<string, string> = {},
  ): Promise<CollectingSink> {
    const sink = new CollectingSink();
    await proxying.handle(
      {
        method: "GET",
        url: "/anything",
        headers: { host: "shop.example.test", ...headers },
      },
      sink,
    );
    return sink;
  }

  it("proxies the request to the rewritten origin", async () => {
    const sink = await proxy();

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://upstream.test/from-origin",
    );
    expect(sink.head?.statusCode).toBe(200);
    expect(sink.head?.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  // Forwarding the origin's `content-encoding` over a body `fetch` already
  // decoded fails the whole response in the browser with
  // ERR_CONTENT_DECODING_FAILED, under a `Content-Length` that describes the
  // compressed bytes. Nothing downstream repairs it either: `shouldGzip`
  // declines as soon as `content-encoding` is set.
  it("drops the content-encoding and length fetch already consumed", async () => {
    const sink = await proxy();

    expect(sink.head?.headers["content-encoding"]).toBeUndefined();
    expect(sink.head?.headers["content-length"]).toBeUndefined();
    expect(sink.body.toString("utf-8")).toBe(ORIGIN_BODY);
  });

  // The other half of it: with the stale label gone, the sink is free to
  // compress the plaintext itself — and now the encoding it advertises is the
  // one the bytes actually carry.
  it("re-compresses the decoded body when the client accepts gzip", async () => {
    const sink = await proxy({ "accept-encoding": "gzip" });

    expect(sink.head?.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(sink.body).toString("utf-8")).toBe(ORIGIN_BODY);
  });
});

describe("a streamed external rewrite", () => {
  const EXTERNAL_REWRITE_MIDDLEWARE = `
exports.handler = async () =>
  new Response(null, {
    headers: { "x-middleware-rewrite": "https://upstream.test/events" },
  });
`;

  let proxying: NextjsRuntime;

  beforeAll(async () => {
    proxying = await loadRuntime(stageDeployment(EXTERNAL_REWRITE_MIDDLEWARE));
  });

  // Server-sent events through a rewrite, gzipped because `text/event-stream`
  // is `text/*`: without a flush per chunk, the first event sat in zlib's
  // buffer until the origin closed the stream.
  it("flushes each chunk through the compressor as it arrives", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            await held;
            controller.enqueue(new TextEncoder().encode("data: second\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    try {
      const sink = new CollectingSink();
      const handled = proxying.handle(
        {
          method: "GET",
          url: "/events",
          headers: { host: "shop.example.test", "accept-encoding": "gzip" },
        },
        sink,
      );
      // Poll rather than sleep a fixed time: the first event has to reach the
      // sink while the origin is still holding the stream open.
      const soFar = (): string =>
        gunzipSync(sink.body, {
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
        }).toString("utf-8");
      for (let i = 0; i < 50 && !soFar(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sink.head?.headers["content-encoding"]).toBe("gzip");
      expect(soFar()).toBe("data: first\n\n");
      release();
      await handled;
      expect(gunzipSync(sink.body).toString("utf-8")).toBe(
        "data: first\n\ndata: second\n\n",
      );
    } finally {
      release();
      fetchMock.mockRestore();
    }
  });
});

describe("a Response middleware answers with itself", () => {
  const MIDDLEWARE_BODY = "<html>from middleware</html>";

  /**
   * `return fetch(upstream)` from `proxy.ts`, as the runtime sees it: middleware
   * runs in process, so its `fetch` is undici, which decoded a gzip upstream
   * and kept the upstream's `content-encoding` and encoded `content-length`.
   */
  const FETCHED_RESPONSE_MIDDLEWARE = `
const { gzipSync } = require("node:zlib");
const body = ${JSON.stringify(MIDDLEWARE_BODY)};
exports.handler = async () =>
  new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": String(gzipSync(body).byteLength),
      "transfer-encoding": "chunked",
      "x-from-upstream": "yes",
    },
  });
`;

  let responding: NextjsRuntime;

  beforeAll(async () => {
    responding = await loadRuntime(
      stageDeployment(FETCHED_RESPONSE_MIDDLEWARE),
    );
  });

  // What `next start` does too: the sandbox deletes these three
  // (`FORBIDDEN_HEADERS`) from every middleware response.
  it("drops the framing headers that described the upstream's bytes", async () => {
    const sink = new CollectingSink();
    await responding.handle(
      { method: "GET", url: "/", headers: { host: "shop.example.test" } },
      sink,
    );

    expect(sink.head?.headers["content-encoding"]).toBeUndefined();
    expect(sink.head?.headers["content-length"]).toBeUndefined();
    expect(sink.head?.headers["transfer-encoding"]).toBeUndefined();
    expect(sink.head?.headers["x-from-upstream"]).toBe("yes");
    expect(sink.body.toString("utf-8")).toBe(MIDDLEWARE_BODY);
  });
});

/**
 * Last in the file, because `loadRuntime` chdirs: the tests above assert on the
 * cwd the shared deployment set.
 */
describe("the resolved query a rewrite produced", () => {
  /**
   * `test/e2e/link-with-api-rewrite`'s rule, as it lands in the manifest: a
   * `beforeFiles` rewrite whose condition is a query param the destination keeps.
   */
  const withSelfMatchingRewrite = (
    manifest: AdapterManifest,
  ): AdapterManifest =>
    ({
      ...manifest,
      routing: {
        ...(manifest.routing as Record<string, unknown>),
        beforeFiles: [
          {
            source: "/:path(.*)",
            sourceRegex: "^(?:\\/(.*))(?:\\/)?$",
            destination: "/?from=%2F$1",
            has: [{ type: "query", key: "json", value: "true" }],
          },
        ],
      },
    }) as AdapterManifest;

  /**
   * `RouteModule.prepare` re-runs the config's rewrites against `req.url`
   * unconditionally, and `req.url` is the target the rewrite already produced -
   * so a rule that still matches its own output gets applied twice. Here that
   * turned `from=/some/route/for` into `from=/`, which is what made
   * `test/e2e/link-with-api-rewrite` answer `{"from":"/api/json"}` where
   * `next start` answers `{"from":"/some/route/for"}`. Stating the resolved query
   * as `requestMeta.query` is what `prepare` prefers over anything it re-derives,
   * so the route sees the first pass rather than the second.
   */
  it("is handed over as requestMeta.query, not left to be re-derived", async () => {
    const rewriting = await loadRuntime(
      stageDeployment(MIDDLEWARE_STUB, withSelfMatchingRewrite),
    );
    const sink = new CollectingSink();
    await rewriting.handle(
      {
        method: "GET",
        url: "/some/route/for?json=true",
        headers: { host: "shop.example.test" },
      },
      sink,
    );

    const body = stubBody(sink);
    // Its own staged tree, so not `root`: the rewrite is the point.
    expect(body.file).toContain(".next/server/app/page.js");
    expect(body.query).toEqual({ json: "true", from: "/some/route/for" });
  });
});

/**
 * `next start` answers `//` with `308 -> /` and `/api//json` with
 * `308 -> /api/json`; this runtime used to answer 500 and 404. The 500 is the
 * reason the check runs before anything parses the target: `new URL("//", base)`
 * reads a leading `//` as protocol-relative and takes the first path segment for
 * the host. Found by `test/e2e/hydration`, which requests exactly `//`, and by
 * `test/e2e/i18n-ignore-redirect-source-locale/redirects-with-basepath`, whose
 * locale list includes `''` and so asks for `/basepath//to-sv`.
 */
describe("a path with repeated slashes or a backslash", () => {
  it.each([
    ["//", "/"],
    ["///", "/"],
    ["/api//json", "/api/json"],
    ["/basepath//to-sv", "/basepath/to-sv"],
    ["/a\\b", "/a/b"],
    // The query is carried across untouched, repeated slashes and all.
    ["//some/route?json=true&next=//x", "/some/route?json=true&next=//x"],
  ])("redirects %s to %s with a 308", async (from, to) => {
    const sink = await send({ url: from });
    expect(sink.head?.statusCode).toBe(308);
    expect(sink.head?.headers.location).toBe(to);
    // Next.js sends the destination as the body too.
    expect(sink.body.toString("utf-8")).toBe(to);
  });

  /** `%5C` is a character in a segment, not a separator - as in Next.js. */
  it("leaves an encoded backslash alone", async () => {
    const sink = await send({ url: "/a%5Cb" });
    expect(sink.head?.statusCode).not.toBe(308);
  });
});

describe("splitBody", () => {
  const CHUNK = Buffer.alloc(16 * 1024, 7);
  const upload = () =>
    Readable.from(
      Array.from({ length: 8 }, () => CHUNK),
      { objectMode: false },
    );

  async function drain(stream: AsyncIterable<Uint8Array>): Promise<number> {
    let length = 0;
    for await (const chunk of stream) {
      length += chunk.length;
    }
    return length;
  }

  // A tee buffers for the branch that is behind, so the middleware branch that
  // nothing reads would otherwise hold every byte the route streams.
  it("cancels the middleware copy once dispatch is done with it", async () => {
    const body = splitBody(upload(), true);
    body.releaseUnread(false);

    const reader = body.forDispatch.getReader();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(await drain(body.forRequest as Readable)).toBe(8 * CHUNK.length);
  });

  it("leaves the middleware copy alone when middleware is reading it", async () => {
    const body = splitBody(upload(), true);
    const reading = drain(
      body.forDispatch as unknown as AsyncIterable<Uint8Array>,
    );
    body.releaseUnread(false);

    expect(await reading).toBe(8 * CHUNK.length);
  });

  // Middleware answered, possibly with the upload as its own body; `req` is
  // never read, so its copy is the one that would pile up.
  it("releases the route's copy when middleware answered", async () => {
    const body = splitBody(upload(), true);
    body.releaseUnread(true);

    expect((body.forRequest as Readable).destroyed).toBe(true);
    expect(
      await drain(body.forDispatch as unknown as AsyncIterable<Uint8Array>),
    ).toBe(8 * CHUNK.length);
  });

  it("does not split at all without middleware", () => {
    const source = upload();
    const body = splitBody(source, false);
    expect(body.forRequest).toBe(source);
    body.releaseUnread(false);
    expect(source.destroyed).toBe(false);
  });
});

describe("waitUntil", () => {
  it("awaits work registered after the first batch settled", async () => {
    const marker = join(root, "late-wait-until-marker");
    process.env.CDK_NEXTJS_TEST_MARKER = marker;
    try {
      await send({ url: "/?lateWaitUntil=1" });
      expect(readFileSync(marker, "utf-8")).toBe("late");
    } finally {
      delete process.env.CDK_NEXTJS_TEST_MARKER;
    }
  });
});

describe("a prerendered status page, requested directly", () => {
  it("answers /404 with a 404, as next start does", async () => {
    const sink = await send({ url: "/404" });
    expect(sink.head?.statusCode).toBe(404);
    expect(sink.body.toString("utf-8")).toBe(NOT_FOUND_HTML);
  });

  it("answers /500 with a 500", async () => {
    const sink = await send({ url: "/500" });
    expect(sink.head?.statusCode).toBe(500);
    expect(sink.body.toString("utf-8")).toBe(ERROR_HTML);
  });

  it("still serves them to a POST, which next start does not 405", async () => {
    const sink = await send({ url: "/404", method: "POST" });
    expect(sink.head?.statusCode).toBe(404);
  });
});

describe("an auto-exported Pages Router page", () => {
  const ABOUT_HTML = "<html><body>about</body></html>";
  let pages: NextjsRuntime;

  beforeAll(async () => {
    let aboutFile = "";
    const staged = stageDeployment(MIDDLEWARE_STUB, (manifest) => {
      aboutFile = `${manifest.relativeProjectDir}/.next/server/pages/about.html`;
      return {
        ...manifest,
        staticFiles: { ...manifest.staticFiles, "/about": aboutFile },
      };
    });
    write(join(staged, aboutFile), ABOUT_HTML);
    pages = await loadRuntime(staged);
  });

  async function sendTo(method: string): Promise<CollectingSink> {
    const sink = new CollectingSink();
    await pages.handle(
      { method, url: "/about", headers: { host: "shop.example.test" } },
      sink,
    );
    return sink;
  }

  it("is served to a GET", async () => {
    const sink = await sendTo("GET");
    expect(sink.head?.statusCode).toBe(200);
    expect(sink.body.toString("utf-8")).toBe(ABOUT_HTML);
  });

  it("answers any other method with a 405, as next start does", async () => {
    const sink = await sendTo("POST");
    expect(sink.head?.statusCode).toBe(405);
    expect(sink.head?.headers.allow).toBe("GET, HEAD");
  });
});

describe("a route packaged into another functionGroups group", () => {
  let grouped: NextjsRuntime;

  beforeAll(async () => {
    let missing = "";
    const staged = stageDeployment(MIDDLEWARE_STUB, (manifest) => {
      missing = manifest.entrypoints["/isr/[id]"].filePath;
      return {
        ...manifest,
        groups: {
          default: Object.keys(manifest.entrypoints).filter(
            (template) => template !== "/isr/[id]",
          ),
          blog: ["/isr/[id]"],
        },
      };
    });
    rmSync(join(staged, missing));
    grouped = await loadRuntime(staged);
  });

  async function get(url: string): Promise<CollectingSink> {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CDK_NEXTJS_FUNCTION_GROUP = "default";
    try {
      const sink = new CollectingSink();
      await grouped.handle(
        { method: "GET", url, headers: { host: "shop.example.test" } },
        sink,
      );
      return sink;
    } finally {
      delete process.env.CDK_NEXTJS_FUNCTION_GROUP;
      warn.mockRestore();
    }
  }

  // The edge matches case-sensitively and Next.js doesn't: `/ISR/1` missed the
  // `blog` group's behavior only because of its case.
  it("redirects a URL that differs only in case to its canonical spelling", async () => {
    const sink = await get("/ISR/1?x=1");
    expect(sink.head?.statusCode).toBe(308);
    expect(sink.head?.headers.location).toBe("/isr/1?x=1");
  });

  it("keeps the case of a dynamic segment's value", async () => {
    const sink = await get("/ISR/AbC");
    expect(sink.head?.statusCode).toBe(308);
    expect(sink.head?.headers.location).toBe("/isr/AbC");
  });

  // `/_next/image` runs in the default group and renders a source that is not
  // a file in process: for one served by another group, that rendered the 404
  // page and handed its HTML to the optimizer as the image.
  it("reports an image source in another group rather than fetching its 404 page", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CDK_NEXTJS_FUNCTION_GROUP = "default";
    try {
      const fetchInternal = (
        grouped as unknown as {
          fetchInternal: (
            href: string,
            req: unknown,
          ) => Promise<{
            statusCode: number;
            body: Buffer;
            otherGroup?: string;
          }>;
        }
      ).fetchInternal.bind(grouped);
      const response = await fetchInternal(
        "/isr/1",
        createIncomingMessage({
          method: "GET",
          url: "/_next/image?url=%2Fisr%2F1&w=64&q=75",
          headers: { host: "shop.example.test" },
        }),
      );
      expect(response).toMatchObject({ otherGroup: "blog" });
      expect(response.body.length).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(
        /Image source "\/isr\/1" is served by a route in `functionGroups` group "blog"/,
      );
    } finally {
      delete process.env.CDK_NEXTJS_FUNCTION_GROUP;
      warn.mockRestore();
    }
  });

  it("is a 404, not a 500, when case is not the difference", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CDK_NEXTJS_FUNCTION_GROUP = "default";
    try {
      const sink = new CollectingSink();
      await grouped.handle(
        {
          method: "GET",
          url: "/isr/1",
          headers: { host: "shop.example.test" },
        },
        sink,
      );
      expect(sink.head?.statusCode).toBe(404);
      expect(sink.head?.headers["cache-control"]).toMatch(/no-store/);
      expect(String(warn.mock.calls[0]?.[0])).toContain('group "blog"');
    } finally {
      delete process.env.CDK_NEXTJS_FUNCTION_GROUP;
      warn.mockRestore();
    }
  });
});

describe("CDK_NEXTJS_IMAGE_CACHE", () => {
  const imageCacheOf = (loaded: NextjsRuntime): unknown =>
    (loaded as unknown as { images: { options: { cache?: boolean } } }).images
      .options.cache;

  it("leaves the image cache on by default", async () => {
    expect(imageCacheOf(await loadRuntime(root))).toBe(true);
  });

  it("turns it off for 0", async () => {
    process.env.CDK_NEXTJS_IMAGE_CACHE = "0";
    try {
      expect(imageCacheOf(await loadRuntime(root))).toBe(false);
    } finally {
      delete process.env.CDK_NEXTJS_IMAGE_CACHE;
    }
  });
});

describe("public/ on the Lambda types", () => {
  let lambda: NextjsRuntime;
  const send$ = jest.spyOn(S3Client.prototype, "send");

  beforeAll(async () => {
    const staged = stageDeployment();
    const manifest: AdapterManifest = JSON.parse(
      readFileSync(deployedManifestPath(staged), "utf-8"),
    );
    // What a Lambda zip carries: the list, not the files.
    rmSync(join(staged, manifest.relativeProjectDir, "public"), {
      recursive: true,
    });
    write(
      join(staged, RUNTIME_DIR_NAME, PUBLIC_FILES_FILE_NAME),
      JSON.stringify(["feed.xml", "images/logo@2x.png"]),
    );
    lambda = new NextjsRuntime({
      deploymentRoot: staged,
      manifest,
      bucket: "assets",
      bucketKeyPrefix: "base",
    });
  });

  afterEach(() => send$.mockReset());
  afterAll(() => send$.mockRestore());

  async function get(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<CollectingSink> {
    const sink = new CollectingSink();
    await lambda.handle(
      {
        method: "GET",
        url,
        headers: { host: "shop.example.test", ...headers },
      },
      sink,
    );
    return sink;
  }

  it("streams a listed file from the assets bucket, under its key prefix", async () => {
    send$.mockImplementation((async () => ({
      Body: Readable.from([Buffer.from("<rss/>")]),
      ContentType: "application/rss+xml",
      ContentLength: 6,
      ETag: '"e1"',
      LastModified: new Date("2026-01-02T03:04:05Z"),
    })) as never);
    const sink = await get("/feed.xml");
    expect(sink.head?.statusCode).toBe(200);
    expect(sink.body.toString("utf-8")).toBe("<rss/>");
    expect(sink.head?.headers["content-type"]).toBe("application/rss+xml");
    expect(sink.head?.headers.etag).toBe('"e1"');
    expect(sink.head?.headers["cache-control"]).toBe("public, max-age=0");
    const command = send$.mock.calls[0][0] as unknown as {
      input: { Bucket: string; Key: string };
    };
    expect(command.input).toMatchObject({
      Bucket: "assets",
      Key: "base/feed.xml",
    });
  });

  it("uses the file's real name as the key", async () => {
    send$.mockImplementation((async () => ({
      Body: Readable.from([Buffer.from("png")]),
    })) as never);
    await get("/images/logo@2x.png");
    const command = send$.mock.calls[0][0] as unknown as {
      input: { Key: string };
    };
    expect(command.input.Key).toBe("base/images/logo@2x.png");
  });

  it("answers a matching If-None-Match with the 304 S3 gave", async () => {
    send$.mockImplementation((async () => {
      throw Object.assign(new Error("Not Modified"), {
        name: "NotModified",
        $metadata: { httpStatusCode: 304 },
      });
    }) as never);
    const sink = await get("/feed.xml", { "if-none-match": '"e1"' });
    expect(sink.head?.statusCode).toBe(304);
    expect(sink.body.length).toBe(0);
  });

  it("falls through to the 404 when the object is gone", async () => {
    send$.mockImplementation((async () => {
      throw Object.assign(new Error("NoSuchKey"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });
    }) as never);
    const sink = await get("/feed.xml");
    expect(sink.head?.statusCode).toBe(404);
  });

  it("forwards a Range and answers S3's 206", async () => {
    send$.mockImplementation((async () => ({
      Body: Readable.from([Buffer.from("rss")]),
      ContentLength: 3,
      ContentRange: "bytes 1-3/6",
      AcceptRanges: "bytes",
    })) as never);
    const sink = await get("/feed.xml", { range: "bytes=1-3" });
    expect(sink.head?.statusCode).toBe(206);
    expect(sink.head?.headers["content-range"]).toBe("bytes 1-3/6");
    expect(sink.head?.headers["accept-ranges"]).toBe("bytes");
    expect(sink.body.toString("utf-8")).toBe("rss");
    const command = send$.mock.calls[0][0] as unknown as {
      input: { Range?: string };
    };
    expect(command.input.Range).toBe("bytes=1-3");
  });

  it("answers an unsatisfiable Range with a 416", async () => {
    send$.mockImplementation((async () => {
      throw Object.assign(new Error("InvalidRange"), {
        name: "InvalidRange",
        $metadata: { httpStatusCode: 416 },
      });
    }) as never);
    const sink = await get("/feed.xml", { range: "bytes=999-" });
    expect(sink.head?.statusCode).toBe(416);
    expect(sink.body.length).toBe(0);
  });

  // S3 can't evaluate If-Range, and ignoring Range is always allowed.
  it("drops the Range when If-Range is present", async () => {
    send$.mockImplementation((async () => ({
      Body: Readable.from([Buffer.from("<rss/>")]),
    })) as never);
    const sink = await get("/feed.xml", {
      range: "bytes=1-3",
      "if-range": '"e1"',
    });
    expect(sink.head?.statusCode).toBe(200);
    const command = send$.mock.calls[0][0] as unknown as {
      input: { Range?: string };
    };
    expect(command.input.Range).toBeUndefined();
  });

  it("uses the object's own Cache-Control, as the edge serves it", async () => {
    send$.mockImplementation((async () => ({
      Body: Readable.from([Buffer.from("<rss/>")]),
      CacheControl: "public, max-age=3600",
    })) as never);
    const sink = await get("/feed.xml");
    expect(sink.head?.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("leaves an unlisted path to the app", async () => {
    await get("/test.txt");
    expect(send$).not.toHaveBeenCalled();
  });
});

describe("revalidatedPageRoutes", () => {
  const manifest = (i18n: unknown) =>
    ({ buildId: "b1", config: { i18n } }) as unknown as AdapterManifest;
  const i18n = { locales: ["en", "fr"], defaultLocale: "en" };

  it("is the route and its data route without i18n", () => {
    expect(revalidatedPageRoutes("/blog", manifest(null))).toEqual([
      ["/blog", "/_next/data/b1/blog.json"],
    ]);
    expect(revalidatedPageRoutes("/", manifest(null))).toEqual([
      ["/", "/_next/data/b1/index.json"],
    ]);
  });

  // The Next client puts the locale in every data href, the default included.
  it("puts the default locale in the data route, and invalidates both HTML spellings", () => {
    expect(revalidatedPageRoutes("/blog", manifest(i18n))).toEqual([
      ["/blog", "/_next/data/b1/en/blog.json"],
      ["/en/blog", "/_next/data/b1/en/blog.json"],
    ]);
    expect(revalidatedPageRoutes("/en/blog", manifest(i18n))).toEqual([
      ["/blog", "/_next/data/b1/en/blog.json"],
      ["/en/blog", "/_next/data/b1/en/blog.json"],
    ]);
  });

  it("names the root's data route after the locale", () => {
    expect(revalidatedPageRoutes("/", manifest(i18n))).toEqual([
      ["/", "/_next/data/b1/en.json"],
      ["/en", "/_next/data/b1/en.json"],
    ]);
    expect(revalidatedPageRoutes("/fr", manifest(i18n))).toEqual([
      ["/fr", "/_next/data/b1/fr.json"],
    ]);
  });

  it("keeps another locale's page to its own prefix", () => {
    expect(revalidatedPageRoutes("/fr/blog", manifest(i18n))).toEqual([
      ["/fr/blog", "/_next/data/b1/fr/blog.json"],
    ]);
  });
});
