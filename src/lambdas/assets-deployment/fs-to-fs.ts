import { cpSync } from "node:fs";
import { FsToFsAction } from "../../nextjs-assets-deployment";
import { debug } from "./utils";

export function fsToFs(props: FsToFsAction) {
  const { sourcePath, destinationPath } = props;
  debug(`Copying ${sourcePath} to ${destinationPath} recursively`);
  cpSync(sourcePath, destinationPath, { recursive: true });
}
