import { Construct } from "constructs";
import { NextjsType } from "../constants";
import { OptionalNextjsAssetsDeploymentProps } from "../generated-structs/OptionalNextjsAssetsDeploymentProps";
import { OptionalNextjsBuildProps } from "../generated-structs/OptionalNextjsBuildProps";
import { OptionalNextjsFileSystemProps } from "../generated-structs/OptionalNextjsFileSystemProps";
import { OptionalNextjsPostDeployProps } from "../generated-structs/OptionalNextjsPostDeployProps";
import { OptionalNextjsVpcProps } from "../generated-structs/OptionalNextjsVpcProps";
import {
  NextjsAssetsDeployment,
  NextjsAssetDeploymentOverrides,
} from "../nextjs-assets-deployment";
import {
  NextjsBuild,
  NextjsBuildOverrides,
} from "../nextjs-build/nextjs-build";
import {
  NextjsFileSystem,
  NextjsFileSystemOverrides,
} from "../nextjs-file-system";
import {
  NextjsPostDeploy,
  NextjsPostDeployOverrides,
} from "../nextjs-post-deploy";
import {
  NextjsStaticAssets,
  NextjsStaticAssetsOverrides,
  NextjsStaticAssetsProps,
} from "../nextjs-static-assets";
import { NextjsVpc, NextjsVpcOverrides } from "../nextjs-vpc";
import { handleDeprecatedProperties } from "../utils/handle-deprecated-properties";

/**
 * Base overrides for the props passed to constructs within root/top-level Next.js constructs
 */
export interface BaseNextjsConstructOverrides {
  readonly nextjsBuildProps?: OptionalNextjsBuildProps;
  readonly nextjsVpcProps?: OptionalNextjsVpcProps;
  readonly nextjsFileSystemProps?: OptionalNextjsFileSystemProps;
  readonly nextjsAssetsDeploymentProps?: OptionalNextjsAssetsDeploymentProps;
  readonly nextjsPostDeployProps?: OptionalNextjsPostDeployProps;
  readonly nextjsStaticAssetsProps?: NextjsStaticAssetsProps;
}

/**
 * Base overrides for constructs shared between all root/top-level Next.js constructs.
 */
export interface BaseNextjsOverrides {
  readonly nextjsBuild?: NextjsBuildOverrides;
  readonly nextjsFileSystem?: NextjsFileSystemOverrides;
  readonly nextjsVpc?: NextjsVpcOverrides;
  readonly nextjsAssetsDeployment?: NextjsAssetDeploymentOverrides;
  readonly nextjsPostDeploy?: NextjsPostDeployOverrides;
  readonly nextjsStaticAssets?: NextjsStaticAssetsOverrides;
}

export interface NextjsBaseProps {
  /**
   * Prefix to the URI path the app will be served at.
   * @example "/my-base-path"
   */
  readonly basePath?: string;
  /**
   * Command to generate optimized version of your Next.js app in container;
   * @default "npm run build"
   */
  readonly buildCommand?: string;
  /**
   * [Build context](https://docs.docker.com/build/building/context/) for
   * `docker build`. This directory should contain your lockfile (i.e.
   * pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then
   * this will be the same directory as your Next.js app. If you are in a
   * monorepo, then this value should be the root of your monorepo. You then
   * must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToPackage}
   *
   * Note, by default cdk-nextjs' `builder.Dockerfile` is used to build your
   * Next.js app. You can customize this by specifying `overrides.{nextjs...}.nextjsBuildProps.builderImageProps.file`.
   * If you override the default, then you are responsible for ensuring the
   * Dockerfile is in the build context directory before cdk-nextjs construct
   * is instantiated.
   * @example join(import.meta.dirname, "..") (monorepo)
   */
  readonly buildContext: string;
  /**
   * Path to API Route Handler that returns HTTP 200 to ensure compute health.
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
   * Use this if building in monorepo. This is the relative path from
   * {@link NextjsBaseProps.buildContext} or root workspace to nested package
   * containing Next.js app. See example below:
   *
   * Let's say you have a monorepo with the following folder structure:
   * - my-monorepo/
   *   - packages/
   *     - ui/
   *       - package.json (nested)
   *   - package.json (root)
   *
   * And your Next.js app directory is the ui folder. Then you would set {@link NextjsBaseProps.buildContext}
   * to `"/absolute/path/to/my-monorepo"` and {@link NextjsBaseProps.relativePathToPackage}
   * to `"./packages/ui"`.
   *
   * Note, setting {@link NextjsBaseProps.buildContext} to the root of your
   * monorepo will invalidate container runtime (i.e. docker) build cache when any file is
   * changed in your monorepo. This is slows down deployments. Checkout how you
   * can use [turbo](https://turbo.build/) in [Deploying with Docker Guide](https://turbo.build/repo/docs/handbook/deploying-with-docker)
   * in the cdk-nextjs/examples/turbo.
   *
   * @example "./packages/ui"
   */
  readonly relativePathToPackage?: string;
  /**
   * @deprecated use relativePathToPackage
   */
  readonly relativePathToWorkspace?: string;
}

/**
 * Base class for all Next.js root constructs
 */
export abstract class NextjsBaseConstruct extends Construct {
  nextjsBuild: NextjsBuild;
  nextjsStaticAssets: NextjsStaticAssets;
  nextjsVpc: NextjsVpc;
  nextjsFileSystem: NextjsFileSystem;
  nextjsAssetsDeployment: NextjsAssetsDeployment;
  nextjsPostDeploy: NextjsPostDeploy;

  abstract get url(): string;

  protected readonly nextjsType: NextjsType;
  // use baseProps instead of props so that child classes can use props
  protected readonly baseProps: NextjsBaseProps;
  protected readonly overrides?: BaseNextjsOverrides;
  protected readonly constructOverrides?: BaseNextjsConstructOverrides;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsBaseProps,
    nextjsType: NextjsType,
    overrides?: BaseNextjsOverrides,
    constructOverrides?: BaseNextjsConstructOverrides,
  ) {
    super(scope, id);
    this.baseProps = handleDeprecatedProperties(props);
    this.nextjsType = nextjsType;
    this.overrides = overrides;
    this.constructOverrides = constructOverrides;

    this.nextjsBuild = this.createNextjsBuild();
    this.nextjsStaticAssets = this.createNextjsStaticAssets();
    this.nextjsVpc = this.createVpc();
    this.nextjsFileSystem = this.createNextjsFileSystem();
    this.nextjsAssetsDeployment = this.createNextjsAssetsDeployment();
    this.nextjsPostDeploy = this.createNextjsPostDeploy();
  }

  protected createNextjsBuild(): NextjsBuild {
    return new NextjsBuild(this, "NextjsBuild", {
      buildCommand: this.baseProps.buildCommand,
      buildContext: this.baseProps.buildContext,
      nextjsType: this.nextjsType,
      relativePathToPackage: this.baseProps.relativePathToPackage,
      overrides: this.overrides?.nextjsBuild,
      ...this.constructOverrides?.nextjsBuildProps,
    });
  }

  protected createNextjsStaticAssets(): NextjsStaticAssets {
    return new NextjsStaticAssets(this, "NextjsStaticAssets", {
      overrides: this.overrides?.nextjsStaticAssets,
      ...this.constructOverrides?.nextjsStaticAssetsProps,
    });
  }

  protected createVpc(): NextjsVpc {
    return new NextjsVpc(this, "NextjsVpc", {
      nextjsType: this.nextjsType,
      overrides: this.overrides?.nextjsVpc,
      ...this.constructOverrides?.nextjsVpcProps,
    });
  }

  protected createNextjsFileSystem(): NextjsFileSystem {
    return new NextjsFileSystem(this, "NextjsFileSystem", {
      vpc: this.nextjsVpc.vpc,
      overrides: this.overrides?.nextjsFileSystem,
      ...this.constructOverrides?.nextjsFileSystemProps,
    });
  }

  protected createNextjsAssetsDeployment(): NextjsAssetsDeployment {
    return new NextjsAssetsDeployment(this, "NextjsAssetsDeployment", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      basePath: (this.baseProps as any).basePath,
      buildId: this.nextjsBuild.buildId,
      buildImageDigest: this.nextjsBuild.buildImageDigest,
      dockerImageCode: this.nextjsBuild.imageForNextjsAssetsDeployment,
      nextjsType: this.nextjsType,
      overrides: this.overrides?.nextjsAssetsDeployment,
      relativePathToPackage: this.baseProps.relativePathToPackage,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      vpc: this.nextjsVpc.vpc,
      ...this.constructOverrides?.nextjsAssetsDeploymentProps,
    });
  }

  protected createNextjsPostDeploy(): NextjsPostDeploy {
    const nextjsPostDeploy = new NextjsPostDeploy(this, "NextjsPostDeploy", {
      accessPoint: this.nextjsFileSystem.accessPoint,
      buildId: this.nextjsBuild.buildId,
      buildImageDigest: this.nextjsBuild.buildImageDigest,
      overrides: this.overrides?.nextjsPostDeploy,
      relativePathToPackage: this.baseProps.relativePathToPackage,
      staticAssetsBucket: this.nextjsStaticAssets.bucket,
      vpc: this.nextjsVpc.vpc,
      ...this.constructOverrides?.nextjsPostDeployProps,
    });
    // ensure NextjsAssetsDeployment finishes before NextjsPostDeploy
    nextjsPostDeploy.node.addDependency(this.nextjsAssetsDeployment);
    return nextjsPostDeploy;
  }
}
