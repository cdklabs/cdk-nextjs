import { copyFileSync, existsSync } from "node:fs";
import { join as joinPath } from "node:path";
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
import { LOG_PREFIX, NextjsType } from "../constants";
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
        AWS_LWA_INVOKE_MODE: "response_stream",
        AWS_LWA_READINESS_CHECK_PATH: this.props.healthCheckPath,
        AWS_LWA_READINESS_CHECK_PORT: "3000",
        READINESS_CHECK_PATH: `http://127.0.0.1:3000${this.props.healthCheckPath}`,
        // Cache configuration environment variables
        CDK_NEXTJS_CACHE_BUCKET_NAME: this.props.cacheBucket.bucketName,
        CDK_NEXTJS_REVALIDATION_TABLE_NAME:
          this.props.revalidationTable.tableName,
        CDK_NEXTJS_BUILD_ID: this.props.buildId,
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

    // Build context is the buildDirectory (where the Next.js app is located)
    const buildContext = this.props.buildOutputPath;
    const dockerfileName = this.getDockerfileName();

    // Copy Dockerfile to build context to avoid path resolution issues
    this.copyDockerfileToContext(buildContext, dockerfileName);

    const relativeEntrypointPath = this.props.relativePathToPackage
      ? `${this.props.relativePathToPackage}/server.js`
      : "server.js";

    return DockerImageCode.fromImageAsset(buildContext, {
      file: dockerfileName, // Now it's just the filename in the build context
      cmd: ["node", relativeEntrypointPath],
      buildArgs: {
        BUILD_ID: this.props.buildId,
      },
    });
  }

  private getDockerfileName(): string {
    // Use the appropriate Dockerfile based on deployment type
    return this.props.nextjsType === NextjsType.GLOBAL_FUNCTIONS
      ? "global-functions.Dockerfile"
      : "regional-functions.Dockerfile";
  }

  private copyDockerfileToContext(
    buildContext: string,
    dockerfileName: string,
  ): void {
    const targetDockerfile = joinPath(buildContext, dockerfileName);

    // Check if Dockerfile already exists - if so, use the existing one (developer control)
    if (existsSync(targetDockerfile)) {
      console.log(`${LOG_PREFIX} Using existing Dockerfile: ${dockerfileName}`);
    } else {
      const sourceDockerfile = joinPath(
        __dirname,
        "..",
        "nextjs-build",
        dockerfileName,
      );

      if (!existsSync(sourceDockerfile)) {
        throw new Error(
          `Source Dockerfile not found: ${sourceDockerfile}. Ensure the cdk-nextjs package is properly built.`,
        );
      }

      copyFileSync(sourceDockerfile, targetDockerfile);
      console.log(
        `${LOG_PREFIX} Created ${dockerfileName} in your project directory. You can customize this file for your deployment needs.`,
      );
    }
  }
}
