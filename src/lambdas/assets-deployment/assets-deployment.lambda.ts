import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  /**
   * Related to [Draft Mode](https://nextjs.org/docs/app/building-your-application/configuring/draft-mode)
   * and required for `NextjsRevalidation` to do [on-demand revalidation](https://nextjs.org/docs/app/building-your-application/data-fetching/incremental-static-regeneration#on-demand-revalidation-with-revalidatepath)
   */
  let previewModeId = "";
  try {
    const props = event.ResourceProperties as ResourceProps;
    if (event.RequestType === "Create" || event.RequestType === "Update") {
      const { actions, nextjsType } = props;
      for (const action of actions) {
        if (action.type === "fs-to-fs") {
          fsToFs(action);
        } else if (action.type === "fs-to-s3") {
          await fsToS3(action, nextjsType);
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
  } finally {
    await cfnResponse({
      event,
      context,
      responseStatus,
      responseData: { previewModeId },
    });
  }
};

/**
 * On first deployment there is no directory for images to be optimized into by
 * Next.js so this creates directory for those images. Only runs once.
 * This is unlike other cache directories which are created at build time.
 */
function initImageCache(imageCachePath: string) {
  if (imageCachePath && !existsSync(imageCachePath)) {
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
