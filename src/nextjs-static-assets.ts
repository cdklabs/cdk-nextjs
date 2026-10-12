import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
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

/** Where `.next/static` is served from, relative to `keyPrefix`. */
const STATIC_PATH = join("_next", "static");
/** Where Next.js compiles service workers to, relative to `.next/static`. */
const SERVICE_WORKER_DIR = "service-worker";

/**
 * Every non-directory entry under `dir`, relative to it. Symlinks count:
 * `cpSync` copies them as links, and they upload as the files they point to.
 *
 * An explicit walk rather than `readdirSync({ recursive: true })`, which on
 * Node 24 descends into symlinked directories and so never returns on a cycle,
 * and whose `Dirent.parentPath` doesn't exist before Node 20.12.
 */
function listFiles(dir: string): string[] {
  const files: string[] = [];
  const pending = [""];
  for (let sub = pending.pop(); sub !== undefined; sub = pending.pop()) {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const path = join(sub, entry.name);
      (entry.isDirectory() ? pending : files).push(path);
    }
  }
  return files;
}

/** Whether the relative `path` is `dir` or inside it. */
function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

export interface NextjsStaticAssetsOverrides {
  readonly bucketProps?: BucketProps;
  /**
   * Applied to every upload (`public/`, `_next/static/` and
   * `_next/static/service-worker/`), except that the two `_next/static` uploads
   * always keep the `Cache-Control` Next.js sends for them. So a `cacheControl`
   * here sets the header for `public/` files only, while anything else, such as
   * a `distribution` to invalidate, applies to each upload in turn. `prune:
   * true`, `sources`, and `retainOnDelete: false` with a `bucket` passed in are
   * rejected, since each would break the other uploads.
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
   * The first of `staticDeployment`, `serviceWorkerDeployment` and
   * `publicDeployment` the build has files for.
   *
   * @deprecated The assets are uploaded by up to three deployments, and this
   * is only one of them: a dependency on it doesn't wait for the others. Use
   * `staticDeployment`, `serviceWorkerDeployment` and `publicDeployment`.
   */
  deployment: BucketDeployment;
  /**
   * Uploads `.next/static` to `_next/static/` with
   * `Cache-Control: public, max-age=31536000, immutable`, except for
   * `service-worker/` (see `serviceWorkerDeployment`). Absent if the build has
   * no `.next/static`.
   */
  readonly staticDeployment?: BucketDeployment;
  /**
   * Uploads `.next/static/service-worker` with
   * `Cache-Control: public, max-age=0, must-revalidate`, as Next.js serves it:
   * a service worker keeps its URL across builds, so it can't be `immutable`.
   * Absent if the build has no service worker.
   */
  readonly serviceWorkerDeployment?: BucketDeployment;
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
    this.validateDeploymentOverrides();
    this.keyPrefix = this.resolveKeyPrefix();
    this.bucket = props.bucket ?? this.createBucket();
    const builtDir = join(props.buildDirectory, ".next", "static");
    const publicSourceDir = join(props.buildDirectory, "public");
    // Only a directory is uploaded as service workers, so only a directory is
    // left out here.
    const hasServiceWorkers = this.directoryExists(
      join(builtDir, SERVICE_WORKER_DIR),
    );
    const staticDir = this.stageDirectory(
      builtDir,
      STATIC_PATH,
      (path) => !hasServiceWorkers || !isWithin(path, SERVICE_WORKER_DIR),
    );
    const serviceWorkerDir = this.stageDirectory(
      join(builtDir, SERVICE_WORKER_DIR),
      join(STATIC_PATH, SERVICE_WORKER_DIR),
    );
    // A `public/_next/static` file with a built file's name would land on the
    // same key. `next start` serves the built one, so the public copy is left
    // out; uploading both would leave whichever deployment finished last.
    // Other `public/_next/static` files are served as `next start` does.
    // Matched against a listing rather than with `existsSync`, which on macOS
    // and Windows would let `Legacy.js` shadow `legacy.js`: Next.js and S3 keys
    // are case-sensitive.
    const builtFiles = new Set(
      this.directoryExists(builtDir) ? listFiles(builtDir) : [],
    );
    const publicDir = this.stageDirectory(
      publicSourceDir,
      "",
      (path) =>
        !isWithin(path, STATIC_PATH) ||
        !builtFiles.has(relative(STATIC_PATH, path)),
    );
    if (!staticDir && !serviceWorkerDir && !publicDir) {
      throw new Error(
        `No static assets found to deploy. Ensure your Next.js build output contains files in either:
        - A 'public' directory at: ${publicSourceDir}
        - A '.next/static' directory at: ${builtDir}`,
      );
    }
    // `_next/static/` files are content-hashed, so they get the same header
    // Next.js sends for them. Nothing else would: CloudFront and API Gateway
    // serve them straight from S3, where the object's metadata is the only
    // `Cache-Control` there is. A `BucketDeployment`'s `cacheControl` applies to
    // every object it uploads, hence one deployment per header.
    this.staticDeployment = staticDir
      ? this.createDeployment("Deployment", staticDir, [
          CacheControl.setPublic(),
          CacheControl.maxAge(Duration.days(365)),
          CacheControl.immutable(),
        ])
      : undefined;
    this.serviceWorkerDeployment = serviceWorkerDir
      ? this.createDeployment("ServiceWorkerDeployment", serviceWorkerDir, [
          CacheControl.setPublic(),
          CacheControl.maxAge(Duration.seconds(0)),
          CacheControl.mustRevalidate(),
        ])
      : undefined;
    this.publicDeployment = publicDir
      ? this.createDeployment("PublicDeployment", publicDir)
      : undefined;
    this.deployment = (this.staticDeployment ??
      this.serviceWorkerDeployment ??
      this.publicDeployment)!;
  }

  /**
   * Rejects the `bucketDeploymentProps` that can't work across several
   * deployments sharing one prefix. Each is spread into every one of them:
   *
   * - `prune: true` makes each deployment's `s3 sync --delete` remove the files
   *   the others uploaded.
   * - `sources` replaces the build's assets in every deployment, which then
   *   race to upload the same files with different `Cache-Control`.
   * - `retainOnDelete: false` on a bucket passed in: CDK only skips its
   *   `s3 rm --recursive` of the prefix for a bucket it tagged, and it can't
   *   tag an imported one. So when a build stops having files for one of the
   *   deployments, removing it deletes the others' files too.
   *
   * Compared against the exact value, as with `destinationKeyPrefix`, so an
   * explicit `undefined` from a JSII binding is not mistaken for an override.
   */
  private validateDeploymentOverrides() {
    const overrides = this.props.overrides?.bucketDeploymentProps;
    const rejected = [
      overrides?.prune === true &&
        "`prune: true` (old assets are pruned after deploy by NextjsPostDeploy, once they are past its TTL)",
      overrides?.sources !== undefined &&
        "`sources` (add your own BucketDeployment for extra files)",
      this.props.bucket &&
        overrides?.retainOnDelete === false &&
        "`retainOnDelete: false` with a bucket passed in",
    ].filter((reason): reason is string => !!reason);
    if (rejected.length > 0) {
      throw new Error(
        `${LOG_PREFIX} overrides.bucketDeploymentProps can't set ${rejected.join(", or ")}: ` +
          "the static assets are uploaded by one deployment per Cache-Control, " +
          "and each of these would break the others.",
      );
    }
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
      destinationBucket: this.bucket,
      // Add BUILD_ID as metadata to all objects for version tracking
      metadata: {
        BUILD_ID: this.props.buildId,
      },
      // S3Deployment automatically detects content types based on file extensions
      ...this.props.overrides?.bucketDeploymentProps,
      // Set after the spread, which `validateDeploymentOverrides` only lets set
      // these to what they already are, or to an explicit `undefined` from a
      // JSII binding. That would drop the build's assets, or turn on CDK's
      // default `prune: true`.
      sources: [Source.asset(stagingDir)],
      prune: false, // Don't delete existing assets to prevent 404s during deployment, pruning will be handled by post-deploy
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
   * returns `undefined` if there is no `sourceDir` or no file in it passes
   * `include`. Staged under `subPath` rather than uploaded with a longer
   * `destinationKeyPrefix`, so every deployment shares the one prefix
   * `keyPrefix` resolves. `include` gets each entry's path relative to
   * `sourceDir`.
   */
  private stageDirectory(
    sourceDir: string,
    subPath: string,
    include: (path: string) => boolean = () => true,
  ): string | undefined {
    if (!this.directoryExists(sourceDir)) {
      return undefined;
    }
    const stagingDir = mkdtempSync(join(tmpdir(), "nextjs-assets-"));
    try {
      const destDir = join(stagingDir, subPath);
      mkdirSync(destDir, { recursive: true });
      cpSync(sourceDir, destDir, {
        recursive: true,
        filter: (path) => include(relative(sourceDir, path)),
      });
      if (listFiles(destDir).length === 0) {
        rmSync(stagingDir, { recursive: true, force: true });
        return undefined;
      }
      return stagingDir;
    } catch (error) {
      // Thrown rather than skipped, which would deploy without these assets.
      // The cleanup's own failure must not replace that error.
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
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
