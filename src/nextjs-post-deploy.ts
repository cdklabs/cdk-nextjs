import { join } from "node:path";
import { CustomResource, Duration } from "aws-cdk-lib";
import { IDistribution } from "aws-cdk-lib/aws-cloudfront";
import { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { OptionalCustomResourceProps } from "./generated-structs/OptionalCustomResourceProps";
import { OptionalFunctionProps } from "./generated-structs/OptionalFunctionProps";
import { OptionalPostDeployCustomResourceProperties } from "./generated-structs/OptionalPostDeployCustomResourceProperties";
import { staticAssetsObjectsPattern } from "./nextjs-static-assets";
import { wholeAppInvalidationPaths } from "./utils/base-path";

export interface NextjsPostDeployOverrides {
  readonly functionProps?: OptionalFunctionProps;
  /**
   * Props that define the custom resource
   */
  readonly customResourceProps?: OptionalCustomResourceProps;
  /**
   * Properties passed into custom resource that are passed to Lambda event handler.
   */
  readonly customResourceProperties?: OptionalPostDeployCustomResourceProperties;
}

export interface NextjsPostDeployProps {
  /**
   * The app's `basePath`. Scopes the deploy's CloudFront invalidation to the
   * app's URIs, so a deploy doesn't flush other apps on the same distribution.
   * @default - the whole distribution (`/*`)
   */
  readonly basePath?: string;
  readonly buildId: string;
  /**
   * Cache bucket for cleaning up old BUILD_ID prefixed objects
   */
  readonly cacheBucket?: IBucket;
  /**
   * DynamoDB table for cleaning up old BUILD_ID prefixed revalidation entries
   */
  readonly revalidationTable?: ITableV2;
  /**
   * If true, logs details in custom resource lambda
   * @default true
   */
  readonly debug?: boolean;
  /**
   * CloudFront Distribution to invalidate
   */
  readonly distribution?: IDistribution;
  /**
   * Override props for every construct.
   */
  readonly overrides?: NextjsPostDeployOverrides;
  /**
   * Required for `NextjsType.GlobalFunctions` and `NextjsType.GlobalContainers`
   */
  readonly staticAssetsBucket?: IBucket;
  /**
   * S3 key prefix the static assets were uploaded under
   * (`NextjsStaticAssets.keyPrefix`). Scopes pruning to this app's objects, so
   * that apps or branches sharing one bucket under different `basePath`s don't
   * prune each other's assets.
   */
  readonly staticAssetsKeyPrefix?: string;
}

export interface PostDeployCustomResourceProperties {
  /**
   * Build ID of current deployment. Used to prune cache bucket of objects
   * with old build ids, prune DynamoDB revalidation entries with old build ids,
   * and prune S3 static assets based on metadata and `msTtl`
   */
  readonly buildId: string;
  /**
   * Cache bucket name for cleaning up old BUILD_ID prefixed objects
   */
  readonly cacheBucketName?: string;
  /**
   * DynamoDB revalidation table name for cleaning up old BUILD_ID prefixed entries
   */
  readonly revalidationTableName?: string;
  /**
   * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudfront/command/CreateInvalidationCommand/
   * @default
   * {
        distributionId: this.props.distribution?.distributionId,
        invalidationBatch: {
          callerReference: new Date().toISOString(),
          paths: {
            quantity: paths.length,
            items: paths, // wholeAppInvalidationPaths(basePath)
          },
        },
      }
   */
  readonly createInvalidationCommandInput?: Record<string, any>;
  /**
   * Time to live in milliseconds
   *
   * Must be string because of CloudFormation Custom Resource limitation
   * @default (1000 * 60 * 60 * 24 * 30).toString()
   */
  readonly msTtl: string;
  readonly staticAssetsBucketName?: string;
  /**
   * S3 key prefix to scope static asset pruning to. Only `<prefix>/_next/` is
   * pruned, where every build-hashed asset lives, so `public/` files and other
   * apps' prefixes are never touched. Empty or absent prunes `_next/` at the
   * bucket root.
   */
  readonly staticAssetsKeyPrefix?: string;
}

/**
 * Performs post deployment tasks in custom resource.
 *
 * 1. CloudFront Invalidation of every URI of the app (`/*` without a `basePath`)
 * 2. Prune cache bucket by removing objects with old BUILD_ID prefixes
 * 3. Prune DynamoDB revalidation table by removing entries with old BUILD_ID prefixes
 * 4. Prune static assets S3 by removing objects that don't have next-build-id metadata of
 * current build id AND are older than `msTtl`
 */
export class NextjsPostDeploy extends Construct {
  customResource: CustomResource;
  lambdaFunction: LambdaFunction;

  private props: NextjsPostDeployProps;

  constructor(scope: Construct, id: string, props: NextjsPostDeployProps) {
    super(scope, id);
    this.props = props;
    this.lambdaFunction = this.createFunction();
    this.customResource = this.createCustomResource();
  }

  private createFunction() {
    const fn = new LambdaFunction(this, "Fn", {
      // Plain bundled JS with no native dependencies, so nothing ties it to the
      // synth machine: always arm64, the cheaper of the two.
      architecture: Architecture.ARM_64,
      code: Code.fromAsset(
        join(__dirname, "../assets/lambdas/post-deploy/post-deploy.lambda"),
      ),
      handler: "index.handler",
      memorySize: 2048,
      runtime: new Runtime("nodejs24.x", RuntimeFamily.NODEJS),
      timeout: Duration.minutes(5),
      ...this.props.overrides?.functionProps,
    });
    this.props.distribution?.grantCreateInvalidation(fn);
    if (this.props.debug !== false) {
      fn.addEnvironment("DEBUG", "1");
    }
    // Only this app's prefix: pruning stays inside it, and a shared bucket's
    // other apps are out of reach.
    this.props.staticAssetsBucket?.grantReadWrite(
      fn,
      staticAssetsObjectsPattern(this.props.staticAssetsKeyPrefix),
    );
    this.props.cacheBucket?.grantReadWrite(fn);
    this.props.revalidationTable?.grantReadWriteData(fn);
    return fn;
  }

  private createCustomResource() {
    const paths = wholeAppInvalidationPaths(this.props.basePath);
    const properties: PostDeployCustomResourceProperties = {
      // ensures this CR runs each time new build
      buildId: this.props.buildId,
      cacheBucketName: this.props.cacheBucket?.bucketName,
      revalidationTableName: this.props.revalidationTable?.tableName,
      msTtl: (1000 * 60 * 60 * 24 * 30).toString(), // 1 month
      staticAssetsBucketName: this.props.staticAssetsBucket?.bucketName,
      staticAssetsKeyPrefix: this.props.staticAssetsKeyPrefix || undefined,
      createInvalidationCommandInput: this.props.distribution
        ? {
            distributionId: this.props.distribution.distributionId,
            invalidationBatch: {
              callerReference: new Date().toISOString(),
              paths: { quantity: paths.length, items: paths },
            },
          }
        : undefined,
      ...this.props.overrides?.customResourceProperties,
    };
    return new CustomResource(this, "CustomResource", {
      properties,
      resourceType: "Custom::NextjsPostDeploy",
      serviceToken: this.lambdaFunction.functionArn,
      ...this.props.overrides?.customResourceProps,
    });
  }
}
