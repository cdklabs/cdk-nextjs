import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { extname, join } from "node:path";

/*
  CLI Tool to create symlinks between src and dest paths optionally filtering
  based on file extensions.

  Example: Used to symlink .next/server/app -> /mnt/cdk-nextjs-cache/full-route-cache.
  See docs/dev.md for details.
*/

const [sourcePath, destPath, _extensions] = process.argv.slice(2) as (
  | string
  | undefined
)[];
if (!sourcePath || !destPath) {
  console.error("Usage: node symlink.mjs <sourcePath> <destPath> [extensions]");
  process.exit(1);
}
// default to all file extensions
const extensions = _extensions ? _extensions.split(",") : ["*"];
createSymlinks(sourcePath, destPath, extensions);

/**
 * Creates symbolic links recursively from `srcPath` to `destPath`.
 */
function createSymlinks(
  srcPath: string,
  destPath: string,
  extensions: string[],
): void {
  // Create the destination directory if it doesn't exist
  mkdirSync(destPath, { recursive: true });

  const entries = readdirSync(srcPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(srcPath, entry.name);
    if (entry.isDirectory()) {
      // If the entry is a directory, recurse into it
      createSymlinks(entryPath, join(destPath, entry.name), extensions);
    } else if (entry.isFile()) {
      const ext = extname(entryPath).slice(1);

      // Check if the file's extensions match give extensions
      if (extensions.includes("*") || extensions.includes(ext)) {
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
