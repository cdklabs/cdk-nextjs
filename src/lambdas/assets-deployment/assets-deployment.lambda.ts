import { existsSync, mkdirSync } from "node:fs";
import type { CloudFormationCustomResourceHandler } from "aws-lambda";
import { fsToFs } from "./fs-to-fs";
import { fsToS3 } from "./fs-to-s3";
import type { StaticAssetsCustomResourceProperties } from "../../nextjs-assets-deployment";
import { cfnResponse, CfnResponseStatus, debug } from "../utils";

type ResourceProps = StaticAssetsCustomResourceProperties & {
  ServiceToken: string;
};

export const handler: CloudFormationCustomResourceHandler = async (
  event,
  context,
) => {
  debug({ event });
  let responseStatus = CfnResponseStatus.Failed;
  try {
    const props = event.ResourceProperties as ResourceProps;
    if (event.RequestType === "Create" || event.RequestType === "Update") {
      const { actions, buildId, nextjsType } = props;
      for (const action of actions) {
        if (action.type === "fs-to-fs") {
          fsToFs(action);
        } else if (action.type === "fs-to-s3") {
          await fsToS3({ ...action, nextjsType, buildId });
        }
      }
      initImageCache(props.imageCachePath);
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
      responseData: {},
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
