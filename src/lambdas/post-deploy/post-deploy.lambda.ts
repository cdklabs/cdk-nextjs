import type { CloudFormationCustomResourceHandler } from "aws-lambda";
import getDebug from "debug";
import { createInvalidation } from "./create-invalidation";
import { pruneCacheBucket } from "./prune-cache-bucket";
import { pruneRevalidationTable } from "./prune-revalidation-table";
import { pruneS3 } from "./prune-s3";
import { PostDeployCustomResourceProperties } from "../../nextjs-post-deploy";
import { cfnResponse, CfnResponseStatus } from "../utils";

const debug = getDebug("cdk-nextjs:post-deploy");

type ResourceProps = PostDeployCustomResourceProperties & {
  ServiceToken: string;
};

/**
 * Performs:
 * 1. CloudFront Invalidation
 * 2. Prune cache bucket of old BUILD_ID prefixed objects
 * 3. Prune DynamoDB revalidation table of old BUILD_ID prefixed entries
 * 4. Prunes objects in static assets S3 that do not have metadata with current BUILD_ID and
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
        cacheBucketName,
        createInvalidationCommandInput,
        msTtl,
        revalidationTableName,
        staticAssetsBucketName,
      } = props;
      const promises: Promise<unknown>[] = [];
      if (createInvalidationCommandInput) {
        promises.push(createInvalidation(createInvalidationCommandInput));
      }
      if (cacheBucketName) {
        promises.push(
          pruneCacheBucket({
            bucketName: cacheBucketName,
            currentBuildId: buildId,
          }),
        );
      }
      if (revalidationTableName) {
        promises.push(
          pruneRevalidationTable({
            tableName: revalidationTableName,
            currentBuildId: buildId,
          }),
        );
      }
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
