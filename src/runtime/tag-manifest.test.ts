import { AsyncLocalStorage } from "node:async_hooks";
import {
  captureOutsideRequest,
  catchUpTags,
  OUTSIDE_REQUEST_SYMBOL,
  outsideRequest,
  TAG_MANIFEST_SYMBOL,
} from "./tag-manifest";

const global = globalThis as {
  [TAG_MANIFEST_SYMBOL]?: unknown;
  [OUTSIDE_REQUEST_SYMBOL]?: unknown;
};

afterEach(() => {
  delete global[TAG_MANIFEST_SYMBOL];
  delete global[OUTSIDE_REQUEST_SYMBOL];
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

describe("outsideRequest", () => {
  // Stands in for Next.js's request store.
  const request = new AsyncLocalStorage<string>();

  it("runs in the context captured at load, where no request store is set", async () => {
    captureOutsideRequest();
    await request.run("page render", async () => {
      expect(outsideRequest(() => request.getStore())).toBeUndefined();
      // Awaited work it starts stays outside too.
      await expect(
        outsideRequest(async () => {
          await Promise.resolve();
          return request.getStore();
        }),
      ).resolves.toBeUndefined();
      expect(request.getStore()).toBe("page render");
    });
  });

  it("keeps the first capture", () => {
    captureOutsideRequest();
    request.run("page render", () => captureOutsideRequest());
    request.run("another render", () =>
      expect(outsideRequest(() => request.getStore())).toBeUndefined(),
    );
  });

  it("runs in the current context when nothing was captured", () => {
    request.run("page render", () =>
      expect(outsideRequest(() => request.getStore())).toBe("page render"),
    );
  });
});
