import type { CloudFormationCustomResourceHandler } from "aws-lambda";
import { createInvalidation } from "./create-invalidation";
import { pruneFs } from "./prune-fs";
import { pruneS3 } from "./prune-s3";
import { MOUNT_PATH } from "../../constants";
import { PostDeployCustomResourceProperties } from "../../nextjs-post-deploy";
import { cfnResponse, CfnResponseStatus, debug } from "../utils";

type ResourceProps = PostDeployCustomResourceProperties & {
  ServiceToken: string;
};

/**
 * Performs:
 * 1. CloudFront Invalidation
 * 2. Prune EFS old BUILD_ID directories
 * 3. Prunes objects in S3 that do not have metadata with current BUILD_ID and
 * were modified over `msTtl` ago (default 30 days).
 */
export const handler: CloudFormationCustomResourceHandler = async (
  event,
  context,
) => {
  debug({ event });
  let responseStatus = CfnResponseStatus.Failed;
  try {
    const props = event.ResourceProperties as ResourceProps;
    if (event.RequestType === "Create" || event.RequestType === "Update") {
      const {
        buildId,
        createInvalidationCommandInput,
        msTtl,
        staticAssetsBucketName,
      } = props;
      const promises: Promise<unknown>[] = [];
      if (createInvalidationCommandInput) {
        promises.push(createInvalidation(createInvalidationCommandInput));
      }
      pruneFs({ currentBuildId: buildId, mountPath: MOUNT_PATH });
      if (staticAssetsBucketName) {
        // will not run for regional
        promises.push(
          pruneS3({
            bucketName: staticAssetsBucketName,
            currentBuildId: buildId,
            msTtl: parseInt(msTtl),
          }),
        );
      }
      await Promise.all(promises);
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
