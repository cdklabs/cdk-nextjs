import { join } from "path/posix";
import { Duration } from "aws-cdk-lib";
import {
  DockerImageCode,
  DockerImageFunction,
  FileSystem,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { NextjsComputeBaseProps } from "./nextjs-compute-base-props";
import {
  CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME,
  MOUNT_PATH,
  NextjsType,
  SERVER_DIST_PATH,
} from "../constants";
import { OptionalDockerImageFunctionProps } from "../generated-structs/OptionalDockerImageFunctionProps";
import { OptionalFunctionUrlProps } from "../generated-structs/OptionalFunctionUrlProps";
import { getLambdaArchitecture } from "../utils/get-architecture";

export interface NextjsFunctionsOverrides {
  readonly dockerImageFunctionProps?: OptionalDockerImageFunctionProps;
  readonly functionUrlProps?: OptionalFunctionUrlProps;
}

export interface NextjsFunctionsProps extends NextjsComputeBaseProps {
  readonly dockerImageCode: DockerImageCode;
  readonly overrides?: NextjsFunctionsOverrides;
  readonly buildId: string;
  readonly nextjsType: NextjsType;
}

/**
 * Run Next.js in functions on AWS with AWS Lambda.
 */
export class NextjsFunctions extends Construct {
  function: DockerImageFunction;
  functionUrl?: FunctionUrl;

  private props: NextjsFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsFunctionsProps) {
    super(scope, id);
    this.props = props;
    this.function = this.createFunction();
    if (props.nextjsType === NextjsType.GLOBAL_FUNCTIONS) {
      this.functionUrl = this.function.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
        ...this.props.overrides?.functionUrlProps,
      });
    }
  }

  private createFunction() {
    const fn = new DockerImageFunction(this, "Functions", {
      architecture: getLambdaArchitecture(),
      code: this.props.dockerImageCode,
      filesystem: FileSystem.fromEfsAccessPoint(
        this.props.accessPoint,
        MOUNT_PATH,
      ),
      memorySize: 2048,
      timeout: Duration.seconds(30),
      vpc: this.props.vpc,
      ...this.props.overrides?.dockerImageFunctionProps,
      environment: {
        AWS_LWA_ENABLE_COMPRESSION: "true",
        AWS_LWA_INVOKE_MODE: "buffered", // does this need to be "buffered"
        AWS_LWA_READINESS_CHECK_PATH: this.props.healthCheckPath,
        AWS_LWA_READINESS_CHECK_PORT: "3000",
        READINESS_CHECK_PATH: `http://127.0.0.1:3000${this.props.healthCheckPath}`,
        [CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME]: join(
          MOUNT_PATH,
          this.props.buildId,
          SERVER_DIST_PATH,
        ),
        ...this.props.overrides?.dockerImageFunctionProps?.environment,
      },
    });
    return fn;
  }
}
