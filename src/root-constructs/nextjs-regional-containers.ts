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
import { OptionalNextjsPostDeployProps } from "../generated-structs/OptionalNextjsPostDeployProps";
import {
  NextjsContainers,
  NextjsContainersOverrides,
} from "../nextjs-compute/nextjs-containers";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";

export interface NextjsRegionalContainersConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsContainerProps?: OptionalNextjsContainersProps;
  readonly nextjsPostDeployProps?: OptionalNextjsPostDeployProps;
}

/**
 * Overrides for `NextjsRegionalContainers`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsRegionalContainersOverrides extends NextjsBaseOverrides {
  readonly nextjsRegionalContainers?: NextjsRegionalContainersConstructOverrides;
  readonly nextjsContainers?: NextjsContainersOverrides;
  readonly nextjsPostDeploy?: NextjsPostDeployOverrides;
}

export interface NextjsRegionalContainersProps extends NextjsBaseProps {
  /**
   * Bring your own Application Load Balancer. When provided, it is passed
   * directly to `ApplicationLoadBalancedFargateService`. If the ALB already
   * has a listener on port 80, call `removeAutoCreatedListener()` after
   * construction to avoid deployment failures.
   */
  readonly alb?: IApplicationLoadBalancer;
  /**
   * Bring your own ECS cluster. When provided, cdk-nextjs will skip creating
   * a new cluster and VPC gateway endpoints.
   */
  readonly ecsCluster?: ICluster;
  /**
   * Override props of any construct.
   */
  readonly overrides?: NextjsRegionalContainersOverrides;
}

/**
 * Deploy Next.js load balanced with containers. Uses [Application Load
 * Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)
 * for load balancing and [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
 * for containers.
 */
export class NextjsRegionalContainers extends NextjsBaseConstruct {
  nextjsContainers: NextjsContainers;
  nextjsPostDeploy: NextjsPostDeploy;
  get url(): string {
    return this.nextjsContainers.url;
  }

  private props: NextjsRegionalContainersProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsRegionalContainersProps,
  ) {
    super(scope, id, props, NextjsType.REGIONAL_CONTAINERS);
    this.props = props;

    this.nextjsContainers = this.createNextjsLoadBalancedContainers();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsLoadBalancedContainers(): NextjsContainers {
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
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsContainerProps,
    });
  }

  private createNextjsPostDeploy(): NextjsPostDeploy {
    return new NextjsPostDeploy(this, "NextjsPostDeploy", {
      buildId: this.nextjsBuild.buildId,
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      overrides: this.props.overrides?.nextjsPostDeploy,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsPostDeployProps,
    });
  }
}
