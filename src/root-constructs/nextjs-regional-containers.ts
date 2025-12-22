import { Construct } from "constructs";
import { NextjsType } from "../constants";
import {
  NextjsBaseConstructOverrides,
  NextjsBaseOverrides,
  NextjsBaseConstruct,
  NextjsBaseProps,
} from "./nextjs-base-construct";
import { OptionalNextjsContainersProps } from "../generated-structs/OptionalNextjsContainersProps";
import {
  NextjsContainers,
  NextjsContainersOverrides,
} from "../nextjs-compute/nextjs-containers";

export interface NextjsRegionalContainersConstructOverrides extends NextjsBaseConstructOverrides {
  readonly nextjsContainerProps?: OptionalNextjsContainersProps;
}

/**
 * Overrides for `NextjsRegionalContainers`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsRegionalContainersOverrides extends NextjsBaseOverrides {
  readonly nextjsRegionalContainers?: NextjsRegionalContainersConstructOverrides;
  readonly nextjsContainers?: NextjsContainersOverrides;
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
  nextjsContainers: NextjsContainers;
  get url() {
    return `http://${
      this.nextjsContainers.albFargateService.loadBalancer.loadBalancerDnsName
    }`;
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
    this.nextjsFileSystem.allowCompute({
      connections: this.nextjsContainers.albFargateService.service.connections,
      role: this.nextjsContainers.albFargateService.taskDefinition.taskRole,
    });
  }

  private createNextjsLoadBalancedContainers() {
    if (!this.nextjsBuild.imageForNextjsContainers) {
      throw new Error("nextjsBuild.imageForNextjsContainers is undefined");
    }
    return new NextjsContainers(this, "NextjsContainers", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      dockerImageAsset: this.nextjsBuild.imageForNextjsContainers,
      fileSystem: this.nextjsFileSystem.fileSystem,
      healthCheckPath: this.baseProps.healthCheckPath,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsContainers,
      relativeEntrypointPath: this.nextjsBuild.relativePathToEntrypoint,
      vpc: this.nextjsVpc.vpc,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsContainerProps,
    });
  }
}
