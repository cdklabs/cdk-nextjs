import { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { IGrantable } from "aws-cdk-lib/aws-iam";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { NextjsType } from "../constants";
import { staticAssetsObjectsPattern } from "../nextjs-static-assets";

export interface NextjsComputeBaseProps {
  /**
   * S3 bucket for cache storage
   */
  readonly cacheBucket: IBucket;
  /**
   * DynamoDB table for revalidation metadata
   */
  readonly revalidationTable: ITableV2;
  /**
   * Build ID for cache key prefixing
   */
  readonly buildId: string;
  readonly nextjsType: NextjsType;
  /**
   * S3 bucket holding `.next/static` and `public`. Both deployment styles need
   * it: the runtime's image optimizer fetches the bytes of every non-absolute
   * `<Image>` from S3, since they are deliberately not in the deployment package,
   * and on every type but `NextjsRegionalContainers` so does a rewrite that
   * lands on a `public/` file.
   * Read access is scoped to `staticAssetsKeyPrefix`.
   */
  readonly staticAssetsBucket: IBucket;
  /**
   * Key prefix the assets were uploaded under, so the image optimizer can rebuild
   * the same keys.
   * @see NextjsStaticAssets.keyPrefix
   */
  readonly staticAssetsKeyPrefix?: string;
}

/**
 * The environment the runtime's cache handler and image optimizer find their
 * resources through, the same for functions and containers.
 */
export function runtimeEnvironment(
  props: NextjsComputeBaseProps,
): Record<string, string> {
  return {
    CDK_NEXTJS_CACHE_BUCKET_NAME: props.cacheBucket.bucketName,
    CDK_NEXTJS_REVALIDATION_TABLE_NAME: props.revalidationTable.tableName,
    CDK_NEXTJS_BUILD_ID: props.buildId,
    // Read by the runtime's image optimizer for non-absolute `<Image>` URLs,
    // whose bytes live in S3 rather than in the deployment package or image.
    CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME: props.staticAssetsBucket.bucketName,
    // Where in that bucket. Not derivable from the app's `basePath`: on the
    // API Gateway types that is the stage name, which is part of the URL but
    // not of the key.
    CDK_NEXTJS_STATIC_ASSETS_KEY_PREFIX: props.staticAssetsKeyPrefix ?? "",
  };
}

/** Grants `grantee` what {@link runtimeEnvironment} points it at. */
export function grantRuntimeAccess(
  props: NextjsComputeBaseProps,
  grantee: IGrantable,
): void {
  props.cacheBucket.grantReadWrite(grantee);
  props.revalidationTable.grantReadWriteData(grantee);
  // Read for image sources and for `public/` files a rewrite lands on, both
  // of which live only in S3; nothing outside the app's own prefix.
  props.staticAssetsBucket.grantRead(
    grantee,
    staticAssetsObjectsPattern(props.staticAssetsKeyPrefix),
  );
}
