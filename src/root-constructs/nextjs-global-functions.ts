import { Stack } from "aws-cdk-lib";
import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
import {
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
    this.wireCloudFrontInvalidation();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  /**
   * Grants the function permission to invalidate the distribution and passes
   * along a way to look up its ID, so on-demand revalidation
   * (revalidateTag/revalidatePath) can evict stale responses from the CDN
   * edge cache, not just the origin's S3/DynamoDB cache.
   *
   * The distribution ID can't be passed as a plain env var or scoped IAM
   * resource ARN: the distribution's origin references this function's URL,
   * so making the function's role/environment reference the distribution's
   * ID in return would create a circular CloudFormation dependency. Instead,
   * the ID is published to an SSM Parameter (whose *name* is static and safe
   * to embed) that the function reads at runtime, and the IAM grant is
   * scoped to all distributions in this account/region rather than this
   * specific (not-yet-known-at-synth-time) distribution.
   */
  private wireCloudFrontInvalidation(): void {
    const stack = Stack.of(this);
    const distributionIdParameterName = `cdk-nextjs-distribution-id-${this.node.addr}`;

    new StringParameter(this, "DistributionIdParameter", {
      parameterName: distributionIdParameterName,
      stringValue: this.nextjsDistribution.distribution.distributionId,
    });

    // Every group, not just the default one: `revalidateTag`/`revalidatePath` can
    // be called from any route handler, so any function may need to invalidate.
    for (const group of this.nextjsFunctions.functionGroups) {
      group.function.addToRolePolicy(
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            stack.formatArn({
              service: "ssm",
              resource: "parameter",
              resourceName: distributionIdParameterName,
            }),
          ],
        }),
      );
      group.function.addToRolePolicy(
        new PolicyStatement({
          actions: ["cloudfront:CreateInvalidation"],
          // Can't scope this to the specific distribution: the distribution's
          // origin already depends on this function (via its FunctionUrl), so
          // referencing the distribution's ID here would create a circular
          // CloudFormation dependency. Hence the SSM parameter indirection
          // above for looking up the ID at runtime instead of synth time.
          resources: [
            stack.formatArn({
              service: "cloudfront",
              region: "",
              resource: "distribution",
              resourceName: "*",
            }),
          ],
        }),
      );
      group.function.addEnvironment(
        "CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME",
        distributionIdParameterName,
      );
      // Paired with the parameter name because invalidation is the only thing
      // that needs it: the paths the cache handler derives are routes, and
      // CloudFront cached them under `basePath`. Set only when there is one, so
      // apps without a `basePath` see no environment change.
      if (this.resolvedBasePath) {
        group.function.addEnvironment(
          "CDK_NEXTJS_BASE_PATH",
          this.resolvedBasePath,
        );
      }
    }
  }

  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      assetPrefix: this.nextjsBuild.nextConfigAssetPrefixPath,
      basePath: this.resolvedBasePath,
      functionUrl: this.nextjsFunctions.functionUrl,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      // The default group backs the default behavior, so only the rest need
      // behaviors of their own. Routes come from the props rather than the
      // manifest: these are the patterns to route on, not the templates that
      // matched them.
      functionGroups: this.props.functionGroups?.map((group) => {
        const deployed = this.nextjsFunctions.functionGroups.find(
          (it) => it.name === group.name,
        );
        if (!deployed?.functionUrl) {
          throw new Error(
            `Function group "${group.name}" has no Function URL to route to.`,
          );
        }
        return {
          name: group.name,
          routes: group.routes,
          functionUrl: deployed.functionUrl,
        };
      }),
      hasDataRoutes: this.nextjsBuild.hasDataRoutes,
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
