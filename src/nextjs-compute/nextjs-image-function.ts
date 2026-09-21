import { Duration } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Code,
  Function as LambdaFunction,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
import { OptionalFunctionProps } from "../generated-structs/OptionalFunctionProps";
import { OptionalFunctionUrlProps } from "../generated-structs/OptionalFunctionUrlProps";
import { getLambdaArchitecture } from "../utils/get-architecture";

export interface NextjsImageFunctionOverrides {
  readonly functionProps?: OptionalFunctionProps;
  readonly functionUrlProps?: OptionalFunctionUrlProps;
}

export interface NextjsImageFunctionProps {
  readonly nextjsType: NextjsType;
  /**
   * Absolute path to the asset prepared by `NextjsBuild`: bundled handler,
   * glibc `sharp` binaries, and `required-server-files.json`.
   * @see {@link NextjsBuild.imageOptimizationAssetPath}
   */
  readonly imageOptimizationAssetPath: string;
  /**
   * S3 bucket containing static assets, read by the handler to serve
   * non-absolute image URLs.
   */
  readonly staticAssetsBucket: IBucket;
  /**
   * The `basePath` prop passed to `NextjsStaticAssets`, used to namespace a
   * shared bucket. Unrelated to the Next.js app's own `basePath` config
   * (baked into hrefs by next-image-loader): nothing requires the two to
   * match, so this must be threaded through explicitly rather than read from
   * the app's bundled config.
   */
  readonly staticAssetsBasePath?: string;
  readonly vpc?: IVpc;
  /**
   * Override props of any construct.
   */
  readonly overrides?: NextjsImageFunctionOverrides;
}

/**
 * Dedicated Lambda function for Next.js image optimization
 * (`src/image-optimization/handler.mts`). Kept separate from the server
 * function so image requests get a lightweight, natively-streaming zip
 * Lambda instead of paying the Docker/Lambda Web Adapter cold-start cost.
 */
export class NextjsImageFunction extends Construct {
  function: LambdaFunction;
  functionUrl?: FunctionUrl;

  private props: NextjsImageFunctionProps;

  constructor(scope: Construct, id: string, props: NextjsImageFunctionProps) {
    super(scope, id);
    this.props = props;
    this.function = this.createFunction();

    if (props.nextjsType === NextjsType.GLOBAL_FUNCTIONS) {
      this.function.grantInvoke(
        new ServicePrincipal("cloudfront.amazonaws.com"),
      );
      this.functionUrl = this.function.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
        ...this.props.overrides?.functionUrlProps,
      });
    }
  }

  private createFunction(): LambdaFunction {
    const fn = new LambdaFunction(this, "Fn", {
      code: Code.fromAsset(this.props.imageOptimizationAssetPath),
      handler: "handler.handler",
      memorySize: 2048,
      runtime: new Runtime("nodejs24.x", RuntimeFamily.NODEJS),
      timeout: Duration.seconds(30),
      vpc: this.props.vpc,
      ...this.props.overrides?.functionProps,
      // Must not be overridable: NextjsBuild bundles glibc `sharp` binaries
      // matching the synth machine's architecture, so the deployed Lambda's
      // architecture must always match what was bundled.
      architecture: getLambdaArchitecture(),
      environment: {
        CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME:
          this.props.staticAssetsBucket.bucketName,
        CDK_NEXTJS_STATIC_ASSETS_BASE_PATH:
          this.props.staticAssetsBasePath ?? "",
        ...this.props.overrides?.functionProps?.environment,
      },
    });

    this.props.staticAssetsBucket.grantRead(fn);

    return fn;
  }
}
