import { TableV2 } from "aws-cdk-lib/aws-dynamodb";
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
  readonly revalidationTable: TableV2;
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
   * Relative path from buildDirectory to the package containing Next.js app
   */
  readonly relativePathToPackage?: string;
}
