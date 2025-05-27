import { Construct } from "constructs";
import {
  BaseNextjsConstructOverrides,
  BaseNextjsOverrides,
} from "./nextjs-base-overrides";
import { NextjsBaseProps } from "./nextjs-base-props";
import { NextjsType } from "../constants";
import { OptionalNextjsContainersProps } from "../generated-structs/OptionalNextjsContainersProps";
import { NextjsAssetsDeployment } from "../nextjs-assets-deployment";
import { NextjsBuild } from "../nextjs-build/nextjs-build";
import {
  NextjsContainers,
  NextjsContainersOverrides,
} from "../nextjs-compute/nextjs-containers";
import { NextjsFileSystem } from "../nextjs-file-system";
import { NextjsPostDeploy } from "../nextjs-post-deploy";
import { NextjsVpc } from "../nextjs-vpc";
import { handleDeprecatedProperties } from "../utils/handle-deprecated-properties";

export interface NextjsRegionalContainersConstructOverrides
  extends BaseNextjsConstructOverrides {
  readonly nextjsContainerProps?: OptionalNextjsContainersProps;
}

/**
 * Overrides for `NextjsRegionalContainers`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsRegionalContainersOverrides extends BaseNextjsOverrides {
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
export class NextjsRegionalContainers extends Construct {
  nextjsBuild: NextjsBuild;
  nextjsVpc: NextjsVpc;
  nextjsFileSystem: NextjsFileSystem;
  nextjsAssetsDeployment: NextjsAssetsDeployment;
  nextjsContainers: NextjsContainers;
  nextjsPostDeploy: NextjsPostDeploy;

  private nextjsType = NextjsType.REGIONAL_CONTAINERS;
  private props: NextjsRegionalContainersProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsRegionalContainersProps,
  ) {
    super(scope, id);
    this.props = handleDeprecatedProperties(props);
    this.nextjsBuild = this.createNextjsBuild();
    this.nextjsVpc = this.createVpc();
    this.nextjsFileSystem = this.createNextjsFileSystem();
    this.nextjsAssetsDeployment = this.createNextjsAssetsDeployment();
    this.nextjsContainers = this.createNextjsLoadBalancedContainers();
    this.nextjsFileSystem.allowCompute({
      connections: this.nextjsContainers.albFargateService.service.connections,
      role: this.nextjsContainers.albFargateService.taskDefinition.taskRole,
    });
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsBuild() {
    return new NextjsBuild(this, "NextjsBuild", {
      buildCommand: this.props.buildCommand,
      buildContext: this.props.buildContext,
      nextjsType: this.nextjsType,
      relativePathToPackage: this.props.relativePathToPackage,
      overrides: this.props.overrides?.nextjsBuild,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsBuildProps,
    });
  }
  private createVpc() {
    return new NextjsVpc(this, "NextjsVpc", {
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsVpc,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsVpcProps,
    });
  }
  private createNextjsFileSystem() {
    return new NextjsFileSystem(this, "NextjsFileSystem", {
      vpc: this.nextjsVpc.vpc,
      overrides: this.props.overrides?.nextjsFileSystem,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsFileSystemProps,
    });
  }
  private createNextjsAssetsDeployment() {
    return new NextjsAssetsDeployment(this, "NextjsAssetsDeployment", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      buildImageDigest: this.nextjsBuild.buildImageDigest,
      dockerImageCode: this.nextjsBuild.imageForNextjsAssetsDeployment,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsAssetsDeployment,
      relativePathToPackage: this.props.relativePathToPackage,
      vpc: this.nextjsVpc.vpc,
      ...this.props.overrides?.nextjsRegionalContainers
        ?.nextjsAssetsDeploymentProps,
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
      healthCheckPath: this.props.healthCheckPath,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsContainers,
      relativeEntrypointPath: this.nextjsBuild.relativePathToEntrypoint,
      vpc: this.nextjsVpc.vpc,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsContainerProps,
    });
  }
  private createNextjsPostDeploy() {
    const nextjsPostDeploy = new NextjsPostDeploy(this, "NextjsPostDeploy", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      buildImageDigest: this.nextjsBuild.buildImageDigest,
      overrides: this.props.overrides?.nextjsPostDeploy,
      relativePathToPackage: this.props.relativePathToPackage,
      vpc: this.nextjsVpc.vpc,
      ...this.props.overrides?.nextjsRegionalContainers?.nextjsPostDeployProps,
    });
    // ensure NextjsAssetsDeployment finishes before NextjsPostDeploy
    nextjsPostDeploy.node.addDependency(this.nextjsAssetsDeployment);
    return nextjsPostDeploy;
  }
}
