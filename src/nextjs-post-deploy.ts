import { join } from "node:path";
import { CustomResource, Duration } from "aws-cdk-lib";
import { IDistribution } from "aws-cdk-lib/aws-cloudfront";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { AccessPoint } from "aws-cdk-lib/aws-efs";
import {
  Code,
  FileSystem,
  Function as LambdaFunction,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { MOUNT_PATH } from "./constants";
import { OptionalCustomResourceProps } from "./generated-structs/OptionalCustomResourceProps";
import { OptionalFunctionProps } from "./generated-structs/OptionalFunctionProps";
import { OptionalPostDeployCustomResourceProperties } from "./generated-structs/OptionalPostDeployCustomResourceProperties";
import { getLambdaArchitecture } from "./utils/get-architecture";

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
  readonly accessPoint: AccessPoint;
  readonly buildId: string;
  /**
   * @see {@link NextjsBuild.buildImageDigest}
   */
  readonly buildImageDigest: string;
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
   * @see {@link NextjsBaseProps.relativePathToPackage}
   */
  readonly relativePathToPackage?: string;
  /**
   * Required for `NextjsType.GlobalFunctions` and `NextjsType.GlobalContainers`
   */
  readonly staticAssetsBucket?: Bucket;
  readonly vpc: IVpc;
}

export interface PostDeployCustomResourceProperties {
  /**
   * Build ID of current deployment. Used to prune FileSystem of directories
   * with old build ids and prune S3 based on metadat and `msTtl`
   */
  readonly buildId: string;
  /**
   * @see {@link NextjsBuild.buildImageDigest}
   */
  readonly buildImageDigest: string;
  /**
   * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudfront/command/CreateInvalidationCommand/
   * @default
   * {
        distributionId: this.props.distribution?.distributionId,
        invalidationBatch: {
          callerReference: new Date().toISOString(),
          paths: {
            quantity: 1,
            items: ["/*"], // invalidate all paths
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
}

/**
 * Performs post deployment tasks in custom resource.
 *
 * 1. CloudFront Invalidation (defaults to /*)
 * 2. Prunes FileSystem by removing directories that don't match this deployments BUILD_ID
 * 3. Prune S3 by removing objects that don't have next-build-id metadata of
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
      architecture: getLambdaArchitecture(),
      code: Code.fromAsset(
        join(__dirname, "../assets/lambdas/post-deploy/post-deploy.lambda"),
      ),
      filesystem: FileSystem.fromEfsAccessPoint(
        this.props.accessPoint,
        MOUNT_PATH,
      ),
      handler: "index.handler",
      memorySize: 2048,
      runtime: new Runtime("nodejs22.x", RuntimeFamily.NODEJS),
      timeout: Duration.minutes(5),
      vpc: this.props.vpc,
      ...this.props.overrides?.functionProps,
    });
    this.props.distribution?.grantCreateInvalidation(fn);
    if (this.props.debug !== false) {
      fn.addEnvironment("DEBUG", "1");
    }
    this.props.staticAssetsBucket?.grantReadWrite(fn);
    return fn;
  }

  private createCustomResource() {
    const properties: PostDeployCustomResourceProperties = {
      // ensures this CR runs each time new builder image
      buildId: this.props.buildId,
      buildImageDigest: this.props.buildImageDigest,
      msTtl: (1000 * 60 * 60 * 24 * 30).toString(), // 1 month
      staticAssetsBucketName: this.props.staticAssetsBucket?.bucketName,
      createInvalidationCommandInput: this.props.distribution
        ? {
            distributionId: this.props.distribution.distributionId,
            invalidationBatch: {
              callerReference: new Date().toISOString(),
              paths: {
                quantity: 1,
                items: ["/*"],
              },
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
