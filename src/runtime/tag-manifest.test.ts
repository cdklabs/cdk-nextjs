import { catchUpTags, TAG_MANIFEST_SYMBOL } from "./tag-manifest";

const global = globalThis as { [TAG_MANIFEST_SYMBOL]?: unknown };

afterEach(() => {
  delete global[TAG_MANIFEST_SYMBOL];
});

describe("catchUpTags", () => {
  it("does nothing before a cache handler creates the manifest", async () => {
    await expect(catchUpTags()).resolves.toBeUndefined();
  });

  it("reaches the manifest the cache handlers share", async () => {
    const manifest = { catchUp: jest.fn(async () => {}) };
    global[TAG_MANIFEST_SYMBOL] = manifest;
    await catchUpTags();
    expect(manifest.catchUp).toHaveBeenCalledTimes(1);
  });
});
