import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RemovalPolicy, Size } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  TableV2,
  TablePropsV2,
  ITableV2,
} from "aws-cdk-lib/aws-dynamodb";
import {
  Bucket,
  BucketEncryption,
  BucketProps,
  BlockPublicAccess,
  IBucket,
} from "aws-cdk-lib/aws-s3";
import {
  BucketDeployment,
  BucketDeploymentProps,
  Source,
} from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { LOG_PREFIX } from "./constants";

/** What a `BucketDeployment` Lambda gets without asking. */
const DEFAULT_EPHEMERAL_STORAGE_MIB = 512;
/** The most Lambda will give any function. */
const MAX_EPHEMERAL_STORAGE_MIB = 10240;

/** Bytes on disk under `dir`, following the tree but not symlinks. */
function sizeOfDirectory(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile()) {
      total += statSync(join(entry.parentPath, entry.name)).size;
    }
  }
  return total;
}

export interface NextjsCacheOverrides {
  readonly cacheBucketProps?: BucketProps;
  readonly revalidationTableProps?: TablePropsV2;
  readonly bucketDeploymentProps?: BucketDeploymentProps;
}

export interface NextjsCacheProps {
  readonly buildId: string;
  /**
   * Bring your own S3 bucket for cache storage. When provided, cdk-nextjs
   * will skip creating a new bucket. Cache objects are prefixed with `buildId`
   * so multiple deployments can safely share one bucket.
   */
  readonly cacheBucket?: IBucket;
  /**
   * Absolute path to the init cache directory
   * @example "/Users/john/myapp/.next/cdk-nextjs-init-cache"
   */
  readonly initCacheDir: string;
  readonly overrides?: NextjsCacheOverrides;
  /**
   * Bring your own DynamoDB table for revalidation metadata. When provided,
   * cdk-nextjs will skip creating a new table. The table must have `pk` (String)
   * as partition key and `sk` (String) as sort key. Entries are partitioned by
   * `buildId` so multiple deployments can safely share one table.
   */
  readonly revalidationTable?: ITableV2;
}

/**
 * Next.js Cache construct providing unified S3 and DynamoDB cache management.
 */
export class NextjsCache extends Construct {
  readonly cacheBucket: IBucket;
  readonly revalidationTable: ITableV2;
  readonly buildId: string;
  readonly bucketDeployment?: BucketDeployment;
  private props: NextjsCacheProps;
  private stagingDir?: string;

  constructor(scope: Construct, id: string, props: NextjsCacheProps) {
    super(scope, id);
    this.props = props;
    this.buildId = props.buildId;
    this.cacheBucket = props.cacheBucket ?? this.createCacheBucket();
    this.revalidationTable =
      props.revalidationTable ?? this.createRevalidationTable();
    this.bucketDeployment = this.createDeployment();
  }

  /**
   * Creates S3 bucket for cache storage with BUILD_ID prefixing.
   */
  private createCacheBucket(): IBucket {
    const bucket = new Bucket(this, "Bucket", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      ...this.props.overrides?.cacheBucketProps,
    });

    return bucket;
  }

  /**
   * Creates DynamoDB table for revalidation metadata
   * Schema: pk (buildId or "METADATA"), sk (tag#cacheKey or "CURRENT_BUILD"), createdAt, revalidatedAt
   */
  private createRevalidationTable(): TableV2 {
    const table = new TableV2(this, "RevalidationTable", {
      partitionKey: {
        name: "pk",
        type: AttributeType.STRING,
      },
      sortKey: {
        name: "sk",
        type: AttributeType.STRING,
      },
      billing: Billing.onDemand(),
      removalPolicy: RemovalPolicy.DESTROY,
      ...this.props.overrides?.revalidationTableProps,
    });

    return table;
  }

  /**
   * Deploy pre-built cache files from .next/cdk-nextjs-init-cache to S3
   */
  private createDeployment(): BucketDeployment | undefined {
    // Check if cache directory exists
    if (!existsSync(this.props.initCacheDir)) {
      console.log(
        `${LOG_PREFIX} No pre-built cache found at ${this.props.initCacheDir}, skipping init cache deployment`,
      );
      return undefined;
    }

    console.log(
      `${LOG_PREFIX} Deploying init cache from ${this.props.initCacheDir}`,
    );

    this.stagingDir = this.createStagingDirectory();

    try {
      // Use standard BucketDeployment for regular S3 buckets
      const bucketDeployment = new BucketDeployment(
        this,
        "InitCacheDeployment",
        {
          sources: [Source.asset(this.stagingDir)],
          destinationBucket: this.cacheBucket,
          prune: false, // Don't delete existing objects to prevent 404s during deployment, pruning will be handled by post-deploy
          ...this.sizeDeploymentLambda(),
          ...this.props.overrides?.bucketDeploymentProps,
        },
      );
      return bucketDeployment;
    } finally {
      // `Source.asset` stages during `BucketDeployment`'s construction - CDK's
      // `AssetStaging` zips into `cdk.out` from its own constructor - so the
      // temporary copy is dead the moment that returns. Leaving it was a slow
      // leak with a large unit: the init cache has been measured at 664 MiB, and
      // every `cdk synth` left another full copy in the system temp directory,
      // so a CI loop of ~22 deploys could put ~15 GB on the runner's disk.
      this.removeStagingDirectory();
    }
  }

  /** Best-effort: a leftover temp directory is not worth failing a synth over. */
  private removeStagingDirectory(): void {
    if (!this.stagingDir) {
      return;
    }
    try {
      rmSync(this.stagingDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Could not remove the init cache staging directory ` +
          `${this.stagingDir}: ${error}`,
      );
    }
    this.stagingDir = undefined;
  }

  /**
   * `/tmp` and memory for `BucketDeployment`'s unzip Lambda, scaled to the init
   * cache it has to unpack.
   *
   * That Lambda downloads the asset zip into `/tmp` and then extracts it
   * alongside, so it needs room for both at once. CDK defaults it to 512 MiB of
   * ephemeral storage and 128 MB of memory — fine for a small app, and a hard
   * failure for one whose prerendered payloads are large. A fixture with 60
   * statically generated pages carrying ~1 MB of RSC each produced a 664 MiB
   * seed directory and the handler died on
   * `OSError: [Errno 28] No space left on device` inside `zip.extractall`.
   * Worse, `cdk deploy --hotswap` invokes the custom resource directly with a
   * placeholder response URL, so the `Status: FAILED` it sends goes nowhere: the
   * CLI prints "Contents of AWS::S3::Bucket … hotswapped!", exits 0, and the app
   * comes up serving a *partially* seeded cache. Every route whose entry did not
   * make it is then a miss that re-renders — which, for a
   * `cacheComponents: true` app, means a postponed shell where the prerender
   * should have been.
   *
   * The zip's compressed size is not known at synth time (CDK archives the asset
   * later), so the worst case — an incompressible payload — is what gets
   * budgeted: twice the directory, plus headroom. Memory is only raised past
   * CDK's default for caches big enough that 128 MB's slice of a vCPU would make
   * the unzip and upload race the custom resource's 15-minute timeout; small
   * apps keep the cheaper default and their existing template.
   *
   * Above the 10 GiB ephemeral-storage ceiling there is nothing left to ask for,
   * so this warns and lets the deployment fail loudly rather than pretend.
   * `overrides.bucketDeploymentProps` wins over everything here, including
   * `useEfs: true`, which is the supported way out.
   */
  private sizeDeploymentLambda() {
    const mib = Math.ceil(sizeOfDirectory(this.props.initCacheDir) / 1024 ** 2);
    const wanted = mib * 2 + 128;
    if (wanted > MAX_EPHEMERAL_STORAGE_MIB) {
      console.warn(
        `${LOG_PREFIX} The init cache at ${this.props.initCacheDir} is ${mib} MiB, which does not fit in the ${MAX_EPHEMERAL_STORAGE_MIB} MiB of ephemeral storage a BucketDeployment Lambda can be given. Pass overrides.bucketDeploymentProps with useEfs: true to seed a cache this large.`,
      );
    }
    const ephemeral = Math.min(
      MAX_EPHEMERAL_STORAGE_MIB,
      Math.max(DEFAULT_EPHEMERAL_STORAGE_MIB, wanted),
    );

    return {
      ephemeralStorageSize: Size.mebibytes(ephemeral),
      ...(mib > 256 ? { memoryLimit: 1024 } : {}),
    };
  }

  /**
   * Stage the init cache under a `buildId` directory, so that the objects land
   * at `<buildId>/<key>` without a `destinationKeyPrefix`.
   *
   * The keys have to carry the build ID — that is how the runtime cache handler
   * and the post-deploy pruner namespace one deployment's entries from the next
   * (`src/adapter/s3-cache-handler.ts`). Asking `BucketDeployment` for it, as
   * this used to, is what costs: it unconditionally tags the *destination
   * bucket* with `aws-cdk:cr-owned:<destinationKeyPrefix>:<hash>`, so a prefix
   * that changes per build makes the bucket's `Tags` change per build.
   * `AWS::S3::Bucket` `Tags` are not hotswappable, so `cdk deploy
   * --hotswap-fallback` rejected the diff and fell back to a full CloudFormation
   * deployment every single time — measured at 19 of 22 deploys in one harness
   * run, ~110s each against a ~52s hotswap.
   *
   * Putting the build ID in the asset's own paths instead leaves the S3 keys
   * byte-identical and the tag key constant (`aws-cdk:cr-owned:<hash>`, derived
   * from the construct path). Nothing else read the prefix: `prune` is already
   * `false`, and the two handler branches that do scope work to it — emptying
   * the prefix on delete, and deleting the old prefix when the destination
   * changes — are both gated on `retainOnDelete`, which `BucketDeployment`
   * defaults to `true`.
   *
   * A copy rather than the directory itself because the build ID is only known
   * *after* `next build`, so the adapter cannot write into a nested directory in
   * the first place, and because `.next/cdk-nextjs-init-cache` has to stay where
   * it is for the local cache handler to read it (`CDK_NEXTJS_INIT_CACHE_DIR`).
   * CDK is about to read every byte of this to zip it regardless.
   */
  private createStagingDirectory(): string {
    const stagingDir = mkdtempSync(join(tmpdir(), "nextjs-init-cache-"));
    try {
      cpSync(this.props.initCacheDir, join(stagingDir, this.props.buildId), {
        recursive: true,
      });
      return stagingDir;
    } catch (error) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(
        `${LOG_PREFIX} Failed to stage the init cache from ${this.props.initCacheDir}: ${error}`,
      );
    }
  }
}
