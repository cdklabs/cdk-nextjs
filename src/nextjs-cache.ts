import { RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  TableV2,
  TablePropsV2,
} from "aws-cdk-lib/aws-dynamodb";
import { IRole } from "aws-cdk-lib/aws-iam";
import {
  Bucket,
  BucketEncryption,
  BucketProps,
  BlockPublicAccess,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface NextjsCacheOverrides {
  readonly cacheBucketProps?: BucketProps;
  readonly revalidationTableProps?: TablePropsV2;
}

export interface NextjsCacheProps {
  readonly buildId: string;
  readonly overrides?: NextjsCacheOverrides;
}

export interface ICacheOperationsInterface {
  readonly cacheBucket: Bucket;
  readonly revalidationTable: TableV2;
  readonly buildId: string;

  /**
   * Grant read/write permissions to a role for cache operations
   */
  grantCacheAccess(role: IRole): void;
}

/**
 * Next.js Cache construct providing unified S3 and DynamoDB cache management.
 * Replaces EFS-based caching with cloud-native S3/DynamoDB solution.
 */
export class NextjsCache
  extends Construct
  implements ICacheOperationsInterface
{
  readonly cacheBucket: Bucket;
  readonly revalidationTable: TableV2;
  readonly buildId: string;
  private props: NextjsCacheProps;

  constructor(scope: Construct, id: string, props: NextjsCacheProps) {
    super(scope, id);
    this.props = props;
    this.buildId = props.buildId;
    this.cacheBucket = this.createCacheBucket();
    this.revalidationTable = this.createRevalidationTable();
  }

  /**
   * Creates S3 bucket for cache storage with BUILD_ID prefixing
   */
  private createCacheBucket(): Bucket {
    const bucket = new Bucket(this, "CacheBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
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
   * Grant read/write permissions to a role for cache operations
   */
  grantCacheAccess(role: IRole): void {
    // Grant S3 bucket read/write access
    this.cacheBucket.grantReadWrite(role);

    // Grant DynamoDB table read/write access
    this.revalidationTable.grantReadWriteData(role);
  }
}
