import { join } from "path/posix";
import { CustomResource, Duration } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { AccessPoint } from "aws-cdk-lib/aws-efs";
import {
  Architecture,
  DockerImageCode,
  DockerImageFunction,
  FileSystem,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import {
  DATA_CACHE_DIR,
  FULL_ROUTE_CACHE_DIR,
  IMAGE_CACHE_DIR,
  NextjsType,
  PUBLIC_DIR,
} from "./common";
import { OptionalDockerImageFunctionProps } from "./generated-structs/OptionalDockerImageFunctionProps";
import { NextjsBuild } from "./nextjs-build/nextjs-build";
import { NextjsBaseProps } from "./root-constructs/nextjs-base-props";

export interface NextjsAssetDeploymentOverrides {
  readonly dockerImageFunctionProps?: OptionalDockerImageFunctionProps;
}

export interface NextjsAssetsDeploymentProps {
  readonly accessPoint: AccessPoint;
  /**
   * @see {@link NextjsBuild.buildImageDigest}
   */
  readonly buildImageDigest: string;
  /**
   * @see {@link NextjsBuild.containerMountPathForEfs}
   */
  readonly containerMountPathForEfs: NextjsBuild["containerMountPathForEfs"];
  /**
   * @default true
   */
  readonly debug?: boolean;
  readonly dockerImageCode: DockerImageCode; // TODO: remove and build from common builder base?
  readonly nextjsType: NextjsType;
  readonly overrides?: NextjsAssetDeploymentOverrides;
  /**
   * @see {@link NextjsBaseProps.relativePathToWorkspace}
   */
  readonly relativePathToWorkspace?: string;
  /**
   * Required for `NextjsType.GlobalFunctions` and `NextjsType.GlobalContainers`
   */
  readonly staticAssetsBucket?: Bucket;
  readonly vpc: IVpc;
}

/**
 * @internal
 */
export interface FsToS3Action {
  type: "fs-to-s3";
  destinationBucketName: string;
  destinationKeyPrefix?: string;
  sourcePath: string;
}
/**
 * @internal
 */
export interface FsToFsAction {
  type: "fs-to-fs";
  sourcePath: string;
  destinationPath: string;
}
/**
 * @internal
 */
export interface PruneS3Action {
  type: "prune-s3";
  /**
   * The minimum previous deployment count to prune
   * @default 3
   */
  minPreviousDeployCountToPrune: number;
  /**
   * The minimum previous deployment date to prune
   * @default new Date(new Date().setMonth(new Date().getMonth() - 1))
   */
  minPreviousDeployDateToPrune: string;
  bucketName: string;
  bucketPrefix?: string;
}
/**
 * @internal
 */
export interface PruneFsAction {
  type: "prune-fs";
  /**
   * The minimum previous deployment count to prune
   * @default 3
   */
  minPreviousDeployCountToPrune: number;
  /**
   * The minimum previous deployment date to prune
   * @default new Date(new Date().setMonth(new Date().getMonth() - 1))
   */
  minPreviousDeployDateToPrune: string;
  directory: string;
}

/**
 * @internal
 */
export interface CustomResourceProperties {
  actions: (FsToS3Action | FsToFsAction | PruneS3Action | PruneFsAction)[];
  /**
   * {@link NextjsAssetDeploymentProps.builderImageDigest}
   */
  buildImageDigest: string;
  imageCachePath: string;
  prerenderManifestPath: string;
  nextjsType: NextjsType;
}

/**
 * Deploys static assets to S3 and cache assets to EFS in Lambda Custom Resource.
 */
export class NextjsAssetsDeployment extends Construct {
  customResource: CustomResource;
  dockerImageFunction: DockerImageFunction;
  /**
   * Only used for `NextjsGlobalFunctions`
   */
  previewModeId: string;

  private props: NextjsAssetsDeploymentProps;

  constructor(
    scope: Construct,
    id: string,
    props: NextjsAssetsDeploymentProps,
  ) {
    super(scope, id);
    this.props = props;
    this.dockerImageFunction = this.createFunction();
    this.customResource = this.createCustomResource();
    this.previewModeId = this.customResource.getAttString("previewModeId");
  }

  private createFunction() {
    let architecture: Architecture | undefined = undefined;
    if (process.arch === "x64") {
      architecture = Architecture.X86_64;
    } else if (process.arch === "arm64") {
      architecture = Architecture.ARM_64;
    }
    const fn = new DockerImageFunction(this, "Fn", {
      architecture,
      code: this.props.dockerImageCode,
      memorySize: 2048,
      filesystem: FileSystem.fromEfsAccessPoint(
        this.props.accessPoint,
        this.props.containerMountPathForEfs,
      ),
      vpc: this.props.vpc,
      timeout: Duration.minutes(5),
      ...this.props.overrides?.dockerImageFunctionProps,
    });
    if (this.props.debug !== false) {
      fn.addEnvironment("DEBUG", "1");
    }
    if (this.props.staticAssetsBucket) {
      this.props.staticAssetsBucket.grantReadWrite(fn);
    }
    return fn;
  }

  private createCustomResource() {
    const root = "/app";
    const actions: CustomResourceProperties["actions"] = [];
    if (this.props.staticAssetsBucket?.bucketName) {
      actions.push(
        // static files
        {
          type: "fs-to-s3",
          sourcePath: join(root, ".next", "static"),
          destinationBucketName: this.props.staticAssetsBucket.bucketName,
          destinationKeyPrefix: "_next/static",
        },
      );
    }
    actions.push(
      // data cache - https://nextjs.org/docs/app/building-your-application/caching#data-cache
      {
        type: "fs-to-fs",
        sourcePath: join(root, ".next", "cache", "fetch-cache"),
        destinationPath: join(
          this.props.containerMountPathForEfs,
          DATA_CACHE_DIR,
        ),
      },
      // full route cache - https://nextjs.org/docs/app/building-your-application/caching#full-route-cache
      {
        type: "fs-to-fs",
        sourcePath: join(
          root,
          ".next",
          "standalone",
          this.props.relativePathToWorkspace || "",
          ".next",
          "server",
          "app",
        ),
        destinationPath: join(
          this.props.containerMountPathForEfs,
          FULL_ROUTE_CACHE_DIR,
        ),
      },
      // public dir
      {
        type: "fs-to-fs",
        sourcePath: join(root, "public"),
        destinationPath: join(this.props.containerMountPathForEfs, PUBLIC_DIR),
      },
      // images are optimized at runtime so nothing to deploy
    );
    const properties: CustomResourceProperties = {
      actions,
      buildImageDigest: this.props.buildImageDigest,
      imageCachePath: join(
        this.props.containerMountPathForEfs,
        IMAGE_CACHE_DIR,
      ),
      nextjsType: this.props.nextjsType,
      prerenderManifestPath: join(root, ".next", "prerender-manifest.json"),
    };
    return new CustomResource(this, "CustomResource", {
      properties,
      resourceType: "Custom::NextjsAssetsDeployment",
      serviceToken: this.dockerImageFunction.functionArn,
    });
  }
}
