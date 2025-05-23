import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { extname, join } from "node:path";

/*
  CLI Tool to create symlinks from target to src paths while removing the original
  target files which is required for symlink. Also, optionally filters based on
  file extension.

  Linux `ln` terminology is a little confusing IMO but we use it here for consistency.
  Usage: `ln -s <source_path> <target_path>` where <target_path> points to <source_path>
  Example: `ln -s /usr/src /home/src` will create a symbolic link named /home/src
  and point it to /usr/src. In other words `readlink /home/src` will produce `/usr/src`.

  <targetPath> -> <srcPath>

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
 * Creates symbolic links for files found recursively in `targetPath` to similar
 * relative path `targetPath`. Deletes each `targetPath` file before creating
 * symlink (required).
 */
function createSymlinks(props: CreateSymlinksProps): void {
  const { srcPath, targetPath, includeExtensions } = props;
  // Create the srcPath directory if it doesn't exist
  mkdirSync(srcPath, { recursive: true });

  const targetEntries = readdirSync(targetPath, { withFileTypes: true });
  for (const targetEntry of targetEntries) {
    const targetEntryPath = join(targetPath, targetEntry.name);
    if (targetEntry.isDirectory()) {
      // If the entry is a directory, recurse into it
      createSymlinks({
        srcPath: join(srcPath, targetEntry.name),
        targetPath: targetEntryPath,
        includeExtensions,
      });
    } else if (targetEntry.isFile()) {
      const ext = extname(targetEntryPath).slice(1);

      // Check if the file's extensions match give extensions
      if (includeExtensions.includes("*") || includeExtensions.includes(ext)) {
        const _targetPath = targetEntryPath;
        const _srcPath = join(srcPath, targetEntry.name);
        console.log(`linking ${_targetPath} -> ${_srcPath}`);
        rmSync(_targetPath); // target must be removed in order to symlink
        // like `ln -s _srcPath _targetPath`
        symlinkSync(_srcPath, _targetPath);
      }
    }
  }
}
