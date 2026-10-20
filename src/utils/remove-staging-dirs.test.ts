import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { DISABLE_ASSET_STAGING_CONTEXT } from "aws-cdk-lib/cx-api";
import { removeStagingDirs } from "./remove-staging-dirs";

describe("removeStagingDirs", () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "remove-staging-")));
  });

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes every directory", () => {
    removeStagingDirs(new Stack(new App(), "TestStack"), dirs);
    expect(dirs.filter((dir) => existsSync(dir))).toEqual([]);
  });

  it("keeps them when asset staging is disabled", () => {
    const app = new App({ context: { [DISABLE_ASSET_STAGING_CONTEXT]: true } });
    removeStagingDirs(new Stack(app, "TestStack"), dirs);
    expect(dirs.filter((dir) => existsSync(dir))).toEqual(dirs);
  });
});
