import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Creates symbolic links recursively from `srcPath` to `destPath`.
 *
 * Used to symlink .next/server/app -> /mnt/cdk-nextjs-cache/full-route-cache.
 * See docs/dev.md for details.
 */
function createSymlinks(srcPath: string, destPath: string): void {
  // Create the destination directory if it doesn't exist
  mkdirSync(destPath, { recursive: true });

  const entries = readdirSync(srcPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(srcPath, entry.name);
    if (entry.isDirectory()) {
      // If the entry is a directory, recurse into it
      createSymlinks(entryPath, join(destPath, entry.name));
    } else if (entry.isFile()) {
      const ext = extname(entryPath).slice(1);

      // Check if the file extension is html, rsc, or meta
      if (["html", "rsc", "meta"].includes(ext)) {
        // Create a symbolic link for html, rsc, or meta files
        const symlink = entryPath;
        const target = join(destPath, entry.name);
        // console.log(`linking ${symlink} -> ${target}`);
        rmSync(symlink); // symlink path must not exist in order to create
        symlinkSync(target, symlink, "file");
      }
    }
  }
}

const [sourcePath, destPath] = process.argv.slice(2);
createSymlinks(sourcePath, destPath);
