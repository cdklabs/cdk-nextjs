import { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { NextjsType } from "../constants";

export interface NextjsComputeBaseProps {
  readonly healthCheckPath: string;
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
  /**
   * Directory where the Next.js application is located.
   * This should contain the .next directory and other build artifacts.
   * Required for local builds.
   */
  readonly buildDirectory: string;
  readonly nextjsType: NextjsType;
  /**
   * Absolute path to the staged deployment root: the Lambda zip asset for
   * Functions, the Docker `COPY` source for Containers.
   * @see NextjsBuild.deploymentRootPath
   */
  readonly deploymentRootPath: string;
  /**
   * From the deployment root to the Next.js project dir, POSIX, `""` at the repo
   * root.
   * @see NextjsBuild.relativeProjectDir
   */
  readonly relativeProjectDir: string;
  /**
   * S3 bucket holding `.next/static` and `public`. Both deployment styles need
   * it: the runtime's image optimizer fetches the bytes of every non-absolute
   * `<Image>` from S3, since they are deliberately not in the deployment package.
   */
  readonly staticAssetsBucket: IBucket;
  /**
   * Key prefix the assets were uploaded under, so the image optimizer can rebuild
   * the same keys.
   * @see NextjsStaticAssets.keyPrefix
   */
  readonly staticAssetsKeyPrefix?: string;
}
