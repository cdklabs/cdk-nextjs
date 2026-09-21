import { Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
import { NextjsApi, NextjsApiOverrides, NextjsApiProps } from "../nextjs-api";
import {
  NextjsBaseConstruct,
  NextjsBaseProps,
  NextjsFunctionsConstructOverrides,
  NextjsBaseOverrides,
} from "./nextjs-base-construct";
import { OptionalNextjsPostDeployProps } from "../generated-structs/OptionalNextjsPostDeployProps";
import {
  NextjsFunctions,
  NextjsFunctionsOverrides,
} from "../nextjs-compute/nextjs-functions";
import {
  NextjsImageFunction,
  NextjsImageFunctionOverrides,
} from "../nextjs-compute/nextjs-image-function";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";
import { useDedicatedImageFunction } from "../utils/experimental-flags";

export interface NextjsRegionalFunctionsConstructOverrides extends NextjsFunctionsConstructOverrides {
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
  /**
   * Only created when the (experimental, unsupported) dedicated image
   * optimization Lambda is enabled. `_next/image` is otherwise served by
   * {@link nextjsFunctions}.
   */
  nextjsImageFunction?: NextjsImageFunction;
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

    this.nextjsFunctions = this.createNextjsFunctions(
      this.props.overrides?.nextjsFunctions,
    );
    if (useDedicatedImageFunction()) {
      this.nextjsImageFunction = this.createNextjsImageFunction(
        this.props.overrides?.nextjsImageFunction,
      );
    }
    this.nextjsApi = this.createNextjsApi();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsApi() {
    return new NextjsApi(this, "NextjsApi", {
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      staticAssetsKeyPrefix: this.nextjsStaticAssets.keyPrefix,
      serverFunction: this.nextjsFunctions.function,
      imageFunction: this.nextjsImageFunction?.function,
      basePath: this.resolvedBasePath,
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
