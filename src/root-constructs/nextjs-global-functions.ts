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
  NextjsFunctions,
  NextjsFunctionsOverrides,
} from "../nextjs-compute/nextjs-functions";
import {
  NextjsImageFunction,
  NextjsImageFunctionOverrides,
} from "../nextjs-compute/nextjs-image-function";
import {
  NextjsDistribution,
  NextjsDistributionOverrides,
} from "../nextjs-distribution";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";
import { useDedicatedImageFunction } from "../utils/experimental-flags";

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
  readonly nextjsImageFunction?: NextjsImageFunctionOverrides;
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
  /**
   * Only created when the (experimental, unsupported) dedicated image
   * optimization Lambda is enabled. `_next/image` is otherwise served by
   * {@link nextjsFunctions}.
   */
  nextjsImageFunction?: NextjsImageFunction;
  nextjsDistribution: NextjsDistribution;
  nextjsPostDeploy: NextjsPostDeploy;
  get url(): string {
    return `https://${this.nextjsDistribution.distribution.domainName}`;
  }

  private props: NextjsGlobalFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsGlobalFunctionsProps) {
    super(scope, id, props, NextjsType.GLOBAL_FUNCTIONS);
    this.props = props;

    this.nextjsFunctions = this.createNextjsFunctions(
      this.props.overrides?.nextjsFunctions,
    );
    if (useDedicatedImageFunction()) {
      this.nextjsImageFunction = this.createNextjsImageFunction(
        this.props.overrides?.nextjsImageFunction,
      );
    }
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

    this.nextjsFunctions.function.addToRolePolicy(
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
    this.nextjsFunctions.function.addToRolePolicy(
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
    this.nextjsFunctions.function.addEnvironment(
      "CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME",
      distributionIdParameterName,
    );
  }

  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      basePath: this.resolvedBasePath,
      functionUrl: this.nextjsFunctions.functionUrl,
      imageFunctionUrl: this.nextjsImageFunction?.functionUrl,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsDistributionProps,
    });
  }

  private createNextjsPostDeploy(): NextjsPostDeploy {
    return new NextjsPostDeploy(this, "NextjsPostDeploy", {
      buildId: this.nextjsBuild.buildId,
      distribution: this.nextjsDistribution.distribution,
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      overrides: this.props.overrides?.nextjsPostDeploy,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsPostDeployProps,
    });
  }
}
