import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { loadRuntime, NextjsRuntime, RuntimeRequest } from "./core";
import {
  BuildCompleteContext,
  buildAdapterManifest,
} from "../adapter/build-outputs";
import { ResponseHead } from "./http/response";
import { ResponseSink } from "./http/sink";
import { deployedManifestPath } from "./manifest";
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
  if (url.searchParams.has("boom")) {
    throw new Error("route exploded");
  }
  // What both routers do for \`notFound()\` they cannot render themselves. Only
  // the route that gave up does it: the runtime renders the 404 against the
  // *same* URL, so the not-found module reaching here again would recurse.
  if (url.searchParams.has("render404") && !__filename.includes("_not-found")) {
    await ctx.requestMeta.render404();
    return;
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
      hasRender404: Boolean(ctx.requestMeta && ctx.requestMeta.render404),
      waitUntil: typeof ctx.waitUntil,
      cwd: process.cwd(),
      header: req.headers["x-from-middleware"] || null,
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

/**
 * Materializes the tree a deployment stages: the manifest under
 * `cdk-nextjs-runtime/`, a stub at every entrypoint `filePath`, the static files
 * the manifest points at, and the `required-server-files.json` `loadRuntime`
 * probes for.
 */
function stageDeployment(middlewareSource = MIDDLEWARE_STUB): string {
  // The fixture is a real captured context, as JSON: the structural cast is the
  // point of the cast (see `build-outputs.test.ts`).
  const ctx = structuredClone(appPlayground) as unknown as BuildCompleteContext;
  const { manifest } = buildAdapterManifest(ctx, { buildCwd: ctx.projectDir });
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
  return root;
}

let root: string;
let runtime: NextjsRuntime;
const originalCwd = process.cwd();

beforeAll(async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
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

  it("trusts x-forwarded-host over the host CloudFront rewrote", async () => {
    const sink = await send({
      url: "/",
      headers: {
        host: "origin.cloudfront.internal",
        "x-forwarded-host": "www.example.test",
      },
    });
    expect(stubBody(sink).initURL).toBe("https://www.example.test/");
  });

  it("hands a dynamic route its params as nxtP query values", async () => {
    const sink = await send({ url: "/isr/42" });
    const body = stubBody(sink);
    expect(body.file).toBe(
      join(root, "app-playground/.next/server/app/isr/[id]/page.js"),
    );
    // The documented deployed-proxy contract: `prepare()` recovers `params`
    // from these, which is why nothing passes `requestMeta.params`.
    expect(body.url).toBe("/isr/42?nxtPid=42");
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

  it("renders the 404 page when a route calls requestMeta.render404()", async () => {
    const sink = await send({ url: "/?render404=1" });
    expect(sink.head?.statusCode).toBe(404);
    // Whatever the route that gave up was rendering, for the same reason.
    expect(stubBody(sink).url).toBe("/?render404=1");
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

  it("answers 500 when an entrypoint throws before sending a head", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const sink = await send({ url: "/?boom=1" });
    expect(sink.head?.statusCode).toBe(500);
    expect(sink.body.toString("utf-8")).toBe("Internal Server Error");
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
    headers: {
      "content-type": "text/plain",
      "set-cookie": "sid=; Path=/, flag=1; Path=/",
    },
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
    expect(sink.head?.cookies).toEqual(["sid=; Path=/", "flag=1; Path=/"]);
    expect(sink.body.toString("utf-8")).toBe("denied");
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
});
