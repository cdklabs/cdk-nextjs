import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
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
import {
  NextjsBaseConstructOverrides,
  NextjsBaseOverrides,
  NextjsBaseConstruct,
  NextjsBaseProps,
} from "./nextjs-base-construct";

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
   * Bring your own distribution. Can be used with `basePath` to host multiple
   * apps on the same CloudFront distribution.
   */
  readonly distribution?: Distribution;
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
  get url(): string {
    return `https://${this.nextjsDistribution.distribution.domainName}`;
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
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsContainers(): NextjsContainers {
    // Create containers with local build output
    return new NextjsContainers(this, "NextjsContainers", {
      ...this.computeBaseProps(),
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
      basePath: this.props.basePath,
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
