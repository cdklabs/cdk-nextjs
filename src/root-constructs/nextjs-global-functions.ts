import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { DockerImageCode } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import {
  BaseNextjsConstructOverrides,
  BaseNextjsOverrides,
} from "./nextjs-base-overrides";
import { NextjsBaseProps } from "./nextjs-base-props";
import { NextjsType } from "../common";
import { OptionalNextjsDistributionProps } from "../generated-structs/OptionalNextjsDistributionProps";
import { OptionalNextjsInvalidationProps } from "../generated-structs/OptionalNextjsInvalidationProps";
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
import {
  NextjsInvalidation,
  NextjsInvalidationOverrides,
} from "../nextjs-invalidation";
import {
  NextjsRevalidation,
  NextjsRevalidationOverrides,
  NextjsRevalidationProps,
} from "../nextjs-revalidation";
import {
  NextjsStaticAssets,
  NextjsStaticAssetsOverrides,
  NextjsStaticAssetsProps,
} from "../nextjs-static-assets";
import { NextjsVpc } from "../nextjs-vpc";

export interface NextjsGlobalFunctionsConstructOverrides
  extends BaseNextjsConstructOverrides {
  readonly nextjsFunctionProps?: NextjsFunctionsProps;
  readonly nextjsDistributionProps?: OptionalNextjsDistributionProps;
  readonly nextjsInvalidationProps?: OptionalNextjsInvalidationProps;
  readonly nextjsRevalidationProps?: NextjsRevalidationProps;
  readonly nextjsStaticAssetsProps?: NextjsStaticAssetsProps;
}

export interface NextjsGlobalFunctionsOverrides extends BaseNextjsOverrides {
  readonly nextjsGlobalFunctions?: NextjsGlobalFunctionsConstructOverrides;
  readonly nextjsFunction?: NextjsFunctionsOverrides;
  readonly nextjsDistribution?: NextjsDistributionOverrides;
  readonly nextjsRevalidation?: NextjsRevalidationOverrides;
  readonly nextjsInvalidation?: NextjsInvalidationOverrides;
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
  nextjsFunctionsServer: NextjsFunctions;
  nextjsFunctionsImage: NextjsFunctions;
  nextjsDistribution: NextjsDistribution;
  nextjsRevalidation: NextjsRevalidation;
  nextjsInvalidation: NextjsInvalidation;

  private nextjsType = NextjsType.GLOBAL_FUNCTIONS;
  private props: NextjsGlobalFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsGlobalFunctionsProps) {
    super(scope, id);
    this.props = props;
    this.nextjsBuild = this.createNextjsBuild();
    this.nextjsStaticAssets = this.createNextjsStaticAssets();
    this.nextjsVpc = this.createVpc();
    this.nextjsFileSystem = this.createNextjsFileSystem();
    this.nextjsAssetsDeployment = this.createNextjsAssetsDeployment();
    if (!this.nextjsBuild.imageForNextjsFunctionsServer) {
      throw new Error("nextjsBuild.imageForNextjsFunctionsServer is undefined");
    }
    this.nextjsFunctionsServer = this.createNextjsFunctions(
      this.nextjsBuild.imageForNextjsFunctionsServer,
    );
    if (!this.nextjsBuild.imageForNextjsFunctionsImage) {
      throw new Error("nextjsBuild.dockerImageCode is undefined");
    }
    // separating image optimization into separate function saves 30MB+ on
    // server function which saves ~441ms on cold start. adds complication
    // (especially in NextjsDistribution) but worth it
    // see: https://aaronstuyvenberg.com/posts/containers-on-lambda
    this.nextjsFunctionsImage = this.createNextjsFunctions(
      this.nextjsBuild.imageForNextjsFunctionsImage,
    );
    this.nextjsFileSystem.allowCompute({
      connections: this.nextjsFunctionsServer.function.connections,
      role: this.nextjsFunctionsServer.function.role!,
    });
    this.nextjsDistribution = this.createNextjsDistribution();
    this.nextjsRevalidation = this.createNextjsRevalidation();
    this.nextjsInvalidation = this.createNextjsInvalidation();
  }

  private createNextjsBuild() {
    return new NextjsBuild(this, "NextjsBuild", {
      buildCommand: this.props.buildCommand,
      buildContext: this.props.buildContext,
      nextjsType: this.nextjsType,
      relativePathToWorkspace: this.props.relativePathToWorkspace,
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
      buildImageDigest: this.nextjsBuild.buildImageDigest,
      containerMountPathForEfs: this.nextjsBuild.containerMountPathForEfs,
      dockerImageCode: this.nextjsBuild.imageForNextjsAssetsDeployment,
      overrides: this.props.overrides?.nextjsAssetsDeployment,
      relativePathToWorkspace: this.props.relativePathToWorkspace,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      vpc: this.nextjsVpc.vpc,
      ...this.props.overrides?.nextjsGlobalFunctions
        ?.nextjsAssetsDeploymentProps,
    });
  }
  private createNextjsFunctions(dockerImageCode: DockerImageCode) {
    return new NextjsFunctions(this, "NextjsFunctions", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      containerMountPathForEfs: this.nextjsBuild.containerMountPathForEfs,
      dockerImageCode,
      healthCheckPath: this.props.healthCheckPath,
      vpc: this.nextjsVpc.vpc,
      overrides: this.props.overrides?.nextjsFunction,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsFunctionProps,
    });
  }
  private createNextjsDistribution() {
    return new NextjsDistribution(this, "NextjsDistribution", {
      assetsBucket: this.nextjsStaticAssets.bucket,
      basePath: this.props.basePath,
      loadBalancerDomainName: this.nextjsFunctionsServer.functionUrl.url,
      serverFunctionUrl: this.nextjsFunctionsServer.functionUrl,
      imageFunctionUrl: this.nextjsFunctionsImage.functionUrl,
      nextjsType: this.nextjsType,
      overrides: this.props.overrides?.nextjsDistribution,
      publicDirEntries: this.nextjsBuild.publicDirEntries,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsDistributionProps,
    });
  }
  private createNextjsRevalidation() {
    return new NextjsRevalidation(this, "NextjsRevalidation", {
      fn: this.nextjsFunctionsServer.function,
      overrides: this.props.overrides?.nextjsRevalidation,
      previewModeId: this.nextjsAssetsDeployment.previewModeId,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsRevalidationProps,
    });
  }
  private createNextjsInvalidation() {
    return new NextjsInvalidation(this, "NextjsInvalidation", {
      distribution: this.nextjsDistribution.distribution,
      overrides: this.props.overrides?.nextjsInvalidation,
      ...this.props.overrides?.nextjsGlobalFunctions?.nextjsInvalidationProps,
    });
  }
}
