import { catchUpTags, TAG_MANIFEST_SYMBOL } from "./tag-manifest";

const global = globalThis as { [TAG_MANIFEST_SYMBOL]?: unknown };

afterEach(() => {
  delete global[TAG_MANIFEST_SYMBOL];
});

describe("catchUpTags", () => {
  it("just renders before a cache handler creates the manifest", async () => {
    await expect(catchUpTags(async () => "page")).resolves.toBe("page");
  });

  it("renders through the manifest the cache handlers share", async () => {
    const manifest = {
      catchUp: jest.fn(async (render: () => Promise<string>) => render()),
    };
    global[TAG_MANIFEST_SYMBOL] = manifest;
    await expect(catchUpTags(async () => "page")).resolves.toBe("page");
    expect(manifest.catchUp).toHaveBeenCalledTimes(1);
  });
});
