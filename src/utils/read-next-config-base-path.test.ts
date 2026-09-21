import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeBasePath,
  readNextConfigBasePath,
} from "./read-next-config-base-path";

describe("readNextConfigBasePath", () => {
  let dotNextPath: string;

  beforeEach(() => {
    dotNextPath = mkdtempSync(join(tmpdir(), "read-next-config-base-path-"));
  });

  afterEach(() => {
    rmSync(dotNextPath, { recursive: true, force: true });
  });

  function writeRequiredServerFiles(contents: string) {
    writeFileSync(join(dotNextPath, "required-server-files.json"), contents);
  }

  it("reads the app's basePath and strips the leading slash", () => {
    writeRequiredServerFiles(JSON.stringify({ config: { basePath: "/prod" } }));

    expect(readNextConfigBasePath(dotNextPath)).toBe("prod");
  });

  it("returns an empty string when the app sets no basePath", () => {
    // `next build` writes basePath: "" rather than omitting it.
    writeRequiredServerFiles(JSON.stringify({ config: { basePath: "" } }));

    expect(readNextConfigBasePath(dotNextPath)).toBe("");
  });

  it("returns an empty string when required-server-files.json is missing", () => {
    // Nothing to compare against means the basePath check is skipped, which
    // shouldn't be enough to fail an otherwise working deployment.
    expect(readNextConfigBasePath(dotNextPath)).toBe("");
  });

  it("returns an empty string when the file isn't valid JSON", () => {
    writeRequiredServerFiles("not json");

    expect(readNextConfigBasePath(dotNextPath)).toBe("");
  });

  it("returns an empty string when the file has no config key", () => {
    writeRequiredServerFiles(JSON.stringify({ files: [] }));

    expect(readNextConfigBasePath(dotNextPath)).toBe("");
  });
});

describe("normalizeBasePath", () => {
  it("reduces values addressing the same path to the same segment", () => {
    expect(normalizeBasePath("/base")).toBe("base");
    expect(normalizeBasePath("base")).toBe("base");
    expect(normalizeBasePath("/base/")).toBe("base");
    expect(normalizeBasePath("//base//")).toBe("base");
  });

  it("maps undefined and empty values to an empty string", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
  });

  it("keeps interior slashes of a nested basePath", () => {
    expect(normalizeBasePath("/team/app/")).toBe("team/app");
  });
});
