import { join } from "path/posix";
import { CustomResource, Duration } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { AccessPoint } from "aws-cdk-lib/aws-efs";
import {
  DockerImageCode,
  DockerImageFunction,
  FileSystem,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import {
  DATA_CACHE_PATH,
  FULL_ROUTE_CACHE_PATH,
  IMAGE_CACHE_PATH,
  MOUNT_PATH,
  NextjsType,
  PUBLIC_PATH,
  STATIC_PATH,
} from "./constants";
import { OptionalCustomResourceProps } from "./generated-structs/OptionalCustomResourceProps";
import { OptionalDockerImageFunctionProps } from "./generated-structs/OptionalDockerImageFunctionProps";
import { NextjsBuild } from "./nextjs-build/nextjs-build";
import { NextjsBaseProps } from "./root-constructs/nextjs-base-props";
import { getLambdaArchitecture } from "./utils/get-architecture";

export interface NextjsAssetDeploymentOverrides {
  /**
   * Props that define the custom resource
   */
  readonly customResourceProps?: OptionalCustomResourceProps;
  // NOTE: we don't offer overriding `customResourceProperties` since jsii doesn't support union types
  // readonly customResourceProperties?: OptionalStaticAssetsCustomResourceProperties
  readonly dockerImageFunctionProps?: OptionalDockerImageFunctionProps;
}

export interface NextjsAssetsDeploymentProps {
  readonly accessPoint: AccessPoint;
  /**
   * Prefix to the URI path the app will be served at.
   * @example "/my-base-path"
   */
  readonly basePath?: string;
  readonly buildId: string;
  /**
   * @see {@link NextjsBuild.buildImageDigest}
   */
  readonly buildImageDigest: string;
  /**
   * If true, logs details in custom resource lambda
   * @default true
   */
  readonly debug?: boolean;
  readonly dockerImageCode: DockerImageCode; // TODO: remove and build from common builder base?
  readonly nextjsType: NextjsType;
  readonly overrides?: NextjsAssetDeploymentOverrides;
  /**
   * @see {@link NextjsBaseProps.relativePathToPackage}
   */
  readonly relativePathToPackage?: string;
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
  includeExtensions?: string[];
}

/**
 * @internal
 */
export interface StaticAssetsCustomResourceProperties {
  actions: (FsToS3Action | FsToFsAction)[];
  buildId: string;
  /**
   * @see {@link NextjsBuild.buildImageDigest}
   */
  buildImageDigest: string;
  imageCachePath: string;
  nextjsType: NextjsType;
}

/**
 * Deploys static assets to S3 and cache assets to EFS in Lambda Custom Resource.
 */
export class NextjsAssetsDeployment extends Construct {
  customResource: CustomResource;
  dockerImageFunction: DockerImageFunction;

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
  }

  private createFunction() {
    const fn = new DockerImageFunction(this, "Fn", {
      architecture: getLambdaArchitecture(),
      code: this.props.dockerImageCode,
      memorySize: 2048,
      filesystem: FileSystem.fromEfsAccessPoint(
        this.props.accessPoint,
        MOUNT_PATH,
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
    const actions: StaticAssetsCustomResourceProperties["actions"] = [];
    if (this.props.staticAssetsBucket?.bucketName) {
      // Prepare the destination key prefix with basePath when available
      const staticKeyPrefix = this.props.basePath
        ? `${this.props.basePath.replace(/^\//, "")}/_next/static`
        : "_next/static";

      actions.push(
        // static files
        {
          type: "fs-to-s3",
          sourcePath: join(root, STATIC_PATH),
          destinationBucketName: this.props.staticAssetsBucket.bucketName,
          destinationKeyPrefix: staticKeyPrefix,
        },
        // public directory to s3 for CloudFront -> S3
        {
          type: "fs-to-s3",
          sourcePath: join(root, PUBLIC_PATH),
          destinationBucketName: this.props.staticAssetsBucket.bucketName,
        },
      );
    }
    actions.push(
      // full route cache - https://nextjs.org/docs/app/building-your-application/caching#full-route-cache
      {
        type: "fs-to-fs",
        sourcePath: join(
          root,
          ".next",
          "standalone",
          this.props.relativePathToPackage || "",
          FULL_ROUTE_CACHE_PATH,
        ),
        destinationPath: join(
          MOUNT_PATH,
          this.props.buildId,
          FULL_ROUTE_CACHE_PATH,
        ),
        // only files with these extensions are needed in EFS FileSystem cache
        // since these files are the only ones updated by Next.js during runtime.
        // other files like .js and .nft.json files are static per deployment
        includeExtensions: ["body", "html", "rsc", "meta"],
      },
      // after `next build` data cache https://nextjs.org/docs/app/building-your-application/caching#data-cache
      // exists at top level .next/cache so we need to copy into relativePathToPackage
      // normalized path
      {
        type: "fs-to-fs",
        sourcePath: join(root, DATA_CACHE_PATH),
        destinationPath: join(MOUNT_PATH, this.props.buildId, DATA_CACHE_PATH),
      },
      // public directory to EFS for needed optimizing images in public directory
      // we don't load these into compute to save on image size
      {
        type: "fs-to-fs",
        sourcePath: join(root, PUBLIC_PATH),
        destinationPath: join(MOUNT_PATH, this.props.buildId, PUBLIC_PATH),
      },
      // images are optimized at runtime so nothing to deploy
    );
    const properties: StaticAssetsCustomResourceProperties = {
      actions,
      buildId: this.props.buildId,
      // ensures this CR runs each time new builder image
      buildImageDigest: this.props.buildImageDigest,
      imageCachePath: join(MOUNT_PATH, this.props.buildId, IMAGE_CACHE_PATH),
      nextjsType: this.props.nextjsType,
    };
    return new CustomResource(this, "CustomResource", {
      properties,
      resourceType: "Custom::NextjsAssetsDeployment",
      serviceToken: this.dockerImageFunction.functionArn,
      ...this.props.overrides?.customResourceProps,
    });
  }
}
