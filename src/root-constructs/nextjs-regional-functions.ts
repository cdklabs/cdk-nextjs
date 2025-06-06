import { Construct } from "constructs";
import { NextjsType } from "../constants";
import {
  NextjsFunctions,
  NextjsFunctionsOverrides,
  NextjsFunctionsProps,
} from "../nextjs-compute/nextjs-functions";
import { NextjsApi, NextjsApiOverrides, NextjsApiProps } from "../nextjs-api";
import { Stack } from "aws-cdk-lib";
import {
  NextjsBaseConstruct,
  NextjsBaseProps,
  BaseNextjsConstructOverrides,
  BaseNextjsOverrides,
} from "./nextjs-base-construct";

export interface NextjsRegionalFunctionsConstructOverrides
  extends BaseNextjsConstructOverrides {
  readonly nextjsFunctionsProps?: NextjsFunctionsProps;
  readonly nextjsApiProps?: NextjsApiProps;
}

/**
 * Overrides for `NextjsRegionalFunctions`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsRegionalFunctionsOverrides extends BaseNextjsOverrides {
  readonly nextjsRegionalFunctions?: NextjsRegionalFunctionsConstructOverrides;
  readonly nextjsFunctions?: NextjsFunctionsOverrides;
  readonly nextjsApi?: NextjsApiOverrides;
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
  nextjsApi: NextjsApi;
  get url() {
    return `https://${this.nextjsApi.api.restApiId}.execute-api.${Stack.of(this).region}.amazonaws.com/${this.nextjsApi.api.deploymentStage.stageName}`;
  }

  private props: NextjsRegionalFunctionsProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsRegionalFunctionsProps,
  ) {
    super(
      scope,
      id,
      props,
      NextjsType.REGIONAL_FUNCTIONS,
      props.overrides,
      props.overrides?.nextjsRegionalFunctions,
    );
    this.props = props;
    this.nextjsFunctions = this.createNextjsFunctions();
    this.nextjsFileSystem.allowCompute({
      connections: this.nextjsFunctions.function.connections,
      role: this.nextjsFunctions.function.role!,
    });
    this.nextjsApi = this.createNextjsApi();
  }

  private createNextjsFunctions() {
    if (!this.nextjsBuild.imageForNextjsFunctions) {
      throw new Error("nextjsBuild.imageForNextjsFunctions is undefined");
    }
    return new NextjsFunctions(this, "NextjsFunctions", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      dockerImageCode: this.nextjsBuild.imageForNextjsFunctions,
      healthCheckPath: this.baseProps.healthCheckPath,
      vpc: this.nextjsVpc.vpc,
      overrides: this.props.overrides?.nextjsFunctions,
      ...this.props.overrides?.nextjsRegionalFunctions?.nextjsFunctionsProps,
    });
  }

  private createNextjsApi() {
    return new NextjsApi(this, "NextjsApi", {
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      serverFunction: this.nextjsFunctions.function,
      basePath: this.baseProps.basePath,
      overrides: this.props.overrides?.nextjsApi,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      ...this.props.overrides?.nextjsRegionalFunctions?.nextjsApiProps,
    });
  }
}
