import { cpSync } from "node:fs";
import { extname } from "node:path";
import { FsToFsAction } from "../../nextjs-assets-deployment";
import { debug } from "../utils";

export function fsToFs(props: FsToFsAction) {
  const { sourcePath, destinationPath, includeExtensions } = props;
  debug(`Copying ${sourcePath} to ${destinationPath} recursively`);
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    filter: (_src, dest) => {
      // console.log({ _src, dest });
      const isDirectory = extname(dest) === "";
      if (isDirectory) {
        return true;
      }
      return includeExtensions
        ? includeExtensions.includes(extname(dest))
        : true;
    },
  });
}
