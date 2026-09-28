import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
import {
  deployedFunctionGroups,
  NextjsFunctionsConstructOverrides,
  NextjsBaseOverrides,
  NextjsBaseConstruct,
  NextjsBaseProps,
} from "./nextjs-base-construct";
import { OptionalNextjsDistributionProps } from "../generated-structs/OptionalNextjsDistributionProps";
import { OptionalNextjsPostDeployProps } from "../generated-structs/OptionalNextjsPostDeployProps";
import {
  NextjsFunctionGroup,
  NextjsFunctions,
  NextjsFunctionsOverrides,
} from "../nextjs-compute/nextjs-functions";
import {
  NextjsDistribution,
  NextjsDistributionOverrides,
} from "../nextjs-distribution";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";
import { joinPath } from "../utils/base-path";

export interface NextjsGlobalFunctionsConstructOverrides extends NextjsFunctionsConstructOverrides {
  readonly nextjsDistributionProps?: OptionalNextjsDistributionProps;
  readonly nextjsPostDeployProps?: OptionalNextjsPostDeployProps;
}

/**
 * Overrides for `NextjsGlobalFunctions`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsGlobalFunctionsOverrides extends NextjsBaseOverrides {
  readonly nextjsGlobalFunctions?: NextjsGlobalFunctionsConstructOverrides;
  readonly nextjsFunctions?: NextjsFunctionsOverrides;
  readonly nextjsDistribution?: NextjsDistributionOverrides;
  readonly nextjsPostDeploy?: NextjsPostDeployOverrides;
}

export interface NextjsGlobalFunctionsProps extends NextjsBaseProps {
  /**
   * Bring your own distribution. Can be used with `basePath` to host multiple
   * apps on the same CloudFront distribution.
   */
  readonly distribution?: Distribution;
  /**
   * Package sets of routes into separate Lambda functions, each fronted by its
   * own CloudFront behaviors.
   *
   * Reach for this when a single function exceeds Lambda's 250 MB unzipped
   * limit — cdk-nextjs throws at synth with the measured size when it does. It is
   * not a performance or isolation feature: every group ships the same Next.js
   * runtime, so splitting only moves route-local code.
   *
   * @see NextjsFunctionGroup for the pattern grammar and its limits.
   * @default - one function serves every route
   */
  readonly functionGroups?: NextjsFunctionGroup[];
  /**
   * Override props of any construct.
   */
  readonly overrides?: NextjsGlobalFunctionsOverrides;
}

/**
 * Deploy Next.js globally distributed with functions. Uses [CloudFront
 * Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html)
 * as Content Delivery Network (CDN) for global distribution and [AWS Lambda Functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)
 * for functions.
 */
export class NextjsGlobalFunctions extends NextjsBaseConstruct {
  nextjsFunctions: NextjsFunctions;
  nextjsDistribution: NextjsDistribution;
  nextjsPostDeploy: NextjsPostDeploy;
  /**
   * Public URL of the app, including `basePath` — the app only answers under
   * that prefix, and it's derived from the app's own `basePath` when the prop is
   * left unset, so it's there whether or not you asked for it.
   */
  get url(): string {
    return joinPath(
      `https://${this.nextjsDistribution.distribution.domainName}`,
      this.resolvedBasePath,
    );
  }

  private props: NextjsGlobalFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsGlobalFunctionsProps) {
    super(scope, id, props, NextjsType.GLOBAL_FUNCTIONS);
    this.props = props;

    this.nextjsFunctions = this.createNextjsFunctions(
      this.props.overrides?.nextjsFunctions,
    );
    this.nextjsDistribution = this.createNextjsDistribution();
    // Every group, not just the default one: `revalidateTag`/`revalidatePath` can
    // be called from any route handler, so any function may need to invalidate.
    const functions = this.nextjsFunctions.functionGroups.map(
      (group) => group.function,
    );
    const environment = this.wireCloudFrontInvalidation(
      // A `new Function` always has a role; only imported ones lack it.
      functions.map((fn) => fn.role!),
      this.nextjsDistribution.distribution,
      true,
    );
    for (const [name, value] of Object.entries(environment)) {
      functions.forEach((fn) => fn.addEnvironment(name, value));
    }
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      assetPrefix: this.nextjsBuild.nextConfigAssetPrefixPath,
      basePath: this.resolvedBasePath,
      distribution: this.props.distribution,
      functionUrl: this.nextjsFunctions.functionUrl,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      // The default group backs the default behavior, so only the rest need
      // behaviors of their own.
      functionGroups: deployedFunctionGroups(
        this.props.functionGroups,
        this.nextjsFunctions,
        this.nextjsBuild,
      )?.map((group) => ({ ...group, functionUrl: group.functionUrl! })),
      nextBuildId: this.nextjsBuild.nextBuildId,
      trailingSlash: this.nextjsBuild.trailingSlash,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsDistributionProps,
    });
  }

  private createNextjsPostDeploy(): NextjsPostDeploy {
    const postDeploy = new NextjsPostDeploy(this, "NextjsPostDeploy", {
      buildId: this.nextjsBuild.buildId,
      distribution: this.nextjsDistribution.distribution,
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      staticAssetsKeyPrefix: this.nextjsStaticAssets.keyPrefix,
      overrides: this.props.overrides?.nextjsPostDeploy,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsPostDeployProps,
    });
    this.orderAfterInitCache(postDeploy);
    return postDeploy;
  }
}
