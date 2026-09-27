import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildCompleteContext } from "./build-outputs";
import { INIT_CACHE_TAG_MANIFEST } from "./cache-utils";
import { writeInitCache } from "./init-cache";

let dir: string;
let cacheDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "init-cache-test-"));
  cacheDir = join(dir, "cache");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A prerender output as `next build` hands it to `onBuildComplete`. */
async function prerender(
  pathname: string,
  parentOutputId: string,
  body: string,
  fallback: Record<string, unknown> = {},
) {
  const filePath = join(dir, `${pathname.replace(/\//g, "_")}.out`);
  await writeFile(filePath, body);
  return { pathname, parentOutputId, fallback: { filePath, ...fallback } };
}

function context(
  prerenders: unknown[],
  basePath = "",
): Pick<BuildCompleteContext, "config" | "outputs"> {
  return {
    config: { basePath },
    outputs: {
      pages: [{ id: "/blog/[slug]" }, { id: "/gone" }],
      appPages: [{ id: "/shop" }],
      appRoutes: [{ id: "/feed.xml" }],
      pagesApi: [],
      prerenders,
      staticFiles: [],
    },
  } as unknown as Pick<BuildCompleteContext, "config" | "outputs">;
}

const readEntry = async (key: string) =>
  JSON.parse(await readFile(join(cacheDir, `${key}.json`), "utf8"));

describe("writeInitCache", () => {
  it("seeds each kind with the shape the cache handler reads", async () => {
    const ctx = context([
      await prerender("/shop", "/shop", "<html>shop</html>", {
        initialStatus: 200,
        postponedState: undefined,
        initialHeaders: {
          "content-type": "text/html; charset=utf-8",
          "x-next-cache-tags": "shop,_N_T_/shop",
        },
      }),
      await prerender("/shop.rsc", "/shop", "flight"),
      await prerender("/shop.segments/_tree.segment.rsc", "/shop", "tree"),
      await prerender("/feed.xml", "/feed.xml", "<rss/>", {
        initialHeaders: { "content-type": "application/xml" },
      }),
      await prerender("/blog/hello", "/blog/[slug]", "<html>hello</html>", {
        initialStatus: 200,
        initialHeaders: { "content-type": "text/html" },
      }),
      await prerender(
        "/_next/data/build/blog/hello.json",
        "/blog/[slug]",
        JSON.stringify({ pageProps: { slug: "hello" } }),
      ),
    ]);
    await writeInitCache(ctx, cacheDir);

    const shop = await readEntry("shop");
    expect(shop.value.kind).toBe("APP_PAGE");
    expect(shop.value.html).toBe("<html>shop</html>");
    expect(shop.value.status).toBe(200);
    // Presentational headers stay out of an APP_PAGE entry; the render's own
    // (cache tags) stay in.
    expect(shop.value.headers).toEqual({
      "x-next-cache-tags": "shop,_N_T_/shop",
    });
    expect(JSON.stringify(shop.value.rscData)).toContain(
      Buffer.from("flight").toString("base64"),
    );
    expect(JSON.stringify(shop.value.segmentData)).toContain("/_tree");

    const feed = await readEntry("feed.xml");
    expect(feed.value.kind).toBe("APP_ROUTE");
    expect(feed.value.status).toBe(200);
    expect(feed.value.headers).toEqual({ "content-type": "application/xml" });

    const hello = await readEntry("blog/hello");
    expect(hello.value.kind).toBe("PAGES");
    expect(hello.value.html).toBe("<html>hello</html>");
    expect(hello.value.pageData).toEqual({ pageProps: { slug: "hello" } });
    // `FileSystemCache` hands a PAGES entry back without headers; seeding
    // `initialHeaders` would label its JSON data responses text/html.
    expect(hello.value.headers).toBeUndefined();
  });

  it("skips a Pages Router route prerendered with a non-200 status", async () => {
    // A build-time `notFound: true`: seeding it would be a 200 HIT with the 404
    // page's HTML.
    const ctx = context([
      await prerender("/gone", "/gone", "<html>404</html>", {
        initialStatus: 404,
      }),
    ]);
    await writeInitCache(ctx, cacheDir);
    expect(existsSync(join(cacheDir, "gone.json"))).toBe(false);
  });

  it("maps each tag to the keys carrying it, under basePath-less keys", async () => {
    const ctx = context(
      [
        await prerender("/docs/shop", "/shop", "<html>a</html>", {
          initialHeaders: { "x-next-cache-tags": "products,_N_T_/shop" },
        }),
      ],
      "/docs",
    );
    await writeInitCache(ctx, cacheDir);

    const manifest = JSON.parse(
      await readFile(join(cacheDir, INIT_CACHE_TAG_MANIFEST), "utf8"),
    );
    expect(manifest).toEqual({
      products: ["shop"],
      "_N_T_/shop": ["shop"],
    });
  });

  it("writes no tag manifest when nothing is tagged", async () => {
    const ctx = context([await prerender("/feed.xml", "/feed.xml", "<rss/>")]);
    await writeInitCache(ctx, cacheDir);
    expect(await readdir(cacheDir)).toEqual(["feed.xml.json"]);
  });
});
