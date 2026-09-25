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
  NextjsFunctionGroup,
  NextjsFunctions,
  NextjsFunctionsOverrides,
} from "../nextjs-compute/nextjs-functions";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";

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
  readonly nextjsApi?: NextjsApiOverrides;
  readonly nextjsPostDeploy?: NextjsPostDeployOverrides;
}

export interface NextjsRegionalFunctionsProps extends NextjsBaseProps {
  /**
   * Package sets of routes into separate Lambda functions, each fronted by its
   * own API Gateway resources.
   *
   * Reach for this when a single function exceeds Lambda's 250 MB unzipped
   * limit — cdk-nextjs throws at synth with the measured size when it does. It is
   * not a performance or isolation feature: every group ships the same Next.js
   * runtime, so splitting only moves route-local code.
   *
   * @see NextjsFunctionGroup for the pattern grammar and its limits. API Gateway
   * could express more than CloudFront can, but the grammar is deliberately the
   * same in both so switching deployment type never regroups routes.
   * @default - one function serves every route
   */
  readonly functionGroups?: NextjsFunctionGroup[];
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
  nextjsPostDeploy: NextjsPostDeploy;
  get url(): string {
    return this.nextjsApi.url;
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
    this.nextjsApi = this.createNextjsApi();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsApi() {
    return new NextjsApi(this, "NextjsApi", {
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      staticAssetsKeyPrefix: this.nextjsStaticAssets.keyPrefix,
      serverFunction: this.nextjsFunctions.function,
      basePath: this.resolvedBasePath,
      overrides: this.props.overrides?.nextjsApi,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      // `serverFunction` above is the default group's, which the `{proxy+}`
      // catch-all reaches; the rest get resources of their own.
      functionGroups: this.props.functionGroups?.map((group) => {
        const deployed = this.nextjsFunctions.functionGroups.find(
          (it) => it.name === group.name,
        );
        if (!deployed) {
          throw new Error(
            `Function group "${group.name}" was not deployed as a function.`,
          );
        }
        return {
          name: group.name,
          routes: group.routes,
          function: deployed.function,
        };
      }),
      hasDataRoutes: this.nextjsBuild.hasDataRoutes,
      trailingSlash: this.nextjsBuild.trailingSlash,
      ...this.props.overrides?.nextjsRegionalFunctions?.nextjsApiProps,
    });
  }

  private createNextjsPostDeploy(): NextjsPostDeploy {
    const postDeploy = new NextjsPostDeploy(this, "NextjsPostDeploy", {
      buildId: this.nextjsBuild.buildId,
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      staticAssetsKeyPrefix: this.nextjsStaticAssets.keyPrefix,
      overrides: this.props.overrides?.nextjsPostDeploy,
      ...this.props.overrides?.nextjsRegionalFunctions?.nextjsPostDeployProps,
    });
    this.orderAfterInitCache(postDeploy);
    return postDeploy;
  }
}
