import { join } from "node:path";
import { nextModule, useNextFrom } from "./next-modules";

/** This repo's own root, which has a `node_modules/next`, as a stand-in for a staged project dir. */
const repoRoot = join(__dirname, "../..");

describe("nextModule", () => {
  it("resolves a next submodule out of the pointed-at project dir", () => {
    useNextFrom(repoRoot);
    const { getExtension } = nextModule<
      typeof import("next/dist/server/serve-static.js")
    >("next/dist/server/serve-static.js");
    expect(getExtension("image/webp")).toBe("webp");
  });

  it("explains that the deployment package is incomplete when resolution fails", () => {
    useNextFrom(repoRoot);
    expect(() => nextModule("next/dist/server/not-a-real-module.js")).toThrow(
      /Could not resolve .* from the deployed Next.js project/,
    );
  });

  it("explains that the runtime was not loaded when nothing pointed it anywhere", () => {
    // `useNextFrom` is module state, so the uninitialized case needs a fresh copy
    // of the module rather than a reset of this one.
    jest.isolateModules(() => {
      const fresh =
        jest.requireActual<typeof import("./next-modules")>("./next-modules");
      expect(() =>
        fresh.nextModule("next/dist/server/serve-static.js"),
      ).toThrow(/resolution has not been pointed at the staged app yet/);
    });
  });
});
