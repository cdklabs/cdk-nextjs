import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterManifest,
  PUBLIC_FILES_FILE_NAME,
  RUNTIME_DIR_NAME,
} from "./manifest";
import { readPublicFiles, resolvePublicFiles } from "./public-files";

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "cdk-nextjs-public-")));
}

describe("readPublicFiles", () => {
  it("lists every file, nested, unencoded and sorted", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "images"));
    writeFileSync(join(dir, "robots.txt"), "");
    writeFileSync(join(dir, "images", "logo@2x.png"), "");
    writeFileSync(join(dir, "hello e2e.png"), "");
    expect(readPublicFiles(dir)).toEqual([
      "hello e2e.png",
      "images/logo@2x.png",
      "robots.txt",
    ]);
  });

  it("follows symlinks to files and directories, as Next.js does", () => {
    // `Dirent.isFile()` describes the link, so filtering on it dropped
    // `public/latest.pdf -> v2/report.pdf` while Docker and S3 both carry it.
    const dir = tempDir();
    mkdirSync(join(dir, "v2"));
    writeFileSync(join(dir, "v2", "report.pdf"), "");
    symlinkSync(join(dir, "v2", "report.pdf"), join(dir, "latest.pdf"));
    symlinkSync(join(dir, "v2"), join(dir, "current"));
    expect(readPublicFiles(dir)).toEqual([
      "current/report.pdf",
      "latest.pdf",
      "v2/report.pdf",
    ]);
  });

  it("stops at a link cycle and skips a dangling link", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "file.txt"), "");
    symlinkSync(join(dir, "a"), join(dir, "a", "loop"));
    symlinkSync(join(dir, "missing"), join(dir, "dangling"));
    expect(readPublicFiles(dir)).toEqual(["a/file.txt"]);
  });

  it("is empty when there is no public/, as on the Lambda types", () => {
    expect(readPublicFiles(join(tempDir(), "public"))).toEqual([]);
  });
});

describe("resolvePublicFiles", () => {
  const manifest = { relativeProjectDir: "apps/web" } as AdapterManifest;

  function writeList(root: string, contents: string): void {
    mkdirSync(join(root, RUNTIME_DIR_NAME), { recursive: true });
    writeFileSync(
      join(root, RUNTIME_DIR_NAME, PUBLIC_FILES_FILE_NAME),
      contents,
    );
  }

  it("lists public/ off disk when there is no list, on RegionalContainers", () => {
    const root = tempDir();
    mkdirSync(join(root, "apps/web/public"), { recursive: true });
    writeFileSync(join(root, "apps/web/public/robots.txt"), "");
    expect(resolvePublicFiles(root, manifest)).toEqual({
      files: ["robots.txt"],
      inS3: false,
    });
  });

  it("reads the synth-time list when public/ is not staged, on the Lambda types", () => {
    const root = tempDir();
    writeList(root, JSON.stringify(["feed.xml", "sitemap.xml"]));
    expect(resolvePublicFiles(root, manifest)).toEqual({
      files: ["feed.xml", "sitemap.xml"],
      inS3: true,
    });
  });

  it("prefers the list over a public/ file the trace staged", () => {
    // An OG-image route reading `public/fonts/Inter.ttf` through `fs` gets it
    // traced into a Lambda root; the rest of `public/` is still only in S3.
    const root = tempDir();
    mkdirSync(join(root, "apps/web/public/fonts"), { recursive: true });
    writeFileSync(join(root, "apps/web/public/fonts/Inter.ttf"), "");
    writeList(root, JSON.stringify(["fonts/Inter.ttf", "logo.png"]));
    expect(resolvePublicFiles(root, manifest)).toEqual({
      files: ["fonts/Inter.ttf", "logo.png"],
      inS3: true,
    });
  });

  it("is empty for an app with neither", () => {
    expect(resolvePublicFiles(tempDir(), manifest)).toEqual({
      files: [],
      inS3: false,
    });
  });

  it("rejects a list that is not an array of paths", () => {
    const root = tempDir();
    writeList(root, JSON.stringify({ files: [] }));
    expect(() => resolvePublicFiles(root, manifest)).toThrow(
      /is not a JSON array of paths/,
    );
  });
});
