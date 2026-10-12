import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, RemovalPolicy, Token } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  BucketProps,
  IBucket,
} from "aws-cdk-lib/aws-s3";
import {
  BucketDeployment,
  BucketDeploymentProps,
  CacheControl,
  Source,
} from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { LOG_PREFIX } from "./constants";
import { normalizeBasePath } from "./utils/base-path";

/**
 * The S3 object key pattern covering every static asset uploaded under
 * `keyPrefix` (`NextjsStaticAssets.keyPrefix`): `"base/*"`, or `"*"` at the
 * bucket root. For scoping the compute's read grant to the app's own objects
 * when several apps share one bucket.
 */
export function staticAssetsObjectsPattern(keyPrefix?: string): string {
  if (keyPrefix && Token.isUnresolved(keyPrefix)) {
    return "*";
  }
  const prefix = normalizeBasePath(keyPrefix);
  return prefix ? `${prefix}/*` : "*";
}

export interface NextjsStaticAssetsOverrides {
  readonly bucketProps?: BucketProps;
  /**
   * Applied to both uploads, `public/` and `_next/static/`, except that
   * `_next/static/` always keeps its year-long `immutable` `Cache-Control`. So a
   * `cacheControl` here sets the header for `public/` files only, while
   * anything else, such as `sources` or a `distribution` to invalidate, applies
   * to each upload in turn.
   */
  readonly bucketDeploymentProps?: BucketDeploymentProps;
}

export interface NextjsStaticAssetsProps {
  /**
   * Bring your own S3 bucket for static assets. When provided, cdk-nextjs
   * will skip creating a new bucket and deploy assets to this bucket instead.
   * Can be shared only between deployments with different `basePath`s (S3 key
   * prefixes): pruning is scoped to `<basePath>/_next/`, but two deployments
   * under the same prefix overwrite each other's `public/` files and prune each
   * other's older `_next/` assets.
   */
  readonly bucket?: IBucket;
  /**
   * Directory where the Next.js application is located.
   * This should contain the .next directory and other build artifacts.
   */
  readonly buildDirectory: string;
  /**
   * Build ID from NextjsBuild to track asset versions
   */
  readonly buildId: string;
  /**
   * Prefix to the URI path the app will be served at.
   * @example "/my-base-path"
   */
  readonly basePath?: string;
  readonly overrides?: NextjsStaticAssetsOverrides;
}

/**
 * Creates S3 Bucket for public and _next/static assets and deploys them using S3Deployment.
 */
export class NextjsStaticAssets extends Construct {
  bucket: IBucket;
  /**
   * `staticDeployment`, or `publicDeployment` for a build without `.next/static`.
   *
   * @deprecated The assets are uploaded by up to two deployments. Use
   * `staticDeployment` and `publicDeployment`.
   */
  deployment: BucketDeployment;
  /**
   * Uploads `.next/static` to `_next/static/` with
   * `Cache-Control: public, max-age=31536000, immutable`. Absent if the build
   * has no `.next/static`.
   */
  readonly staticDeployment?: BucketDeployment;
  /**
   * Uploads `public/`, separately from `staticDeployment` because its files
   * keep their names when they change and so can't be `immutable`. Absent if
   * the build has no `public` directory.
   */
  readonly publicDeployment?: BucketDeployment;
  /**
   * S3 key prefix the assets are actually uploaded under, normalized to a bare
   * path segment (empty when they live at the bucket root).
   *
   * Consumers that read assets back out of the bucket (the runtime's image
   * optimizer, `NextjsApi`'s S3 integrations) must use this rather than the
   * `basePath` prop, since `overrides.bucketDeploymentProps` can replace the
   * prefix outright. Nor can they derive it from the app's own `basePath`: that
   * is the prefix of the *URL* the app is served at, which for the API Gateway
   * deployment types is the stage name and has nothing to do with where the
   * bytes were uploaded.
   */
  readonly keyPrefix: string;

  private props: NextjsStaticAssetsProps;

  constructor(scope: Construct, id: string, props: NextjsStaticAssetsProps) {
    super(scope, id);
    this.props = props;
    this.keyPrefix = this.resolveKeyPrefix();
    this.bucket = props.bucket ?? this.createBucket();
    const staticDir = this.stageDirectory(
      join(props.buildDirectory, ".next", "static"),
      join("_next", "static"),
    );
    const publicDir = this.stageDirectory(join(props.buildDirectory, "public"));
    if (!staticDir && !publicDir) {
      throw new Error(
        `No static assets found to deploy. Ensure your Next.js build output contains either:
        - A 'public' directory at: ${join(props.buildDirectory, "public")}
        - A '.next/static' directory at: ${join(props.buildDirectory, ".next", "static")}`,
      );
    }
    // `_next/static/` files are content-hashed, so they get the same header
    // Next.js sends for them. Nothing else would: CloudFront and API Gateway
    // serve them straight from S3, where the object's metadata is the only
    // `Cache-Control` there is. A `BucketDeployment`'s `cacheControl` applies to
    // every object it uploads, hence two.
    this.staticDeployment = staticDir
      ? this.createDeployment("Deployment", staticDir, [
          CacheControl.setPublic(),
          CacheControl.maxAge(Duration.days(365)),
          CacheControl.immutable(),
        ])
      : undefined;
    this.publicDeployment = publicDir
      ? this.createDeployment("PublicDeployment", publicDir)
      : undefined;
    this.deployment = (this.staticDeployment ?? this.publicDeployment)!;
  }

  /**
   * Resolves the single prefix both the upload and the URLs use. A
   * `bucketDeploymentProps.destinationKeyPrefix` override wins over `basePath`,
   * but it's normalized here and `createDeployment` sets the normalized value
   * after the override spread, so `keyPrefix` can't drift from where the assets
   * land.
   *
   * Compared against `undefined` rather than tested with `in`, because a JSII
   * language binding (or a programmatically built props object) can materialize
   * an unset optional field as an explicit `undefined`. Treating that as an
   * intentional "move the assets to the bucket root" override would silently
   * drop `basePath` from the prefix.
   */
  private resolveKeyPrefix(): string {
    const deploymentOverrides = this.props.overrides?.bucketDeploymentProps;
    const prefix =
      deploymentOverrides?.destinationKeyPrefix !== undefined
        ? deploymentOverrides.destinationKeyPrefix
        : this.props.basePath;
    return normalizeBasePath(prefix);
  }

  private createBucket() {
    return new Bucket(this, "Bucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      minimumTLSVersion: 1.2,
      ...this.props.overrides?.bucketProps,
    });
  }

  private createDeployment(
    id: string,
    stagingDir: string,
    cacheControl?: CacheControl[],
  ) {
    return new BucketDeployment(this, id, {
      sources: [Source.asset(stagingDir)],
      destinationBucket: this.bucket,
      // Add BUILD_ID as metadata to all objects for version tracking
      metadata: {
        BUILD_ID: this.props.buildId,
      },
      prune: false, // Don't delete existing assets to prevent 404s during deployment, pruning will be handled by post-deploy
      // S3Deployment automatically detects content types based on file extensions
      ...this.props.overrides?.bucketDeploymentProps,
      ...(cacheControl && { cacheControl }),
      // Set after the spread: `resolveKeyPrefix` already folded in any
      // `destinationKeyPrefix` override, so this is the normalized form of it.
      // Letting the raw override through here would upload the assets somewhere
      // other than the `keyPrefix` used to build their URLs.
      destinationKeyPrefix: this.keyPrefix || undefined,
    });
  }

  /**
   * Copies `sourceDir` to `<staging>/<subPath>` in a new staging directory, or
   * returns `undefined` if there is no `sourceDir`. Staged under `subPath`
   * rather than uploaded with a longer `destinationKeyPrefix`, so every
   * deployment shares the one prefix `keyPrefix` resolves.
   */
  private stageDirectory(
    sourceDir: string,
    subPath: string = "",
  ): string | undefined {
    if (!this.directoryExists(sourceDir)) {
      return undefined;
    }
    const stagingDir = mkdtempSync(join(tmpdir(), "nextjs-assets-"));
    try {
      const destDir = join(stagingDir, subPath);
      mkdirSync(destDir, { recursive: true });
      cpSync(sourceDir, destDir, { recursive: true });
      return stagingDir;
    } catch (error) {
      // Thrown rather than skipped, which would deploy without these assets.
      rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`${LOG_PREFIX} Could not stage ${sourceDir} for upload`, {
        cause: error,
      });
    }
  }

  /**
   * Check if a directory exists
   */
  private directoryExists(dirPath: string): boolean {
    try {
      return existsSync(dirPath) && statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }
}
