import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { ICluster } from "aws-cdk-lib/aws-ecs";
import { IApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
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
   * Path to API Route Handler that returns HTTP 200 to ensure compute health.
   * Used by the ALB target group and the ECS container health check, both of
   * which have to be able to tell a running task from a wedged one.
   *
   * Give the path as your app routes it, without your app's `basePath` —
   * cdk-nextjs adds that prefix, since both checks hit the app directly.
   * @example "/api/health"
   * @example
   * // api/health/route.ts
   * import { NextResponse } from "next/server";
   *
   * export function GET() {
   *   return NextResponse.json("");
   * }
   */
  readonly healthCheckPath: string;
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
    const { taskDefinition } = this.nextjsContainers.albFargateService;
    const environment = this.wireCloudFrontInvalidation(
      [taskDefinition.taskRole],
      this.nextjsDistribution.distribution,
      false,
    );
    for (const [name, value] of Object.entries(environment)) {
      taskDefinition.defaultContainer?.addEnvironment(name, value);
    }
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsContainers(): NextjsContainers {
    // Create containers with local build output
    return new NextjsContainers(this, "NextjsContainers", {
      ...this.computeBaseProps(),
      alb: this.props.alb,
      buildDirectory: this.props.buildDirectory,
      ecsCluster: this.props.ecsCluster,
      healthCheckPath: this.resolvedHealthCheckPath(this.props.healthCheckPath),
      relativeEntrypointPath: this.nextjsBuild.relativePathToEntrypoint,
      relativeProjectDir: this.nextjsBuild.relativeProjectDir,
      overrides: {
        ...this.props.overrides?.nextjsContainers,
        ecsClusterProps: {
          ...this.props.overrides?.nextjsContainers?.ecsClusterProps,
          // Conditional for the same reason as the Functions' `vpc`: assigned
          // unconditionally, an unset `vpc` prop would erase the override's.
          ...(this.baseProps.vpc ? { vpc: this.baseProps.vpc } : {}),
        },
      },
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsContainersProps,
    });
  }

  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      assetPrefix: this.nextjsBuild.nextConfigAssetPrefixPath,
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
    const postDeploy = new NextjsPostDeploy(this, "NextjsPostDeploy", {
      basePath: this.resolvedBasePath,
      buildId: this.nextjsBuild.buildId,
      distribution: this.nextjsDistribution.distribution,
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      staticAssetsKeyPrefix: this.nextjsStaticAssets.keyPrefix,
      overrides: this.props.overrides?.nextjsPostDeploy,
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsPostDeployProps,
    });
    this.orderAfterInitCache(postDeploy);
    return postDeploy;
  }
}
