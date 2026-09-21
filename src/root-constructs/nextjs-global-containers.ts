import { Stack } from "aws-cdk-lib";
import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { ICluster } from "aws-cdk-lib/aws-ecs";
import { IApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
import {
  NextjsBaseConstructOverrides,
  NextjsBaseOverrides,
  NextjsBaseConstruct,
  NextjsBaseProps,
} from "./nextjs-base-construct";
import { OptionalNextjsContainersProps } from "../generated-structs/OptionalNextjsContainersProps";
import { OptionalNextjsDistributionProps } from "../generated-structs/OptionalNextjsDistributionProps";
import { OptionalNextjsPostDeployProps } from "../generated-structs/OptionalNextjsPostDeployProps";
import {
  NextjsContainers,
  NextjsContainersOverrides,
} from "../nextjs-compute/nextjs-containers";
import {
  NextjsDistribution,
  NextjsDistributionOverrides,
} from "../nextjs-distribution";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";
import { joinPath } from "../utils/base-path";

export interface NextjsGlobalContainersConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsContainersProps?: OptionalNextjsContainersProps;
  readonly nextjsDistributionProps?: OptionalNextjsDistributionProps;
  readonly nextjsPostDeployProps?: OptionalNextjsPostDeployProps;
}

/**
 * Overrides for `NextjsGlobalContainers`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsGlobalContainersOverrides extends NextjsBaseOverrides {
  readonly nextjsGlobalContainers?: NextjsGlobalContainersConstructOverrides;
  readonly nextjsContainers?: NextjsContainersOverrides;
  readonly nextjsDistribution?: NextjsDistributionOverrides;
  readonly nextjsPostDeploy?: NextjsPostDeployOverrides;
}

export interface NextjsGlobalContainersProps extends NextjsBaseProps {
  /**
   * Bring your own Application Load Balancer. When provided, it is passed
   * directly to `ApplicationLoadBalancedFargateService`. If the ALB already
   * has a listener on port 80, call `removeAutoCreatedListener()` after
   * construction to avoid deployment failures.
   */
  readonly alb?: IApplicationLoadBalancer;
  /**
   * Bring your own distribution. Can be used with `basePath` to host multiple
   * apps on the same CloudFront distribution.
   */
  readonly distribution?: Distribution;
  /**
   * Bring your own ECS cluster. When provided, cdk-nextjs will skip creating
   * a new cluster and VPC gateway endpoints.
   */
  readonly ecsCluster?: ICluster;
  /**
   * Override props of any construct.
   */
  readonly overrides?: NextjsGlobalContainersOverrides;
}

/**
 * Deploy Next.js globally distributed with containers. Uses [CloudFront
 * Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html)
 * as Content Delivery Network (CDN) for global distribution and [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
 * for containers.
 */
export class NextjsGlobalContainers extends NextjsBaseConstruct {
  nextjsContainers: NextjsContainers;
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

  private props: NextjsGlobalContainersProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsGlobalContainersProps,
  ) {
    super(scope, id, props, NextjsType.GLOBAL_CONTAINERS);
    this.props = props;

    this.nextjsContainers = this.createNextjsContainers();
    this.nextjsDistribution = this.createNextjsDistribution();
    this.wireCloudFrontInvalidation();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  /**
   * Grants the task role permission to invalidate the distribution and passes
   * along a way to look up its ID, so on-demand revalidation
   * (revalidateTag/revalidatePath) can evict stale responses from the CDN
   * edge cache, not just the origin's S3/DynamoDB cache.
   *
   * The distribution ID is published to an SSM Parameter (whose *name* is
   * static and safe to embed in the task's environment) rather than passed
   * directly, and the IAM grant is scoped to all distributions in this
   * account/region rather than this specific one. See the equivalent method
   * in `NextjsGlobalFunctions` for why: the same pattern is used here for
   * consistency, even though containers' distribution (ALB-origin-based)
   * doesn't hit the circular CloudFormation dependency functions' does.
   */
  private wireCloudFrontInvalidation(): void {
    const stack = Stack.of(this);
    const { taskDefinition } = this.nextjsContainers.albFargateService;
    const distributionIdParameterName = `cdk-nextjs-distribution-id-${this.node.addr}`;

    new StringParameter(this, "DistributionIdParameter", {
      parameterName: distributionIdParameterName,
      stringValue: this.nextjsDistribution.distribution.distributionId,
    });

    taskDefinition.addToTaskRolePolicy(
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
    taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        // Scoped to all distributions (not just this one) for consistency
        // with NextjsGlobalFunctions, which can't scope this to its specific
        // distribution due to a circular CloudFormation dependency (see the
        // class doc comment above and the equivalent method there). Hence
        // the SSM parameter indirection above for looking up the ID at
        // runtime instead of synth time.
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
    taskDefinition.defaultContainer?.addEnvironment(
      "CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME",
      distributionIdParameterName,
    );
  }

  private createNextjsContainers(): NextjsContainers {
    // Create containers with local build output
    return new NextjsContainers(this, "NextjsContainers", {
      ...this.computeBaseProps(),
      alb: this.props.alb,
      ecsCluster: this.props.ecsCluster,
      relativeEntrypointPath: this.nextjsBuild.relativePathToEntrypoint,
      overrides: {
        ...this.props.overrides?.nextjsContainers,
        ecsClusterProps: {
          ...this.props.overrides?.nextjsContainers?.ecsClusterProps,
          vpc: this.baseProps.vpc,
        },
      },
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsContainersProps,
    });
  }

  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      basePath: this.resolvedBasePath,
      certificate: this.nextjsContainers.albFargateService.certificate,
      distribution: this.props.distribution,
      loadBalancer: this.nextjsContainers.albFargateService.loadBalancer,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsDistributionProps,
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
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsPostDeployProps,
    });
  }
}
