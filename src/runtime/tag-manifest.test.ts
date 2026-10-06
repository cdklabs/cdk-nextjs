import { catchUpTags, tagRefreshSettled } from "./tag-manifest";

const TAG_MANIFEST_SYMBOL = Symbol.for("cdk-nextjs.use-cache.tag-manifest");
const global = globalThis as { [TAG_MANIFEST_SYMBOL]?: unknown };

afterEach(() => {
  delete global[TAG_MANIFEST_SYMBOL];
});

describe("tag manifest hooks", () => {
  it("do nothing before a cache handler creates the manifest", async () => {
    await expect(catchUpTags()).resolves.toBeUndefined();
    await expect(tagRefreshSettled()).resolves.toBeUndefined();
  });

  it("reach the manifest the cache handlers share", async () => {
    const manifest = {
      catchUp: jest.fn(async () => {}),
      settled: jest.fn(async () => {}),
    };
    global[TAG_MANIFEST_SYMBOL] = manifest;
    await catchUpTags();
    await tagRefreshSettled();
    expect(manifest.catchUp).toHaveBeenCalledTimes(1);
    expect(manifest.settled).toHaveBeenCalledTimes(1);
  });
});
