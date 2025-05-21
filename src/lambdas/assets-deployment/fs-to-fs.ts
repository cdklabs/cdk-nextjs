import { cpSync } from "node:fs";
import { debug } from "./utils";
import { FsToFsAction } from "../../nextjs-assets-deployment";

export function fsToFs(props: FsToFsAction) {
  const { sourcePath, destinationPath } = props;
  debug(`Copying ${sourcePath} to ${destinationPath} recursively`);
  cpSync(sourcePath, destinationPath, { recursive: true });
}
