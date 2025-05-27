import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
import {
  BaseNextjsConstructOverrides,
  BaseNextjsOverrides,
} from "./nextjs-base-overrides";
import { NextjsBaseProps } from "./nextjs-base-props";
import { NextjsType } from "../constants";
import { OptionalNextjsDistributionProps } from "../generated-structs/OptionalNextjsDistributionProps";
import { NextjsAssetsDeployment } from "../nextjs-assets-deployment";
import { NextjsBuild } from "../nextjs-build/nextjs-build";
import {
  NextjsFunctions,
  NextjsFunctionsOverrides,
  NextjsFunctionsProps,
} from "../nextjs-compute/nextjs-functions";
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

export interface NextjsGlobalFunctionsConstructOverrides
  extends BaseNextjsConstructOverrides {
  readonly nextjsFunctionsProps?: NextjsFunctionsProps;
  readonly nextjsDistributionProps?: OptionalNextjsDistributionProps;
  readonly nextjsStaticAssetsProps?: NextjsStaticAssetsProps;
}

/**
 * Overrides for `NextjsGlobalFunctions`. Overrides are lower level than
 * props and are passed directly to CDK Constructs giving you more control. It's
 * recommended to use caution and review source code so you know how they're used.
 */
export interface NextjsGlobalFunctionsOverrides extends BaseNextjsOverrides {
  readonly nextjsGlobalFunctions?: NextjsGlobalFunctionsConstructOverrides;
  readonly nextjsFunctions?: NextjsFunctionsOverrides;
  readonly nextjsDistribution?: NextjsDistributionOverrides;
  readonly nextjsStaticAssets?: NextjsStaticAssetsOverrides;
}

export interface NextjsGlobalFunctionsProps extends NextjsBaseProps {
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
  readonly overrides?: NextjsGlobalFunctionsOverrides;
}

/**
 * Deploy Next.js globally distributed with functions. Uses [CloudFront
 * Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html)
 * as Content Delivery Network (CDN) for global distribution and [AWS Lambda Functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)
 * for functions.
 */
export class NextjsGlobalFunctions extends Construct {
  nextjsBuild: NextjsBuild;
  nextjsStaticAssets: NextjsStaticAssets;
  nextjsVpc: NextjsVpc;
  nextjsFileSystem: NextjsFileSystem;
  nextjsAssetsDeployment: NextjsAssetsDeployment;
  nextjsFunctions: NextjsFunctions;
  nextjsDistribution: NextjsDistribution;
  nextjsPostDeploy: NextjsPostDeploy;

  private nextjsType = NextjsType.GLOBAL_FUNCTIONS;
  private props: NextjsGlobalFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsGlobalFunctionsProps) {
    super(scope, id);
    this.props = handleDeprecatedProperties(props);
    this.nextjsBuild = this.createNextjsBuild();
    this.nextjsStaticAssets = this.createNextjsStaticAssets();
    this.nextjsVpc = this.createVpc();
    this.nextjsFileSystem = this.createNextjsFileSystem();
    this.nextjsAssetsDeployment = this.createNextjsAssetsDeployment();
    this.nextjsFunctions = this.createNextjsFunctions();
    this.nextjsFileSystem.allowCompute({
      connections: this.nextjsFunctions.function.connections,
      role: this.nextjsFunctions.function.role!,
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
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsBuildProps,
    });
  }
  private createNextjsStaticAssets() {
    return new NextjsStaticAssets(this, "NextjsStaticAssets", {
      overrides: this.props.overrides?.nextjsStaticAssets,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsStaticAssetsProps,
    });
  }
  private createVpc() {
    return new NextjsVpc(this, "NextjsVpc", {
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsVpc,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsVpcProps,
    });
  }
  private createNextjsFileSystem() {
    return new NextjsFileSystem(this, "NextjsFileSystem", {
      vpc: this.nextjsVpc.vpc,
      overrides: this.props.overrides?.nextjsFileSystem,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsFileSystemProps,
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
      ...this.props.overrides?.nextjsGlobalFunctions
        ?.nextjsAssetsDeploymentProps,
    });
  }
  private createNextjsFunctions() {
    if (!this.nextjsBuild.imageForNextjsFunctions) {
      throw new Error("nextjsBuild.dockerImageCode is undefined");
    }
    return new NextjsFunctions(this, "NextjsFunctions", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      dockerImageCode: this.nextjsBuild.imageForNextjsFunctions,
      healthCheckPath: this.props.healthCheckPath,
      vpc: this.nextjsVpc.vpc,
      overrides: this.props.overrides?.nextjsFunctions,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsFunctionsProps,
    });
  }
  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      basePath: this.props.basePath,
      functionUrl: this.nextjsFunctions.functionUrl,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsDistributionProps,
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
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsPostDeployProps,
    });
    // ensure NextjsAssetsDeployment finishes before NextjsPostDeploy
    nextjsPostDeploy.node.addDependency(this.nextjsAssetsDeployment);
    return nextjsPostDeploy;
  }
}
