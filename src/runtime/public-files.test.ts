import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublicFiles } from "./public-files";

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
