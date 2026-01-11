import { IVpc } from "aws-cdk-lib/aws-ec2";
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
import { OptionalNextjsVpcProps } from "../generated-structs/OptionalNextjsVpcProps";
import {
  NextjsContainers,
  NextjsContainersOverrides,
} from "../nextjs-compute/nextjs-containers";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";
import { NextjsVpc, NextjsVpcOverrides } from "../nextjs-vpc";

export interface NextjsRegionalContainersConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsContainerProps?: OptionalNextjsContainersProps;
  readonly nextjsPostDeployProps?: OptionalNextjsPostDeployProps;
  readonly nextjsVpcProps?: OptionalNextjsVpcProps;
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
  readonly nextjsVpc?: NextjsVpcOverrides;
}

export interface NextjsRegionalContainersProps extends NextjsBaseProps {
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
  nextjsVpc: NextjsVpc;
  nextjsContainers: NextjsContainers;
  nextjsPostDeploy: NextjsPostDeploy;
  get url(): string {
    return `http://${this.nextjsContainers.albFargateService.loadBalancer.loadBalancerDnsName}`;
  }

  private props: NextjsRegionalContainersProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsRegionalContainersProps,
  ) {
    super(scope, id, props, NextjsType.REGIONAL_CONTAINERS);
    this.props = props;

    this.nextjsVpc = this.createVpc();
    this.nextjsContainers = this.createNextjsLoadBalancedContainers();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  /**
   * Get VPC for container deployments. Containers require VPC for networking.
   */
  private vpcForContainers(): IVpc {
    return this.nextjsVpc.vpc;
  }

  private createVpc(): NextjsVpc {
    return new NextjsVpc(this, "NextjsVpc", {
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsVpc,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsVpcProps,
    });
  }

  private createNextjsLoadBalancedContainers(): NextjsContainers {
    // Create containers with local build output
    return new NextjsContainers(this, "NextjsContainers", {
      ...this.computeBaseProps(),
      vpc: this.vpcForContainers(),
      relativeEntrypointPath: this.nextjsBuild.relativePathToEntrypoint,
      overrides: this.props.overrides?.nextjsContainers,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsContainerProps,
    });
  }

  private createNextjsPostDeploy(): NextjsPostDeploy {
    return new NextjsPostDeploy(this, "NextjsPostDeploy", {
      buildId: this.nextjsBuild.buildId,
      cacheBucket: this.nextjsCache.cacheBucket,
      revalidationTable: this.nextjsCache.revalidationTable,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      relativePathToPackage: this.baseProps.relativePathToPackage,
      overrides: this.props.overrides?.nextjsPostDeploy,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsPostDeployProps,
    });
  }
}
