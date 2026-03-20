import { existsSync } from "fs";
import { RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  TableV2,
  TablePropsV2,
} from "aws-cdk-lib/aws-dynamodb";
import {
  Bucket,
  BucketEncryption,
  BucketProps,
  BlockPublicAccess,
  IBucket,
} from "aws-cdk-lib/aws-s3";
import {
  BucketDeployment,
  BucketDeploymentProps,
  Source,
} from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { LOG_PREFIX } from "./constants";

export interface NextjsCacheOverrides {
  readonly cacheBucketProps?: BucketProps;
  readonly revalidationTableProps?: TablePropsV2;
  readonly bucketDeploymentProps?: BucketDeploymentProps;
}

export interface NextjsCacheProps {
  readonly buildId: string;
  /**
   * Absolute path to the init cache directory
   * @example "/Users/john/myapp/.next/cdk-nextjs-init-cache"
   */
  readonly initCacheDir: string;
  readonly overrides?: NextjsCacheOverrides;
}

/**
 * Next.js Cache construct providing unified S3 and DynamoDB cache management.
 */
export class NextjsCache extends Construct {
  readonly cacheBucket: IBucket;
  readonly revalidationTable: TableV2;
  readonly buildId: string;
  readonly bucketDeployment?: BucketDeployment;
  private props: NextjsCacheProps;

  constructor(scope: Construct, id: string, props: NextjsCacheProps) {
    super(scope, id);
    this.props = props;
    this.buildId = props.buildId;
    this.cacheBucket = this.createCacheBucket();
    this.revalidationTable = this.createRevalidationTable();
    this.bucketDeployment = this.createDeployment();
  }

  /**
   * Creates S3 bucket for cache storage with BUILD_ID prefixing.
   */
  private createCacheBucket(): IBucket {
    const bucket = new Bucket(this, "Bucket", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      ...this.props.overrides?.cacheBucketProps,
    });

    return bucket;
  }

  /**
   * Creates DynamoDB table for revalidation metadata
   * Schema: pk (buildId or "METADATA"), sk (tag#cacheKey or "CURRENT_BUILD"), createdAt, revalidatedAt
   */
  private createRevalidationTable(): TableV2 {
    const table = new TableV2(this, "RevalidationTable", {
      partitionKey: {
        name: "pk",
        type: AttributeType.STRING,
      },
      sortKey: {
        name: "sk",
        type: AttributeType.STRING,
      },
      billing: Billing.onDemand(),
      removalPolicy: RemovalPolicy.DESTROY,
      ...this.props.overrides?.revalidationTableProps,
    });

    return table;
  }

  /**
   * Deploy pre-built cache files from .next/cdk-nextjs-init-cache to S3
   */
  private createDeployment(): BucketDeployment | undefined {
    // Check if cache directory exists
    if (!existsSync(this.props.initCacheDir)) {
      console.log(
        `${LOG_PREFIX} No pre-built cache found at ${this.props.initCacheDir}, skipping init cache deployment`,
      );
      return undefined;
    }

    console.log(
      `${LOG_PREFIX} Deploying init cache from ${this.props.initCacheDir}`,
    );

    // Use standard BucketDeployment for regular S3 buckets
    const bucketDeployment = new BucketDeployment(this, "InitCacheDeployment", {
      sources: [Source.asset(this.props.initCacheDir)],
      destinationBucket: this.cacheBucket,
      destinationKeyPrefix: this.props.buildId, // Add buildId prefix to all uploaded files
      prune: false, // Don't delete existing objects to prevent 404s during deployment, pruning will be handled by post-deploy
      ...this.props.overrides?.bucketDeploymentProps,
    });
    return bucketDeployment;
  }
}
