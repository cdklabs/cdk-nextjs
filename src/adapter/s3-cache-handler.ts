/*
  S3 and DynamoDB cache handler for Next.js incremental cache
*/
/* eslint-disable import/no-extraneous-dependencies */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import getDebug from "debug";
import {
  CacheHandler,
  CacheHandlerValue,
  CacheHandlerContext,
} from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";
import {
  serializeCacheValue,
  parseCacheValue,
  getTags,
  NEXT_CACHE_TAGS_HEADER,
} from "./cache-utils";

/**
 * The tags a stored entry has to be tag-revalidated against.
 *
 * A runtime `set` records `tags` alongside the entry, but a build-time prerender
 * does not: those entries are written as files by the adapter's
 * `onBuildComplete` rather than through `set`, and carry their tags only in the
 * render's `x-next-cache-tags` header — the same place Next.js's own
 * `IncrementalCache.get` reads them from when it decides staleness. Without this
 * fallback no prerendered page is reachable by `revalidateTag`/`revalidatePath`
 * until some later runtime re-render happens to replace the seeded entry, so an
 * app whose pages are all static never revalidates at all. Measured against
 * next.js's `test/e2e/app-dir/resume-data-cache`.
 */
function entryTags(stored: {
  tags?: string[];
  value?: { headers?: Record<string, unknown> };
}): string[] {
  if (stored.tags?.length) {
    return stored.tags;
  }
  const header = stored.value?.headers?.[NEXT_CACHE_TAGS_HEADER];
  if (typeof header !== "string" || header === "") {
    return [];
  }
  return header.split(",").filter(Boolean);
}

/** `NEXT_CACHE_IMPLICIT_TAG_ID`, inlined like {@link NEXT_CACHE_TAGS_HEADER}. */
const NEXT_CACHE_IMPLICIT_TAG_ID = "_N_T_";

/**
 * The `type` argument of `revalidatePath`, which Next.js appends to the implicit
 * tag as a path segment. @see implicitTagPaths
 */
const REVALIDATE_PATH_TYPES = ["layout", "page"];

/**
 * The request paths a `revalidatePath` tag could name, or empty for an app tag.
 *
 * `revalidatePath("/blog")` reaches the cache handler as the implicit tag
 * `_N_T_/blog` - the path is right there in the tag, which is what makes the CDN
 * copy of a build-time prerender reachable at all. A `revalidateTag("posts")`
 * carries no path and depends on the mapping rows instead.
 *
 * Two paths come back when the tag ends in a `revalidatePath` *type*, because
 * `revalidatePath(path, type)` appends it to the tag
 * (`next/dist/server/web/spec-extension/revalidate.js`):
 * `revalidatePath("/blog", "layout")` is `_N_T_/blog/layout`, and
 * `revalidatePath("/", "layout")` is `_N_T_/layout`. Reading either of those as a
 * request path invalidates a URI that does not exist and never touches the one
 * that does. The suffix cannot be told apart from a route that genuinely ends in
 * `/layout`, so both readings are emitted: an invalidation path matching nothing
 * costs a path, while missing the real one leaves the edge stale for the whole
 * `s-maxage`.
 */
function implicitTagPaths(tag: string): string[] {
  if (!tag.startsWith(`${NEXT_CACHE_IMPLICIT_TAG_ID}/`)) {
    return [];
  }
  const path = tag.slice(NEXT_CACHE_IMPLICIT_TAG_ID.length);
  const candidates = [path];
  for (const type of REVALIDATE_PATH_TYPES) {
    if (path.endsWith(`/${type}`)) {
      // `_N_T_/layout` is the root, not the empty path.
      candidates.push(path.slice(0, -(type.length + 1)) || "/");
    }
  }
  // A dynamic route template ("/blog/[slug]") matches no cached URI. Harmless to
  // send, but it costs an invalidation path, and those are metered.
  return Array.from(new Set(candidates)).filter((p) => !p.includes("["));
}

/**
 * The app's `basePath` as the URI prefix CloudFront caches under (`/base`), or
 * `""` when it sets none.
 *
 * Accepts the bare segment the constructs pass (`base`) as well as `/base/`, so
 * the runtime doesn't depend on which spelling reached the environment.
 */
function normalizeBasePathPrefix(raw?: string): string {
  const trimmed = (raw || "").replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `/${trimmed}` : "";
}

/**
 * Every URI CloudFront could be holding the response for `path` under.
 *
 * An invalidation path matches only the query string it spells out, and a page's
 * RSC payload is cached under `?_rsc=<hash>`; dropping the HTML while leaving the
 * payload behind leaves the router navigating to the pre-revalidation page. The
 * slash variant covers `trailingSlash` apps, where the cached URI is the
 * redirect target rather than the route.
 */
function invalidationVariants(path: string): string[] {
  const variants = [path, `${path}?*`];
  if (path !== "/") {
    const other = path.endsWith("/") ? path.slice(0, -1) : `${path}/`;
    variants.push(other, `${other}?*`);
  }
  return variants;
}

/**
 * Whether a cache key is a fetch-cache entry rather than a page route.
 *
 * Those keys are the hash Next.js derives from the request — a single segment of
 * lowercase hex, long enough that no route pathname takes the same shape. They
 * are mapped to tags exactly like pages are, but name no URI CloudFront could be
 * holding, so an invalidation path built from one is always wasted.
 */
function isFetchCacheKey(key: string): boolean {
  return /^[0-9a-f]{32,}$/.test(key);
}

/** Whether CloudFront counts this path against the per-request wildcard quota. */
function isWildcardPath(path: string): boolean {
  return path.includes("*");
}

/**
 * CloudFront's per-request invalidation quotas. Both are hard: a request over
 * either is rejected outright, taking every path in it down with it — including
 * the exact ones that were under quota.
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-invalidations
 */
const MAX_WILDCARD_PATHS_PER_INVALIDATION = 15;
const MAX_PATHS_PER_INVALIDATION = 3000;

/**
 * How many invalidation requests one `revalidateTag` may send before it collapses
 * to a single app-wide wildcard instead.
 *
 * CloudFront also caps *concurrent* invalidation requests (15 in progress), which
 * a tag with a few hundred entries would blow through one 15-wildcard batch at a
 * time — and a rejected batch is silent here by design. One `/*` is a worse cache
 * hit rate and a strictly correct answer, so past this threshold that trade is
 * taken rather than gambling on the quota.
 */
const MAX_INVALIDATION_REQUESTS = 3;

/**
 * How many 1 MB Query pages of one tag's mapping rows to walk. A ceiling rather
 * than a real limit: it bounds a runaway tag (and the invalidation that would
 * follow) instead of paginating a whole table on a request path.
 */
const MAX_TAG_QUERY_PAGES = 20;

/**
 * Pack paths into requests that are under both quotas, keeping exact and wildcard
 * paths for the same page together where they fit so a page is never left
 * half-invalidated by a partial failure.
 */
function invalidationBatches(paths: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let wildcards = 0;
  for (const path of paths) {
    const wildcard = isWildcardPath(path);
    if (
      batch.length === MAX_PATHS_PER_INVALIDATION ||
      (wildcard && wildcards === MAX_WILDCARD_PATHS_PER_INVALIDATION)
    ) {
      batches.push(batch);
      batch = [];
      wildcards = 0;
    }
    batch.push(path);
    if (wildcard) {
      wildcards++;
    }
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

interface S3CacheConfig {
  bucketName: string;
  region: string;
  buildId: string;
}

interface DynamoDBRevalidationConfig {
  tableName: string;
  region: string;
  buildId: string;
}

interface CloudFrontInvalidationConfig {
  /**
   * Name (not value) of the SSM Parameter holding the distribution ID.
   *
   * The distribution ID itself can't be passed as a plain env var: CDK
   * constructs the Lambda/Fargate task before the distribution exists (the
   * distribution's origin references the compute's function URL/ALB), so
   * embedding the distribution's physical ID directly in the compute's
   * environment or IAM policy would create a circular CloudFormation
   * dependency. The parameter *name* is static and known at synth time, so
   * it can be safely embedded; only its *value* depends on the distribution.
   */
  distributionIdParameterName: string;
  region: string;
  /**
   * The app's `basePath`, as the URI prefix CloudFront cached the responses
   * under. Only the Global `NextjsType`s set it, and only when the app has one.
   * @see S3CacheHandler.toCdnPath
   */
  basePath: string;
}

export interface S3CacheHandlerOptions {
  context: CacheHandlerContext;
  s3Config?: Partial<S3CacheConfig>;
  dynamoConfig?: Partial<DynamoDBRevalidationConfig>;
  cloudFrontConfig?: Partial<CloudFrontInvalidationConfig>;
}

export class S3CacheHandler implements CacheHandler {
  private s3Client: S3Client;
  private dynamoClient: DynamoDBClient;
  private cloudFrontClient: CloudFrontClient;
  private ssmClient: SSMClient;
  private s3Config: S3CacheConfig;
  private dynamoConfig: DynamoDBRevalidationConfig;
  private cloudFrontConfig: CloudFrontInvalidationConfig;
  private debug = getDebug("cdk-nextjs:cache-handler:s3");

  // Cached for the lifetime of this instance (i.e. the compute instance) once
  // resolved, since a deployment's distribution ID never changes at runtime.
  private cachedDistributionId: string | null = null;

  constructor(options: S3CacheHandlerOptions) {
    const buildId = process.env.CDK_NEXTJS_BUILD_ID || "";

    // Initialize S3 configuration from environment variables and options
    this.s3Config = {
      bucketName:
        options.s3Config?.bucketName ||
        process.env.CDK_NEXTJS_CACHE_BUCKET_NAME ||
        "",
      region: options.s3Config?.region || process.env.AWS_REGION || "us-east-1",
      buildId: options.s3Config?.buildId || buildId,
    };

    // Initialize DynamoDB configuration from environment variables and options
    this.dynamoConfig = {
      tableName:
        options.dynamoConfig?.tableName ||
        process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME ||
        "",
      region:
        options.dynamoConfig?.region || process.env.AWS_REGION || "us-east-1",
      buildId: options.dynamoConfig?.buildId || buildId,
    };

    // Initialize CloudFront configuration from environment variables and options.
    // Only set for CloudFront-fronted deployments (NextjsGlobalFunctions/Containers).
    // When unset, on-demand revalidation skips CDN invalidation and relies on the
    // distribution's cache policy TTL (driven by the origin's Cache-Control header)
    // to eventually pick up fresh content.
    this.cloudFrontConfig = {
      distributionIdParameterName:
        options.cloudFrontConfig?.distributionIdParameterName ||
        process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME ||
        "",
      region:
        options.cloudFrontConfig?.region ||
        process.env.AWS_REGION ||
        "us-east-1",
      basePath: normalizeBasePathPrefix(
        options.cloudFrontConfig?.basePath || process.env.CDK_NEXTJS_BASE_PATH,
      ),
    };

    // Initialize AWS clients
    this.s3Client = new S3Client({ region: this.s3Config.region });
    this.dynamoClient = new DynamoDBClient({
      region: this.dynamoConfig.region,
    });
    this.cloudFrontClient = new CloudFrontClient({
      region: this.cloudFrontConfig.region,
    });
    this.ssmClient = new SSMClient({ region: this.cloudFrontConfig.region });

    if (!this.s3Config.bucketName) {
      console.warn(
        "CDK_NEXTJS_CACHE_BUCKET_NAME environment variable not set, S3 cache disabled",
      );
    }

    if (!this.dynamoConfig.tableName) {
      console.warn(
        "CDK_NEXTJS_REVALIDATION_TABLE_NAME environment variable not set, revalidation tracking disabled",
      );
    }

    if (!buildId) {
      console.warn(
        "CDK_NEXTJS_BUILD_ID environment variable not set, cache isolation may not work correctly",
      );
    }

    // Log the options for debugging (optional usage to avoid unused parameter warning)
    if (options.context.dev) {
      this.debug("S3DynamoCacheHandler initialized in development mode");
    }
  }

  async get(
    cacheKey: string,
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
  ): Promise<CacheHandlerValue | null> {
    try {
      // Log context for debugging (optional usage to avoid unused parameter warning)
      if (ctx.kind) {
        this.debug(
          `S3 cache get operation for ${cacheKey} with kind: ${ctx.kind}`,
        );
      }

      if (!this.s3Config.bucketName) {
        return null;
      }

      const s3Key = this.buildS3Key(cacheKey);

      const command = new GetObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        return null;
      }

      // Handle different content types appropriately for documented formats
      let cacheValue: CacheHandlerValue;
      const contentType = response.ContentType || "application/json";

      // Handle text-based data (JSON, HTML, plain text) - all documented formats are text-based
      const bodyString = await response.Body.transformToString("utf-8");

      if (contentType.includes("application/json")) {
        // Parse the stored CacheHandlerValue directly
        const parsedValue = parseCacheValue(bodyString);

        // Extract the actual CacheHandlerValue (without tags) for return
        cacheValue = {
          lastModified: parsedValue.lastModified,
          value: parsedValue.value,
        };

        // Check if cache has been invalidated by tag revalidation
        const storedTags = entryTags(parsedValue);
        if (storedTags.length > 0 && this.dynamoConfig.tableName) {
          const isInvalidated = await this.checkIfRevalidated(
            cacheValue.lastModified,
            storedTags,
          );
          if (isInvalidated) {
            this.debug(`S3 CACHE INVALIDATED BY TAG: ${cacheKey}`);
            // Delete the stale S3 entry
            await this.deleteS3Entry(s3Key);
            return null;
          }
        }
      } else {
        console.log(`Invalid content type: ${contentType}`);
        // This shouldn't happen since we always store as JSON now
        return null;
      }

      this.debug(`S3 CACHE HIT: ${cacheKey} (${s3Key})`);

      return cacheValue;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        this.debug(`S3 CACHE MISS: ${cacheKey}`);
        return null;
      }

      // Log actual errors (not cache misses)
      console.error(`Error retrieving cache from S3:`, error);
      return null;
    }
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
  ): Promise<void> {
    try {
      if (!data) {
        // Delete from S3 and DynamoDB
        this.debug(`S3 CACHE DELETE: ${cacheKey}`);

        if (!this.s3Config.bucketName) {
          return;
        }

        // Build S3 key without needing to know the kind
        const s3Key = this.buildS3Key(cacheKey);

        try {
          const deleteCommand = new DeleteObjectCommand({
            Bucket: this.s3Config.bucketName,
            Key: s3Key,
          });
          await this.s3Client.send(deleteCommand);
          this.debug(`S3 CACHE DELETED: ${s3Key}`);
        } catch (error) {
          if (error instanceof NoSuchKey) {
            this.debug(`Failed to delete S3 key ${s3Key}:`, error);
          }
        }

        // TODO: Also delete tag associations from DynamoDB if needed
        return;
      }

      // Debug logging to understand what data is being cached
      const tags = getTags(ctx);
      this.debug(`S3 CACHE SET: Key: ${cacheKey}, tags: ${tags || "none"}`);

      // Note: ctx.tags are available but revalidation is handled separately in revalidateTag method
      // Log tags for debugging if present (only in SetIncrementalFetchCacheContext)
      if (tags && tags.length > 0) {
        this.debug(`S3 cache entry for ${cacheKey} has tags:`, tags);
      }

      if (!this.s3Config.bucketName) {
        return;
      }

      const s3Key = this.buildS3Key(cacheKey);

      // Create CacheHandlerValue structure for S3 storage with tags
      const cacheHandlerValue: CacheHandlerValue = {
        lastModified: Date.now(),
        value: data,
      };

      // Store tags with the cache entry for revalidation checking
      const cacheEntryWithTags = {
        ...cacheHandlerValue,
        tags: tags || [],
      };

      // Serialize with custom handling for Map and Buffer objects
      const body = serializeCacheValue(cacheEntryWithTags);

      const command = new PutObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: s3Key,
        Body: body,
        ContentType: "application/json; charset=utf-8", // Always JSON since we store CacheHandlerValue
      });

      await this.s3Client.send(command);

      this.debug(`S3 CACHE STORED: ${cacheKey} (${data.kind})`);

      // Store tag-to-cache-key mappings in DynamoDB for revalidation
      if (tags && tags.length > 0 && this.dynamoConfig.tableName) {
        this.debug(`STORING TAGS: ${cacheKey} -> [${tags.join(", ")}]`);
        await this.storeDynamoDBTagMappings(s3Key, tags);
      }
    } catch (error) {
      console.error("Error storing cache to S3:", error);
    }
  }

  async revalidateTag(tag: string | string[]): Promise<void> {
    const tags = Array.isArray(tag) ? tag : [tag];
    this.debug(`REVALIDATING TAGS: [${tags.join(", ")}]`);

    try {
      if (!this.dynamoConfig.tableName) {
        return;
      }

      // Process all tags in parallel for better performance
      await Promise.all(tags.map((t) => this.revalidateSingleTag(t)));
    } catch (error) {
      console.error("Error updating revalidation metadata:", error);
    }
  }

  private async revalidateSingleTag(tag: string): Promise<void> {
    // Record the revalidation against the tag itself, not only against the cache
    // keys already mapped to it. The mapping rows only exist for entries some
    // runtime `set` wrote; a build-time prerender has none, so without this
    // marker `revalidateTag` would have nothing to act on for a static page.
    // See `checkIfRevalidated`, which reads it.
    await this.dynamoClient.send(
      new UpdateItemCommand({
        TableName: this.dynamoConfig.tableName,
        Key: {
          pk: { S: this.dynamoConfig.buildId },
          // Mapping rows are `tag#cacheKey`, so a bare tag cannot collide.
          sk: { S: tag },
        },
        UpdateExpression: "SET revalidatedAt = :timestamp",
        ExpressionAttributeValues: {
          ":timestamp": { N: Date.now().toString() },
        },
      }),
    );

    {
      const items = await this.queryTagMappings(tag);
      // Extract S3 keys from sort keys (format: "tag#s3Key")
      const cacheKeys = items
        .map((item) => {
          const sk = item.sk?.S;
          if (sk) {
            const hashIndex = sk.indexOf("#");
            return hashIndex !== -1 ? sk.substring(hashIndex + 1) : null;
          }
          return null;
        })
        .filter(Boolean);

      this.debug(
        `TAG ${tag}: Found ${cacheKeys.length} cache entries to invalidate`,
      );

      // Update revalidation timestamp for all cache keys with this tag
      const updatePromises = items.map(async (item) => {
        const sk = item.sk?.S;
        if (sk) {
          const updateCommand = new UpdateItemCommand({
            TableName: this.dynamoConfig.tableName,
            Key: {
              pk: { S: this.dynamoConfig.buildId },
              sk: { S: sk },
            },
            UpdateExpression: "SET revalidatedAt = :timestamp",
            ExpressionAttributeValues: {
              ":timestamp": { N: Date.now().toString() },
            },
          });

          return this.dynamoClient.send(updateCommand);
        }
        return Promise.resolve();
      });

      await Promise.all(updatePromises.filter(Boolean));

      // Delete the corresponding S3 cache entries to invalidate them
      if (this.s3Config.bucketName) {
        const deletePromises = cacheKeys.map(async (s3Key) => {
          if (s3Key) {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: this.s3Config.bucketName,
              Key: s3Key,
            });

            try {
              await this.s3Client.send(deleteCommand);
            } catch (error) {
              // Log but don't fail - the entry might not exist in S3
              console.warn(`Failed to delete S3 cache entry ${s3Key}:`, error);
            }
          }
        });

        await Promise.all(deletePromises.filter(Boolean));
      }

      // Invalidate the CDN edge cache so CloudFront-fronted deployments don't
      // keep serving stale responses until the cache policy's TTL naturally expires.
      if (this.cloudFrontConfig.distributionIdParameterName) {
        const paths = cacheKeys
          .filter((s3Key): s3Key is string => Boolean(s3Key))
          .map((s3Key) => this.s3KeyToInvalidationPath(s3Key))
          .filter((path): path is string => path !== undefined);

        // A `revalidatePath` names its path in the tag itself, which is the only
        // way to reach a build-time prerender's CDN copy: those entries have no
        // mapping rows, because no runtime `set` ever wrote them.
        paths.push(...implicitTagPaths(tag));

        await this.invalidateCloudFrontPaths(
          paths
            .map((path) => this.toCdnPath(path))
            .flatMap(invalidationVariants),
        );
      }
    }
  }

  /**
   * Every mapping row for `tag`, following `LastEvaluatedKey`.
   *
   * DynamoDB caps a Query at 1 MB of items regardless of how many match, and
   * there is one row per tagged entry — a build-time seed writes one for every
   * tagged prerender, so a large site passes 1 MB on a common tag. Stopping at the
   * first page deletes and invalidates only that page while still reporting
   * success, which is indistinguishable from revalidation having worked.
   */
  private async queryTagMappings(
    tag: string,
  ): Promise<Record<string, AttributeValue>[]> {
    const items: Record<string, AttributeValue>[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    let pages = 0;

    do {
      const response = await this.dynamoClient.send(
        new QueryCommand({
          TableName: this.dynamoConfig.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": { S: this.dynamoConfig.buildId },
            ":skPrefix": { S: `${tag}#` },
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
      pages++;
    } while (exclusiveStartKey && pages < MAX_TAG_QUERY_PAGES);

    if (exclusiveStartKey) {
      console.warn(
        `Stopped paginating tag "${tag}" after ${pages} pages ` +
          `(${items.length} entries); some entries may stay cached until their ` +
          `TTL expires.`,
      );
    }
    return items;
  }

  /**
   * Prefix the app's `basePath` onto a route to get the URI CloudFront cached
   * the response under.
   *
   * Neither source of an invalidation path carries it. Cache keys are routes —
   * Next.js strips `basePath` before routing, so the cache handler never sees one
   * (see `prerenderPathToCacheKey`) — and `revalidatePath("/blog")` names the
   * route as well. CloudFront only ever saw `/base/blog`, so invalidating
   * `/blog` clears nothing and the edge keeps serving the pre-revalidation page
   * until `s-maxage` expires.
   */
  private toCdnPath(route: string): string {
    const { basePath } = this.cloudFrontConfig;
    if (!basePath) {
      return route;
    }
    // The app's root under a `basePath` is `/base`, not `/base/` — the slash
    // variant comes from `invalidationVariants`.
    return route === "/" ? basePath : `${basePath}${route}`;
  }

  /**
   * Reverses `buildS3Key` to recover the route the response was cached for, for
   * {@link toCdnPath} to turn into the URI CloudFront holds it under, or
   * `undefined` for a key that names no cached URI.
   *
   * Two kinds of mapping row do not: a dynamic route template (`blog/[slug].json`,
   * which the adapter's seeded entries include), and a fetch-cache entry, whose
   * key is an opaque hash rather than a route. Both would invalidate a URI that
   * cannot exist, and each one costs two of the fifteen wildcard paths a request
   * may carry — so they are dropped here rather than crowding out the real ones.
   */
  private s3KeyToInvalidationPath(s3Key: string): string | undefined {
    const prefix = `${this.s3Config.buildId}/`;
    const withoutPrefix = s3Key.startsWith(prefix)
      ? s3Key.slice(prefix.length)
      : s3Key;
    const withoutSuffix = withoutPrefix.endsWith(".json")
      ? withoutPrefix.slice(0, -".json".length)
      : withoutPrefix;

    if (withoutSuffix.includes("[") || isFetchCacheKey(withoutSuffix)) {
      return undefined;
    }
    return withoutSuffix === "index" ? "/" : `/${withoutSuffix}`;
  }

  /**
   * Invalidate `paths`, split into requests that are each under CloudFront's
   * per-request quotas.
   *
   * One request for everything is what the quotas make unsafe: 15 wildcard paths
   * is easy to pass (two per page), and a request over the cap is rejected whole —
   * so the failure below used to mean *nothing* was invalidated, not even the
   * exact paths, and the edge served the pre-revalidation response for the full
   * `s-maxage`. Past {@link MAX_INVALIDATION_REQUESTS} batches the whole app is
   * invalidated with one wildcard instead; see that constant.
   */
  private async invalidateCloudFrontPaths(paths: string[]): Promise<void> {
    const uniquePaths = Array.from(new Set(paths));
    if (uniquePaths.length === 0) {
      return;
    }

    const distributionId = await this.getDistributionId().catch((error) => {
      console.warn("Could not resolve the distribution to invalidate:", error);
      return null;
    });
    if (!distributionId) {
      return;
    }

    let batches = invalidationBatches(uniquePaths);
    if (batches.length > MAX_INVALIDATION_REQUESTS) {
      const wholeApp = `${this.cloudFrontConfig.basePath}/*`;
      this.debug(
        `CLOUDFRONT INVALIDATION: ${uniquePaths.length} paths needs ` +
          `${batches.length} requests, collapsing to ${wholeApp}`,
      );
      batches = [[wholeApp]];
    }

    for (const batch of batches) {
      this.debug(
        `CLOUDFRONT INVALIDATION: [${batch.join(", ")}] on distribution ${distributionId}`,
      );
      try {
        await this.cloudFrontClient.send(
          new CreateInvalidationCommand({
            DistributionId: distributionId,
            InvalidationBatch: {
              CallerReference: randomUUID(),
              Paths: {
                Quantity: batch.length,
                Items: batch,
              },
            },
          }),
        );
      } catch (error) {
        // Log but don't fail - the S3/DynamoDB invalidation already succeeded,
        // and the CloudFront cache policy TTL provides an eventual fallback.
        // Kept per batch so one rejected request doesn't drop the others.
        console.warn(
          `Failed to create CloudFront invalidation for [${batch.join(", ")}]:`,
          error,
        );
      }
    }
  }

  /**
   * Resolves the distribution's physical ID via SSM Parameter Store, caching
   * it for the lifetime of this instance. See `CloudFrontInvalidationConfig`
   * for why this indirection (rather than a plain env var) is necessary.
   */
  private async getDistributionId(): Promise<string | null> {
    if (this.cachedDistributionId) {
      return this.cachedDistributionId;
    }

    if (!this.cloudFrontConfig.distributionIdParameterName) {
      return null;
    }

    const response = await this.ssmClient.send(
      new GetParameterCommand({
        Name: this.cloudFrontConfig.distributionIdParameterName,
      }),
    );

    this.cachedDistributionId = response.Parameter?.Value || null;
    return this.cachedDistributionId;
  }

  async resetRequestCache(): Promise<void> {
    // This handler doesn't maintain request-level cache state
    // The actual cache clearing is handled by the memory cache handler
  }

  private buildS3Key(cacheKey: string): string {
    // Use BUILD_ID prefixing: {buildId}/{cacheKey}.json

    // Handle edge cases:
    // - Root path "/" should become "index" or similar
    // - Remove leading slashes to prevent empty folders
    let cleanCacheKey = cacheKey;

    if (cacheKey === "/" || cacheKey === "") {
      cleanCacheKey = "index";
    } else if (cacheKey.startsWith("/")) {
      cleanCacheKey = cacheKey.slice(1);
    }

    return join(this.s3Config.buildId, `${cleanCacheKey}.json`);
  }

  private async storeDynamoDBTagMappings(
    s3Key: string,
    tags: string[],
  ): Promise<void> {
    try {
      const updatePromises = tags.map(async (tag) => {
        const tagCacheKey = `${tag}#${s3Key}`;
        const updateCommand = new UpdateItemCommand({
          TableName: this.dynamoConfig.tableName,
          Key: {
            pk: { S: this.dynamoConfig.buildId },
            sk: { S: tagCacheKey },
          },
          // Deliberately no `revalidatedAt`: a mapping row records only that an
          // entry carries the tag. Stamping it at write time made every tagged
          // entry look revalidated one millisecond after it was stored — the
          // row's timestamp is taken after the entry's `lastModified` — so
          // `checkIfRevalidated` deleted healthy entries and the page
          // re-rendered on every request.
          UpdateExpression: "SET createdAt = if_not_exists(createdAt, :now)",
          ExpressionAttributeValues: {
            ":now": { N: Date.now().toString() },
          },
        });

        await this.dynamoClient.send(updateCommand);
      });

      await Promise.all(updatePromises);
    } catch (error) {
      console.error("Error storing DynamoDB tag mappings:", error);
      // Don't throw - cache storage should continue even if tag mapping fails
    }
  }

  /**
   * Whether any of `tags` was revalidated after this entry was stored.
   *
   * Reads the per-tag marker row `revalidateSingleTag` writes, by primary key.
   * Scanning the tag's mapping rows instead would answer the wrong question:
   * those rows exist per cache *key*, so which one a `Limit: 1` query returned
   * depended on sort order, and an entry could be judged against another
   * entry's timestamp.
   */
  private async checkIfRevalidated(
    cacheLastModified: number,
    tags: string[],
  ): Promise<boolean> {
    try {
      // In parallel: a prerendered page carries its whole implicit `_N_T_/…`
      // chain plus the app's own tags, and these are on the request path.
      const markers = await Promise.all(
        tags.map(async (tag) => {
          const response = await this.dynamoClient.send(
            new GetItemCommand({
              TableName: this.dynamoConfig.tableName,
              Key: {
                pk: { S: this.dynamoConfig.buildId },
                sk: { S: tag },
              },
              ProjectionExpression: "revalidatedAt",
            }),
          );
          return { tag, revalidatedAt: response.Item?.revalidatedAt?.N };
        }),
      );

      for (const { tag, revalidatedAt } of markers) {
        if (revalidatedAt && parseInt(revalidatedAt) > cacheLastModified) {
          this.debug(
            `Tag ${tag} was revalidated at ${revalidatedAt}, cache created at ${cacheLastModified}`,
          );
          return true; // Cache is invalidated
        }
      }

      return false; // Cache is still valid
    } catch (error) {
      console.error("Error checking cache revalidation:", error);
      // On error, assume cache is valid to avoid unnecessary cache misses
      return false;
    }
  }

  private async deleteS3Entry(s3Key: string): Promise<void> {
    try {
      if (!this.s3Config.bucketName) {
        return;
      }

      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: s3Key,
      });

      await this.s3Client.send(deleteCommand);
      this.debug(`Deleted stale S3 cache entry: ${s3Key}`);
    } catch (error) {
      // Log but don't fail - the entry might not exist in S3
      console.warn(`Failed to delete stale S3 cache entry ${s3Key}:`, error);
    }
  }
}
