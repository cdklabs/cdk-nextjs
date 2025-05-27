import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
import {
  BaseNextjsConstructOverrides,
  BaseNextjsOverrides,
} from "./nextjs-base-overrides";
import { NextjsBaseProps } from "./nextjs-base-props";
import { NextjsType } from "../constants";
import { OptionalNextjsContainersProps } from "../generated-structs/OptionalNextjsContainersProps";
import { OptionalNextjsDistributionProps } from "../generated-structs/OptionalNextjsDistributionProps";
import { NextjsAssetsDeployment } from "../nextjs-assets-deployment";
import { NextjsBuild } from "../nextjs-build/nextjs-build";
import {
  NextjsContainers,
  NextjsContainersOverrides,
} from "../nextjs-compute/nextjs-containers";
import {
  NextjsDistribution,
  NextjsDistributionOverrides,
} from "../nextjs-distribution";
import { NextjsFileSystem } from "../nextjs-file-system";
import { NextjsPostDeploy } from "../nextjs-post-deploy";
import {
  NextjsStaticAssets,
  NextjsStaticAssetsOverrides,
  NextjsStaticAssetsProps,
} from "../nextjs-static-assets";
import { NextjsVpc } from "../nextjs-vpc";
import { handleDeprecatedProperties } from "../utils/handle-deprecated-properties";

export interface NextjsGlobalContainersConstructOverrides
  extends BaseNextjsConstructOverrides {
  readonly nextjsContainersProps?: OptionalNextjsContainersProps;
  readonly nextjsDistributionProps?: OptionalNextjsDistributionProps;
  readonly nextjsStaticAssetsProps?: NextjsStaticAssetsProps;
}

/**
 * Overrides for `NextjsGlobalContainers`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsGlobalContainersOverrides extends BaseNextjsOverrides {
  readonly nextjsGlobalContainers?: NextjsGlobalContainersConstructOverrides;
  readonly nextjsContainers?: NextjsContainersOverrides;
  readonly nextjsDistribution?: NextjsDistributionOverrides;
  readonly nextjsStaticAssets?: NextjsStaticAssetsOverrides;
}

export interface NextjsGlobalContainersProps extends NextjsBaseProps {
  /**
   * Prefix to the URI path the app will be served at. Especially useful when
   * passing in your own `distribution`.
   * @example "/my-base-path"
   */
  readonly basePath?: string;
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
export class NextjsGlobalContainers extends Construct {
  nextjsBuild: NextjsBuild;
  nextjsStaticAssets: NextjsStaticAssets;
  nextjsVpc: NextjsVpc;
  nextjsFileSystem: NextjsFileSystem;
  nextjsAssetsDeployment: NextjsAssetsDeployment;
  nextjsContainers: NextjsContainers;
  nextjsDistribution: NextjsDistribution;
  nextjsPostDeploy: NextjsPostDeploy;

  private nextjsType = NextjsType.GLOBAL_CONTAINERS;
  private props: NextjsGlobalContainersProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsGlobalContainersProps,
  ) {
    super(scope, id);
    this.props = handleDeprecatedProperties(props);
    this.nextjsBuild = this.createNextjsBuild();
    this.nextjsStaticAssets = this.createNextjsStaticAssets();
    this.nextjsVpc = this.createVpc();
    this.nextjsFileSystem = this.createNextjsFileSystem();
    this.nextjsAssetsDeployment = this.createNextjsAssetsDeployment();
    this.nextjsContainers = this.createNextjsContainers();
    this.nextjsFileSystem.allowCompute({
      connections: this.nextjsContainers.albFargateService.service.connections,
      role: this.nextjsContainers.albFargateService.taskDefinition.taskRole,
    });
    this.nextjsDistribution = this.createNextjsDistribution();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  private createNextjsBuild() {
    return new NextjsBuild(this, "NextjsBuild", {
      buildCommand: this.props.buildCommand,
      buildContext: this.props.buildContext,
      nextjsType: this.nextjsType,
      relativePathToPackage: this.props.relativePathToPackage,
      overrides: this.props.overrides?.nextjsBuild,
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsBuildProps,
    });
  }
  private createNextjsStaticAssets() {
    return new NextjsStaticAssets(this, "NextjsStaticAssets", {
      overrides: this.props.overrides?.nextjsStaticAssets,
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsStaticAssetsProps,
    });
  }
  private createVpc() {
    return new NextjsVpc(this, "NextjsVpc", {
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsVpc,
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsVpcProps,
    });
  }
  private createNextjsFileSystem() {
    return new NextjsFileSystem(this, "NextjsFileSystem", {
      vpc: this.nextjsVpc.vpc,
      overrides: this.props.overrides?.nextjsFileSystem,
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsFileSystemProps,
    });
  }
  private createNextjsAssetsDeployment() {
    return new NextjsAssetsDeployment(this, "NextjsAssetsDeployment", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      basePath: this.props.basePath,
      buildId: this.nextjsBuild.buildId,
      buildImageDigest: this.nextjsBuild.buildImageDigest,
      dockerImageCode: this.nextjsBuild.imageForNextjsAssetsDeployment,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsAssetsDeployment,
      relativePathToPackage: this.props.relativePathToPackage,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      vpc: this.nextjsVpc.vpc,
      ...this.props.overrides?.nextjsGlobalContainers
        ?.nextjsAssetsDeploymentProps,
    });
  }
  private createNextjsContainers() {
    if (!this.nextjsBuild.imageForNextjsContainers) {
      throw new Error("nextjsBuild.dockerImageAsset is undefined");
    }
    return new NextjsContainers(this, "NextjsContainers", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      dockerImageAsset: this.nextjsBuild.imageForNextjsContainers,
      fileSystem: this.nextjsFileSystem.fileSystem,
      healthCheckPath: this.props.healthCheckPath,
      nextjsType: this.nextjsType,
      relativeEntrypointPath: this.nextjsBuild.relativePathToEntrypoint,
      overrides: this.props.overrides?.nextjsContainers,
      vpc: this.nextjsVpc.vpc,
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
  private createNextjsPostDeploy() {
    const nextjsPostDeploy = new NextjsPostDeploy(this, "NextjsPostDeploy", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      buildImageDigest: this.nextjsBuild.buildImageDigest,
      distribution: this.nextjsDistribution.distribution,
      overrides: this.props.overrides?.nextjsPostDeploy,
      relativePathToPackage: this.props.relativePathToPackage,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      vpc: this.nextjsVpc.vpc,
      ...this.props.overrides?.nextjsGlobalContainers?.nextjsPostDeployProps,
    });
    // ensure NextjsAssetsDeployment finishes before NextjsPostDeploy
    nextjsPostDeploy.node.addDependency(this.nextjsAssetsDeployment);
    return nextjsPostDeploy;
  }
}
