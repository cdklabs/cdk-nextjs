import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeBasePath,
  readNextConfigBasePath,
} from "./read-next-config-base-path";

describe("readNextConfigBasePath", () => {
  let dotNextPath: string;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    dotNextPath = mkdtempSync(join(tmpdir(), "read-next-config-base-path-"));
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(dotNextPath, { recursive: true, force: true });
  });

  function writeRequiredServerFiles(contents: string) {
    writeFileSync(join(dotNextPath, "required-server-files.json"), contents);
  }

  it("reads the app's basePath and strips the leading slash", () => {
    writeRequiredServerFiles(JSON.stringify({ config: { basePath: "/prod" } }));

    expect(readNextConfigBasePath(dotNextPath)).toBe("prod");
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns an empty string when the app sets no basePath", () => {
    // `next build` writes basePath: "" rather than omitting it.
    writeRequiredServerFiles(JSON.stringify({ config: { basePath: "" } }));

    expect(readNextConfigBasePath(dotNextPath)).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  // Degrading to "" is deliberate, but it's indistinguishable from an app that
  // sets no basePath, so it has to be visible: the Global constructs derive
  // their basePath from this value and would otherwise 404 every static asset
  // with nothing but a silent fallback to explain it.
  it("warns when required-server-files.json is missing", () => {
    expect(readNextConfigBasePath(dotNextPath)).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("required-server-files.json"),
    );
  });

  it("warns when the file isn't valid JSON", () => {
    writeRequiredServerFiles("not json");

    expect(readNextConfigBasePath(dotNextPath)).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read basePath"),
    );
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
