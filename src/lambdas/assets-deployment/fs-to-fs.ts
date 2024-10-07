import { cpSync } from "node:fs";
import { FsToFsAction } from "../../nextjs-assets-deployment";

export function fsToFs(props: FsToFsAction) {
  const { sourcePath, destinationPath } = props;
  cpSync(sourcePath, destinationPath, { recursive: true });
}
