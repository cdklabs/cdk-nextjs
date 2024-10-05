import { existsSync, mkdirSync, readFileSync } from "fs";
import type { CloudFormationCustomResourceHandler } from "aws-lambda";
import { fsToFs } from "./fs-to-fs";
import { fsToS3 } from "./fs-to-s3";
import { pruneS3 } from "./prune-s3";
import { cfnResponse, CfnResponseStatus, debug } from "./utils";
import type { CustomResourceProperties } from "../../nextjs-assets-deployment";

type ResourceProps = CustomResourceProperties & {
  ServiceToken: string;
};

export const handler: CloudFormationCustomResourceHandler = async (
  event,
  context,
) => {
  debug({ event });
  let responseStatus = CfnResponseStatus.Failed;
  let previewModeId = "";
  try {
    const props = event.ResourceProperties as ResourceProps;
    if (event.RequestType === "Create" || event.RequestType === "Update") {
      const { actions } = props;
      for (const action of actions) {
        if (action.type === "fs-to-fs") {
          fsToFs(action);
        } else if (action.type === "fs-to-s3") {
          await fsToS3(action);
        } else if (action.type === "prune-s3") {
          await pruneS3(action);
        }
      }
      initImageCache(props.imageCachePath);
      previewModeId = getPreviewModeId(props.prerenderManifestPath);
      responseStatus = CfnResponseStatus.Success;
    } else {
      responseStatus = CfnResponseStatus.Success;
    }
  } catch (err) {
    console.error(err);
    throw err;
  }
  await cfnResponse({
    event,
    context,
    responseStatus,
    responseData: { previewModeId },
  });
};

function initImageCache(imageCachePath: string) {
  if (imageCachePath && !existsSync(imageCachePath)) {
    // only runs first time
    mkdirSync(imageCachePath);
  }
}

/**
 * Only need preview mode id for `NextjsGlobalFunctions`, but easy to get
 * so we do it each time.
 */
function getPreviewModeId(prerenderManifestPath: string): string {
  const prerenderManifest = JSON.parse(
    readFileSync(prerenderManifestPath, { encoding: "utf-8" }),
  );
  return prerenderManifest.preview.previewModeId;
}
