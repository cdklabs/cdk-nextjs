import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { crc32, zipDirectory } from "./zip-directory";

/** A pnpm-shaped tree: the logical path links into the store. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "cdk-nextjs-zip-"));
  const pkg = join(
    root,
    "node_modules",
    ".pnpm",
    "a@1.0.0",
    "node_modules",
    "a",
  );
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "index.js"), "module.exports = 'a';\n".repeat(50));
  writeFileSync(join(pkg, "bin.sh"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(root, "app", "node_modules"), { recursive: true });
  symlinkSync(
    "../../node_modules/.pnpm/a@1.0.0/node_modules/a",
    join(root, "app", "node_modules", "a"),
  );
  mkdirSync(join(root, "empty"));
  return root;
}

describe("crc32", () => {
  // Its own, because `zlib.crc32` is missing before Node 20.15.
  it("matches zlib's", () => {
    for (const data of ["", "a", "hello, world", "x".repeat(100_000)]) {
      expect(crc32(Buffer.from(data))).toBe(zlib.crc32(data));
    }
  });
});

describe("zipDirectory", () => {
  it("round-trips symlinks as symlinks through unzip", () => {
    const root = makeTree();
    const out = mkdtempSync(join(tmpdir(), "cdk-nextjs-unzip-"));
    writeFileSync(join(out, "root.zip"), zipDirectory(root));
    execFileSync("unzip", ["-q", "root.zip", "-d", "x"], { cwd: out });

    const link = join(out, "x", "app", "node_modules", "a");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(
      "../../node_modules/.pnpm/a@1.0.0/node_modules/a",
    );
    expect(readFileSync(join(link, "index.js"), "utf8")).toContain("'a'");
    // eslint-disable-next-line no-bitwise
    expect(lstatSync(join(link, "bin.sh")).mode & 0o111).toBeTruthy();
    expect(lstatSync(join(out, "x", "empty")).isDirectory()).toBe(true);
  });

  it("is deterministic, so the asset hash only moves with the contents", () => {
    const root = makeTree();
    const first = zipDirectory(root);
    utimesSync(join(root, "empty"), 0, 0);
    expect(zipDirectory(root).equals(first)).toBe(true);
    // The same tree built somewhere else, at another time.
    expect(zipDirectory(makeTree()).equals(first)).toBe(true);
  });

  it("writes a Zip64 end record past 65,535 entries", () => {
    const root = mkdtempSync(join(tmpdir(), "cdk-nextjs-zip64-"));
    // Links are the cheapest entries to make.
    for (let i = 0; i < 0x10000 + 10; i++) {
      symlinkSync("t", join(root, `l${i}`));
    }
    const out = mkdtempSync(join(tmpdir(), "cdk-nextjs-unzip64-"));
    writeFileSync(join(out, "root.zip"), zipDirectory(root));
    const listing = execFileSync("unzip", ["-l", "root.zip"], {
      cwd: out,
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
    expect(listing.trim().split("\n").pop()).toMatch(/\b65546 files$/);
  }, 60_000);
});
