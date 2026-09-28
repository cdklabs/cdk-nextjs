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
   * S3 bucket holding `.next/static` and `public`. On every type but
   * `NextjsRegionalContainers` the runtime reads it: its image optimizer fetches
   * the bytes of every non-absolute `<Image>` from S3, since they are
   * deliberately not in the deployment package, and so does a rewrite that
   * lands on a `public/` file. `NextjsRegionalContainers` carries both in its
   * image, so it gets neither the bucket's environment nor read access to it.
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
  const env: Record<string, string> = {
    CDK_NEXTJS_CACHE_BUCKET_NAME: props.cacheBucket.bucketName,
    CDK_NEXTJS_REVALIDATION_TABLE_NAME: props.revalidationTable.tableName,
    CDK_NEXTJS_BUILD_ID: props.buildId,
  };
  if (readsStaticAssets(props)) {
    // Read by the runtime's image optimizer for non-absolute `<Image>` URLs,
    // whose bytes live in S3 rather than in the deployment package.
    env.CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME =
      props.staticAssetsBucket.bucketName;
    // Where in that bucket. Not derivable from the app's `basePath`: on the
    // API Gateway types that is the stage name, which is part of the URL but
    // not of the key.
    env.CDK_NEXTJS_STATIC_ASSETS_KEY_PREFIX = props.staticAssetsKeyPrefix ?? "";
  }
  return env;
}

/** Grants `grantee` what {@link runtimeEnvironment} points it at. */
export function grantRuntimeAccess(
  props: NextjsComputeBaseProps,
  grantee: IGrantable,
): void {
  props.cacheBucket.grantReadWrite(grantee);
  props.revalidationTable.grantReadWriteData(grantee);
  if (readsStaticAssets(props)) {
    // Read for image sources and for `public/` files a rewrite lands on, both
    // of which live only in S3; nothing outside the app's own prefix.
    props.staticAssetsBucket.grantRead(
      grantee,
      staticAssetsObjectsPattern(props.staticAssetsKeyPrefix),
    );
  }
}

/** Every type but `NextjsRegionalContainers`, whose image carries the assets. */
function readsStaticAssets(props: NextjsComputeBaseProps): boolean {
  return props.nextjsType !== NextjsType.REGIONAL_CONTAINERS;
}
