import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { extname, join } from "node:path";

/*
  CLI Tool to create symlinks from target to src paths while removing the original
  target files. Also, optionally filters based on file extension.

  NOTE: symlinks are target -> src such that `readlink target` produces `src`

  Example: Used to symlink .next/server/app -> /mnt/cdk-nextjs/{BUILD_ID}/.next/server/app.
  See docs/notes.md for details.
*/

const [srcPathArg, targetPathArg, _includeExtensions] = process.argv.slice(
  2,
) as (string | undefined)[];
if (!targetPathArg || !srcPathArg) {
  console.error("Usage: node symlink.mjs <srcPath> <targetPath> [extensions]");
  process.exit(1);
}
// default to all file extensions
const includeExtensionsArg = _includeExtensions
  ? _includeExtensions.split(",")
  : ["*"];
createSymlinks({
  targetPath: targetPathArg,
  srcPath: srcPathArg,
  includeExtensions: includeExtensionsArg,
});

interface CreateSymlinksProps {
  srcPath: string;
  targetPath: string;
  includeExtensions: string[];
}

/**
 * Creates symbolic links recursively from `targetPath` to `srcPath`.
 */
function createSymlinks(props: CreateSymlinksProps): void {
  const { srcPath, targetPath, includeExtensions } = props;
  // Create the destination directory if it doesn't exist
  mkdirSync(targetPath, { recursive: true });

  const entries = readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(targetPath, entry.name);
    if (entry.isDirectory()) {
      // If the entry is a directory, recurse into it
      createSymlinks({
        srcPath: join(srcPath, entry.name),
        targetPath: entryPath,
        includeExtensions,
      });
    } else if (entry.isFile()) {
      const ext = extname(entryPath).slice(1);

      // Check if the file's extensions match give extensions
      if (includeExtensions.includes("*") || includeExtensions.includes(ext)) {
        // Create a symbolic link for html, rsc, or meta files
        const symlink = entryPath;
        const target = join(srcPath, entry.name);
        console.log(`linking ${symlink} -> ${target}`);
        rmSync(symlink); // symlink path must not exist in order to create
        symlinkSync(target, symlink, "file");
      }
    }
  }
}
