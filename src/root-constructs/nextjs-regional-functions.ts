import { Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
import { NextjsApi, NextjsApiOverrides, NextjsApiProps } from "../nextjs-api";
import {
  NextjsBaseConstruct,
  NextjsBaseProps,
  NextjsBaseConstructOverrides,
  NextjsBaseOverrides,
} from "./nextjs-base-construct";
import { OptionalNextjsPostDeployProps } from "../generated-structs/OptionalNextjsPostDeployProps";
import {
  NextjsFunctions,
  NextjsFunctionsOverrides,
  NextjsFunctionsProps,
} from "../nextjs-compute/nextjs-functions";
import {
  NextjsImageFunction,
  NextjsImageFunctionOverrides,
} from "../nextjs-compute/nextjs-image-function";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";

export interface NextjsRegionalFunctionsConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsFunctionsProps?: NextjsFunctionsProps;
  readonly nextjsApiProps?: NextjsApiProps;
  readonly nextjsPostDeployProps?: OptionalNextjsPostDeployProps;
}

/**
 * Overrides for `NextjsRegionalFunctions`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsRegionalFunctionsOverrides extends NextjsBaseOverrides {
  readonly nextjsRegionalFunctions?: NextjsRegionalFunctionsConstructOverrides;
  readonly nextjsFunctions?: NextjsFunctionsOverrides;
  readonly nextjsImageFunction?: NextjsImageFunctionOverrides;
  readonly nextjsApi?: NextjsApiOverrides;
  readonly nextjsPostDeploy?: NextjsPostDeployOverrides;
}

export interface NextjsRegionalFunctionsProps extends NextjsBaseProps {
  /**
   * Override props of any construct.
   */
  readonly overrides?: NextjsRegionalFunctionsOverrides;
}

/**
 * Deploy Next.js regionally with functions. Uses API Gateway REST API
 * for routing requests and AWS Lambda Functions for server-side rendering.
 */
export class NextjsRegionalFunctions extends NextjsBaseConstruct {
  nextjsFunctions: NextjsFunctions;
  nextjsImageFunction: NextjsImageFunction;
  nextjsApi: NextjsApi;
  nextjsPostDeploy: NextjsPostDeploy;
  get url(): string {
    return `https://${this.nextjsApi.api.restApiId}.execute-api.${Stack.of(this).region}.amazonaws.com/${this.nextjsApi.api.deploymentStage.stageName}`;
  }

  private props: NextjsRegionalFunctionsProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsRegionalFunctionsProps,
  ) {
    super(scope, id, props, NextjsType.REGIONAL_FUNCTIONS);
    this.props = props;

    this.nextjsFunctions = this.createNextjsFunctions();
    this.nextjsImageFunction = this.createNextjsImageFunction();
    this.nextjsApi = this.createNextjsApi();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsFunctions(): NextjsFunctions {
    // Create functions with local build output
    return new NextjsFunctions(this, "NextjsFunctions", {
      ...this.computeBaseProps(),
      overrides: {
        ...this.props.overrides?.nextjsFunctions,
        dockerImageFunctionProps: {
          ...this.props.overrides?.nextjsFunctions?.dockerImageFunctionProps,
          vpc: this.baseProps.vpc,
        },
      },
      ...this.props.overrides?.nextjsRegionalFunctions?.nextjsFunctionsProps,
    });
  }

  private createNextjsImageFunction(): NextjsImageFunction {
    if (!this.nextjsBuild.imageOptimizationAssetPath) {
      throw new Error(
        "Missing NextjsBuild.imageOptimizationAssetPath for NextjsType.REGIONAL_FUNCTIONS",
      );
    }
    return new NextjsImageFunction(this, "NextjsImageFunction", {
      nextjsType: this.nextjsType,
      imageOptimizationAssetPath: this.nextjsBuild.imageOptimizationAssetPath,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      vpc: this.baseProps.vpc,
      overrides: this.props.overrides?.nextjsImageFunction,
    });
  }

  private createNextjsApi() {
    return new NextjsApi(this, "NextjsApi", {
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      serverFunction: this.nextjsFunctions.function,
      imageFunction: this.nextjsImageFunction.function,
      imageFunctionSupportsStreaming: true,
      basePath: this.baseProps.basePath,
      overrides: this.props.overrides?.nextjsApi,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      ...this.props.overrides?.nextjsRegionalFunctions?.nextjsApiProps,
    });
  }

  private createNextjsPostDeploy(): NextjsPostDeploy {
    return new NextjsPostDeploy(this, "NextjsPostDeploy", {
      buildId: this.nextjsBuild.buildId,
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      overrides: this.props.overrides?.nextjsPostDeploy,
      ...this.props.overrides?.nextjsRegionalFunctions?.nextjsPostDeployProps,
    });
  }
}
