import { RemovalPolicy } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  BucketProps,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface NextjsStaticAssetsOverrides {
  readonly bucketProps?: BucketProps;
}

export interface NextjsStaticAssetsProps {
  readonly overrides?: NextjsStaticAssetsOverrides;
  /**
   * Required if `NextjsType.REGIONAL_CONTAINERS`
   */
  readonly vpcId?: string;
}

/**
 * Creates S3 Bucket for public and _next/static assets.
 */
export class NextjsStaticAssets extends Construct {
  bucket: Bucket;

  private props: NextjsStaticAssetsProps;

  constructor(scope: Construct, id: string, props: NextjsStaticAssetsProps) {
    super(scope, id);
    this.props = props;
    this.bucket = this.createBucket();
  }

  private createBucket() {
    return new Bucket(this, "Bucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      ...this.props.overrides?.bucketProps,
    });
  }
}
