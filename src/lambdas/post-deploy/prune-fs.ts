import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { debug } from "../utils";

interface PruneFsProps {
  mountPath: string;
  currentBuildId: string;
}

/**
 * Given `mountPath` and `currentBuildId`, delete all directories at `mountPath`
 * that are not named `currentBuildId`
 */
export function pruneFs(props: PruneFsProps) {
  const { mountPath, currentBuildId } = props;

  // Ensure the mount path exists
  if (!existsSync(mountPath)) {
    debug(`Mount path ${mountPath} does not exist, nothing to prune`);
    return;
  }

  // Read all entries in the directory
  const entries = readdirSync(mountPath);

  // Filter for directories only and exclude the current build ID
  const directoriesToDelete = entries.filter((entry) => {
    const entryPath = join(mountPath, entry);
    return statSync(entryPath).isDirectory() && entry !== currentBuildId;
  });

  // Delete each directory
  for (const dir of directoriesToDelete) {
    const dirPath = join(mountPath, dir);
    debug(`Pruning directory: ${dirPath}`);
    rmSync(dirPath, { recursive: true, force: true });
  }

  debug(
    `Pruned ${directoriesToDelete.length} directories, kept ${currentBuildId}`,
  );
}
