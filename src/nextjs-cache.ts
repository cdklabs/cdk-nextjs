import { existsSync, statSync } from "fs";
import { join } from "path";
import { CustomResource, Duration, RemovalPolicy, Size } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  TableV2,
  TablePropsV2,
  ITableV2,
} from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Bucket, BucketProps, IBucket } from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { LOG_PREFIX } from "./constants";
import { OptionalCustomResourceProps } from "./generated-structs/OptionalCustomResourceProps";
import { OptionalFunctionProps } from "./generated-structs/OptionalFunctionProps";
import { LAMBDA_RUNTIME } from "./lambda-runtime";
import type { CacheSeedResourceProperties } from "./lambdas/cache-seed/cache-seed.lambda";
import { listTree } from "./nextjs-build/nextjs-build";
import {
  cacheSeedSizing,
  MAX_EPHEMERAL_STORAGE_MIB,
} from "./utils/cache-seed-sizing";
import { SECURE_BUCKET_PROPS } from "./utils/secure-bucket-props";

/**
 * The custom resource type of the cache seed. It is `BucketDeployment`'s, so
 * that `cdk deploy --hotswap` runs it: the CLI picks out that type by its type
 * string alone and invokes its ServiceToken Lambda directly (see
 * `HOTSWAP_RESPONSE_URL`), where it skips every other custom resource. That is
 * the CLI's behavior rather than a documented contract; if it ever changes,
 * hotswap deploys stop seeding and a full deploy still does.
 */
const CACHE_SEED_RESOURCE_TYPE = "Custom::CDKBucketDeployment";

/**
 * Files and bytes on disk under `dir`, following the tree but not symlinks.
 *
 * On {@link listTree} rather than `readdirSync({ recursive: true })`, which
 * descends into symlinked directories and never returns on a cycle.
 */
export function measureDirectory(dir: string): {
  files: number;
  bytes: number;
} {
  let files = 0;
  let bytes = 0;
  for (const entry of listTree(dir)) {
    if (entry.isFile()) {
      files++;
      bytes += statSync(join(entry.parentPath, entry.name)).size;
    }
  }
  return { files, bytes };
}

/**
 * Overrides for the cache seed: the Lambda function that writes the init cache
 * into the cache bucket, and the custom resource that runs it.
 */
export interface NextjsCacheSeedOverrides {
  /**
   * Set log retention through `logGroup`, not `logRetention`: the function
   * already has a log group, and CDK refuses both.
   */
  readonly functionProps?: OptionalFunctionProps;
  /**
   * Overriding `resourceType` stops `cdk deploy --hotswap` from seeding: see
   * `NextjsCache.cacheSeed`.
   */
  readonly customResourceProps?: OptionalCustomResourceProps;
}

export interface NextjsCacheOverrides {
  readonly cacheBucketProps?: BucketProps;
  readonly revalidationTableProps?: TablePropsV2;
  readonly cacheSeed?: NextjsCacheSeedOverrides;
}

export interface NextjsCacheProps {
  readonly buildId: string;
  /**
   * Bring your own S3 bucket for cache storage. When provided, cdk-nextjs
   * will skip creating a new bucket.
   *
   * The bucket must be dedicated to this one deployment. Don't share it with
   * another deployment (another branch, stage, or app): every deploy's
   * post-deploy step deletes every object under a top-level prefix other than
   * the current `buildId/`, which includes every other deployment's cache.
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
   * as partition key and `sk` (String) as sort key.
   * Enabling TTL on its `ttl` attribute is recommended: each tag revalidation
   * writes a revalidation log row that expires through it after 15 minutes.
   * Without TTL those rows are kept until a deploy replaces their build, whose
   * post-deploy step deletes them.
   *
   * The table must be dedicated to this one deployment. Don't share it with
   * another deployment (another branch, stage, or app): every deploy's
   * post-deploy step deletes the entries of the build it last recorded in the
   * table, which with a shared table is another deployment's live build.
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
  /**
   * Writes the init cache (`initCacheDir`) into the cache bucket's
   * `<buildId>/` prefix, once per build and never over a key the app has
   * written. Only exists when the init cache holds a file. The compute should
   * depend on it, so that a new build takes traffic with its cache already
   * seeded.
   *
   * Its type is `Custom::CDKBucketDeployment`, `BucketDeployment`'s, so that
   * `cdk deploy --hotswap` runs it too.
   */
  readonly cacheSeed?: CustomResource;
  /** The Lambda function behind `cacheSeed`. */
  readonly cacheSeedFunction?: LambdaFunction;
  private props: NextjsCacheProps;

  constructor(scope: Construct, id: string, props: NextjsCacheProps) {
    super(scope, id);
    this.props = props;
    this.buildId = props.buildId;
    this.cacheBucket = props.cacheBucket ?? this.createCacheBucket();
    this.revalidationTable =
      props.revalidationTable ?? this.createRevalidationTable();
    const initCache = this.measureInitCache();
    if (initCache) {
      const asset = new Asset(this, "InitCacheAsset", {
        path: this.props.initCacheDir,
      });
      this.cacheSeedFunction = this.createCacheSeedFunction(
        initCache.bytes,
        asset,
      );
      this.cacheSeed = this.createCacheSeed(this.cacheSeedFunction, asset);
    }
  }

  /**
   * Creates S3 bucket for cache storage with BUILD_ID prefixing.
   */
  private createCacheBucket(): IBucket {
    const bucket = new Bucket(this, "Bucket", {
      ...SECURE_BUCKET_PROPS,
      ...this.props.overrides?.cacheBucketProps,
    });

    return bucket;
  }

  /**
   * Creates DynamoDB table for revalidation metadata
   * Schema: pk (buildId or "METADATA"), sk (tag#cacheKey or "CURRENT_BUILD"), createdAt, revalidatedAt
   *
   * Also the `'use cache'` revalidation log (pk "<buildId>#log",
   * sk "<epoch-ms>#<tag>"), whose rows expire through the `ttl` attribute.
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
      timeToLiveAttribute: "ttl",
      ...this.props.overrides?.revalidationTableProps,
    });

    return table;
  }

  /**
   * The init cache's size, or `undefined` when there is nothing to seed: no
   * init cache directory, or one without a file, which is what a build with
   * nothing to prerender leaves.
   */
  private measureInitCache(): { bytes: number } | undefined {
    const dir = this.props.initCacheDir;
    const measured = existsSync(dir) ? measureDirectory(dir) : undefined;
    if (!measured?.files) {
      console.log(
        `${LOG_PREFIX} No pre-built cache found at ${dir}, skipping init cache deployment`,
      );
      return undefined;
    }
    console.log(`${LOG_PREFIX} Deploying init cache from ${dir}`);
    return measured;
  }

  /**
   * The Lambda function that seeds the cache, sized to the init cache it
   * downloads into `/tmp` (`cacheSeedSizing`).
   *
   * Every grant is on a whole bucket, never on this build's asset key or
   * `<buildId>/` prefix, so the policy is the same from one build to the next:
   * `cdk deploy --hotswap` skips a change to the policy of a role that only
   * `Custom::CDKBucketDeployment` Lambdas use, rather than apply it, so a
   * per-build grant would deny the very invoke the hotswap then makes.
   */
  private createCacheSeedFunction(bytes: number, asset: Asset) {
    const sizing = cacheSeedSizing(bytes);
    if (sizing.exceedsMax) {
      console.warn(
        `${LOG_PREFIX} The init cache at ${this.props.initCacheDir} is ${sizing.cacheMib} MiB. Its zip has to fit in the ${MAX_EPHEMERAL_STORAGE_MIB} MiB of ephemeral storage the cache seed Lambda can be given at most, so unless it compresses well the deploy will fail. Prerender less at build time (for example, return fewer params from generateStaticParams and let the rest render on demand).`,
      );
    }
    const overrides = this.props.overrides?.cacheSeed?.functionProps;
    // Not CDK's default role, which attaches the AWSLambdaBasicExecutionRole
    // managed policy: the log group's own grant below is all it needs. None
    // at all when an override brings its own.
    const role =
      overrides?.role ??
      new Role(this, "CacheSeedRole", {
        assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      });
    const fn = new LambdaFunction(this, "CacheSeedFn", {
      // Plain bundled JS with no native dependencies, so always arm64.
      architecture: Architecture.ARM_64,
      // The runtime's own AWS SDK, not a bundled one: it has `PutObject`'s
      // `IfNoneMatch` (S3 conditional writes, August 2024) in every Node 24
      // and later runtime, all of which postdate it.
      code: Code.fromAsset(
        join(__dirname, "../assets/lambdas/cache-seed/cache-seed.lambda"),
      ),
      environment: {
        // A `debug` namespace pattern; `1` matches no namespace.
        DEBUG: "cdk-nextjs:*",
      },
      ephemeralStorageSize: Size.mebibytes(sizing.ephemeralStorageMib),
      handler: "index.handler",
      logGroup: new LogGroup(this, "CacheSeedLogGroup", {
        removalPolicy: RemovalPolicy.DESTROY,
        retention: RetentionDays.ONE_MONTH,
      }),
      memorySize: sizing.memoryMb,
      role,
      runtime: LAMBDA_RUNTIME,
      // The most Lambda allows. The handler stops short of it and reports
      // FAILED, and a retry skips what was already written.
      timeout: Duration.minutes(15),
      ...overrides,
    });
    fn.logGroup.grantWrite(fn);
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [asset.bucket.arnForObjects("*")],
      }),
    );
    // `s3:GetObject` for the marker's HeadObject, which without
    // `s3:ListBucket` answers a missing key with 403 rather than 404;
    // `s3:PutObject` for the entries and the marker. Nothing is ever deleted.
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [this.cacheBucket.arnForObjects("*")],
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [this.cacheBucket.bucketArn],
      }),
    );
    // A bring-your-own bucket encrypted with a customer managed key.
    this.cacheBucket.encryptionKey?.grantEncryptDecrypt(fn);
    return fn;
  }

  private createCacheSeed(fn: LambdaFunction, asset: Asset) {
    const properties: CacheSeedResourceProperties = {
      BuildId: this.buildId,
      DestinationBucketName: this.cacheBucket.bucketName,
      SourceBucketName: asset.s3BucketName,
      SourceObjectKey: asset.s3ObjectKey,
    };
    return new CustomResource(this, "CacheSeed", {
      properties,
      resourceType: CACHE_SEED_RESOURCE_TYPE,
      // The Lambda itself, not a Provider framework: the hotswap invokes the
      // ServiceToken directly with a CloudFormation-shaped event.
      serviceToken: fn.functionArn,
      // Just past the Lambda's 15 minutes: a seeder killed before it answers
      // (out of memory, say) fails the deploy then, not after CloudFormation's
      // default hour.
      serviceTimeout: Duration.minutes(16),
      ...this.props.overrides?.cacheSeed?.customResourceProps,
    });
  }
}
