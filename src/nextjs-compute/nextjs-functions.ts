import { join } from "path/posix";
import { Duration } from "aws-cdk-lib";
import {
  DockerImageCode,
  DockerImageFunction,
  DockerImageFunctionProps,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { NextjsComputeBaseProps } from "./nextjs-compute-base-props";
import {
  CACHE_PATH,
  DATA_CACHE_PATH,
  IMAGE_CACHE_PATH,
  NextjsType,
  PUBLIC_PATH,
} from "../constants";
import { OptionalDockerImageFunctionProps } from "../generated-structs/OptionalDockerImageFunctionProps";
import { OptionalFunctionUrlProps } from "../generated-structs/OptionalFunctionUrlProps";
import { getLambdaArchitecture } from "../utils/get-architecture";

export interface NextjsFunctionsOverrides {
  readonly dockerImageFunctionProps?: OptionalDockerImageFunctionProps;
  readonly functionUrlProps?: OptionalFunctionUrlProps;
}

export interface NextjsFunctionsProps extends NextjsComputeBaseProps {
  readonly overrides?: NextjsFunctionsOverrides;
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
    // Create DockerImageCode from local build output or use provided dockerImageCode
    const dockerImageCode = this.createDockerImageCode();

    const functionProps: DockerImageFunctionProps = {
      architecture: getLambdaArchitecture(),
      code: dockerImageCode,
      memorySize: 2048,
      timeout: Duration.seconds(30),
      ...this.props.overrides?.dockerImageFunctionProps,
      environment: {
        AWS_LWA_ENABLE_COMPRESSION: "true",
        AWS_LWA_INVOKE_MODE:
          this.props.nextjsType === NextjsType.GLOBAL_FUNCTIONS
            ? "response_stream"
            : "buffered", // API GW doesn't support response streaming yet so must buffer
        AWS_LWA_READINESS_CHECK_PATH: this.props.healthCheckPath,
        AWS_LWA_READINESS_CHECK_PORT: "3000",
        READINESS_CHECK_PATH: `http://127.0.0.1:3000${this.props.healthCheckPath}`,
        // Cache configuration environment variables
        CACHE_BUCKET_NAME: this.props.cacheBucket.bucketName,
        REVALIDATION_TABLE_NAME: this.props.revalidationTable.tableName,
        BUILD_ID: this.props.buildId,
        ...this.props.overrides?.dockerImageFunctionProps?.environment,
      },
    };

    const fn = new DockerImageFunction(this, "Functions", functionProps);

    // Grant cache access permissions
    this.props.cacheBucket.grantReadWrite(fn);
    this.props.revalidationTable.grantReadWriteData(fn);

    return fn;
  }

  private createDockerImageCode(): DockerImageCode {
    if (!this.props.buildOutputPath) {
      throw new Error("buildOutputPath is required for local builds");
    }

    const dockerfilePath = this.getDockerfilePath();
    const buildContext = this.getBuildContext();

    return DockerImageCode.fromImageAsset(buildContext, {
      file: dockerfilePath,
      buildArgs: {
        RELATIVE_PATH_TO_PACKAGE: this.props.relativePathToPackage || ".",
        BUILD_ID: this.props.buildId,
        CACHE_PATH,
        DATA_CACHE_PATH,
        IMAGE_CACHE_PATH,
        PUBLIC_PATH,
      },
    });
  }

  private getDockerfilePath(): string {
    // Use the appropriate Dockerfile based on deployment type
    const dockerfileName =
      this.props.nextjsType === NextjsType.GLOBAL_FUNCTIONS
        ? "global-functions.Dockerfile"
        : "regional-functions.Dockerfile";

    // Dockerfiles are located in lib/nextjs-build after build process
    // Path is relative to build context
    return `../lib/nextjs-build/${dockerfileName}`;
  }

  private getBuildContext(): string {
    if (!this.props.buildOutputPath) {
      throw new Error("buildOutputPath is required for local builds");
    }

    // Build context is the directory containing the .next folder
    // This allows the Dockerfile to access both .next output and lib/nextjs-build
    const packagePath = this.props.relativePathToPackage || ".";
    return join(this.props.buildOutputPath, packagePath);
  }
}
