import { Duration } from "aws-cdk-lib";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Code,
  Function as LambdaFunction,
  FunctionProps,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { NextjsComputeBaseProps } from "./nextjs-compute-base-props";
import { NextjsType } from "../constants";
import { OptionalFunctionProps } from "../generated-structs/OptionalFunctionProps";
import { OptionalFunctionUrlProps } from "../generated-structs/OptionalFunctionUrlProps";
import { RUNTIME_DIR_NAME } from "../runtime/manifest";
import { getLambdaArchitecture } from "../utils/get-architecture";

export interface NextjsFunctionsOverrides {
  readonly functionProps?: OptionalFunctionProps;
  readonly functionUrlProps?: OptionalFunctionUrlProps;
}

export interface NextjsFunctionsProps extends NextjsComputeBaseProps {
  readonly overrides?: NextjsFunctionsOverrides;
}

/**
 * Run Next.js in functions on AWS with AWS Lambda.
 *
 * A plain zip function on the Node.js managed runtime: the deployment root
 * `NextjsBuild` staged is the asset, and cdk-nextjs's own bundled shell
 * (`cdk-nextjs-runtime/lambda.mjs`) is the handler. It invokes the entrypoints
 * `next build` produced in-process, so there is no Next.js HTTP server, no
 * Docker image, and no Lambda Web Adapter — response streaming comes from
 * `awslambda.streamifyResponse` directly.
 */
export class NextjsFunctions extends Construct {
  function: LambdaFunction;
  functionUrl?: FunctionUrl;

  private props: NextjsFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsFunctionsProps) {
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

  private createFunction() {
    const functionProps: FunctionProps = {
      code: Code.fromAsset(this.props.deploymentRootPath),
      handler: `${RUNTIME_DIR_NAME}/lambda.handler`,
      memorySize: 2048,
      runtime: new Runtime("nodejs24.x", RuntimeFamily.NODEJS),
      timeout: Duration.seconds(30),
      ...this.props.overrides?.functionProps,
      // Must not be overridable: `NextjsBuild` stages `sharp` binaries matching
      // the synth machine's architecture, so the deployed function's
      // architecture must always match what was staged.
      architecture: getLambdaArchitecture(),
      environment: {
        // Cache configuration environment variables
        CDK_NEXTJS_CACHE_BUCKET_NAME: this.props.cacheBucket.bucketName,
        CDK_NEXTJS_REVALIDATION_TABLE_NAME:
          this.props.revalidationTable.tableName,
        CDK_NEXTJS_BUILD_ID: this.props.buildId,
        // Read by the runtime's image optimizer for non-absolute `<Image>` URLs,
        // whose bytes live in S3 rather than in the deployment package.
        CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME:
          this.props.staticAssetsBucket.bucketName,
        ...this.props.overrides?.functionProps?.environment,
      },
    };

    const fn = new LambdaFunction(this, "Functions", functionProps);

    // Grant cache access permissions
    this.props.cacheBucket.grantReadWrite(fn);
    this.props.revalidationTable.grantReadWriteData(fn);
    this.props.staticAssetsBucket.grantRead(fn);

    return fn;
  }
}
