import { Duration } from "aws-cdk-lib";
import {
  Architecture,
  DockerImageCode,
  DockerImageFunction,
  FileSystem,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { NextjsComputeBaseProps } from "./nextjs-compute-base-props";
import { OptionalDockerImageFunctionProps } from "../generated-structs/OptionalDockerImageFunctionProps";
import { OptionalFunctionUrlProps } from "../generated-structs/OptionalFunctionUrlProps";

export interface NextjsFunctionsOverrides {
  readonly dockerImageFunctionProps?: OptionalDockerImageFunctionProps;
  readonly functionUrlProps?: OptionalFunctionUrlProps;
}

export interface NextjsFunctionsProps extends NextjsComputeBaseProps {
  readonly dockerImageCode: DockerImageCode;
  readonly overrides?: NextjsFunctionsOverrides;
}

/**
 * Run Next.js in functions on AWS with AWS Lambda.
 */
export class NextjsFunctions extends Construct {
  function: DockerImageFunction;
  functionUrl: FunctionUrl;

  private props: NextjsFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsFunctionsProps) {
    super(scope, id);
    this.props = props;
    this.function = this.createFunction();
    this.functionUrl = this.function.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
      invokeMode: InvokeMode.RESPONSE_STREAM,
      ...this.props.overrides?.functionUrlProps,
    });
    if (!this.function.role) {
      throw new Error("Function role is undefined");
    }
  }

  private createFunction() {
    let architecture: Architecture | undefined = undefined;
    if (process.arch === "x64") {
      architecture = Architecture.X86_64;
    } else if (process.arch === "arm64") {
      architecture = Architecture.ARM_64;
    }
    const fn = new DockerImageFunction(this, "Functions", {
      architecture,
      code: this.props.dockerImageCode,
      filesystem: FileSystem.fromEfsAccessPoint(
        this.props.accessPoint,
        this.props.containerMountPathForEfs,
      ),
      memorySize: 2048,
      timeout: Duration.seconds(30),
      vpc: this.props.vpc,
      ...this.props.overrides?.dockerImageFunctionProps,
      environment: {
        AWS_LWA_ENABLE_COMPRESSION: "true",
        AWS_LWA_INVOKE_MODE: "response_stream",
        AWS_LWA_READINESS_CHECK_PATH: this.props.healthCheckPath,
        AWS_LWA_READINESS_CHECK_PORT: "3000",
        READINESS_CHECK_PATH: `http://127.0.0.1:3000${this.props.healthCheckPath}`,
        ...this.props.overrides?.dockerImageFunctionProps?.environment,
      },
    });
    return fn;
  }
}
