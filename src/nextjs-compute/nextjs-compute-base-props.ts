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
   * Build output directory containing .next folder with standalone build
   * Required for local builds
   */
  readonly buildOutputPath: string;
  readonly nextjsType: NextjsType;
  /**
   * Relative path from buildOutputPath to the package containing Next.js app
   */
  readonly relativePathToPackage?: string;
}
