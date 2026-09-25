/*
  S3 and DynamoDB cache handler for Next.js incremental cache
*/
/* eslint-disable import/no-extraneous-dependencies */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  AttributeValue,
  BatchGetItemCommand,
  BatchGetItemCommandOutput,
  DeleteItemCommand,
  DynamoDBClient,
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
  /**
   * The cache value, in whatever shape it arrives: a stored entry read back from
   * S3 on the way in, and the `IncrementalCacheValue` union on the way out. Only
   * the `headers` some of its members carry is read, so `unknown` and one narrow
   * is less noise than spelling that union out twice.
   */
  value?: unknown;
}): string[] {
  if (stored.tags?.length) {
    return stored.tags;
  }
  const headers = (stored.value as { headers?: unknown } | undefined)?.headers;
  const header = (headers as Record<string, unknown> | undefined)?.[
    NEXT_CACHE_TAGS_HEADER
  ];
  if (typeof header !== "string" || header === "") {
    return [];
  }
  return header.split(",").filter(Boolean);
}

/**
 * The `lastModified` that tells Next.js "this entry is expired, re-render it
 * before answering".
 *
 * `IncrementalCache.get` turns it into `isStale: -1`, which `app-page-runtime`
 * reads as an on-demand revalidation and answers with a blocking render of
 * *this* route, then stores it. Returning `null` instead is not the same thing:
 * a miss on a PPR route whose `prerender-manifest.json` entry carries a
 * `fallback` (`compute: "resuming"`) is answered from the route's fallback
 * shell, which is served `cache-control: private, no-store` with no
 * `x-nextjs-cache` header, and - unless `partialPrefetching` is on - is never
 * upgraded into a concrete entry. So the first `revalidateTag` to reach a
 * seeded prerender left that page uncacheable, and dynamically resumed per
 * request, for the rest of the deployment's life. The isr e2e sees it as an
 * absent `x-nextjs-cache`.
 */
const EXPIRED_LAST_MODIFIED = -1;

/**
 * Whether a `get` is for the `fetch` cache rather than for a route's response.
 *
 * `IncrementalCacheKind.FETCH`, compared as its own string value so this file
 * keeps importing no Next.js internals (the enum is `const`, so it has no
 * runtime representation to import anyway).
 */
function isFetchCacheKind(kind: string | undefined): boolean {
  return kind === "FETCH";
}

/**
 * {@link isFetchCacheKind} as a narrowing predicate, so that `ctx.tags` and
 * `ctx.softTags` — which only {@link GetIncrementalFetchCacheContext} has — are
 * reachable without a cast.
 */
function isFetchCacheGet(
  ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
): ctx is GetIncrementalFetchCacheContext {
  return isFetchCacheKind(ctx.kind);
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
 * Invalidation paths covering every URI CloudFront could be holding the response
 * for `route` under, once `basePath` is prefixed.
 *
 * An invalidation path matches only the query string it spells out, and a page's
 * RSC payload is cached under `?_rsc=<hash>`; dropping the HTML while leaving the
 * payload behind leaves the router navigating to the pre-revalidation page. A
 * `trailingSlash` app caches the redirect target rather than the route, so the
 * slash variant has to go too.
 *
 * One trailing wildcard covers all four (`/blog`, `/blog?…`, `/blog/`,
 * `/blog/?…`) for a single wildcard path, where spelling them out cost two -
 * and wildcards are the quota that runs out. It also matches `/blogroll` and
 * everything under `/blog/`, which is a lower hit rate on those, never a stale
 * page. The app's root is the exception: `/*` there is the whole app.
 *
 * `basePath` is prefixed here because neither source of a route carries it.
 * Cache keys are routes — Next.js strips `basePath` before routing, so the cache
 * handler never sees one — and `revalidatePath("/blog")` names the route as
 * well. CloudFront only ever saw `/base/blog`, so invalidating `/blog` clears
 * nothing and the edge keeps serving the pre-revalidation page until `s-maxage`
 * expires. The app's root under a `basePath` is `/base`, not `/base/`.
 */
function cdnInvalidationPaths(route: string, basePath: string): string[] {
  const trimmed = route.replace(/\/+$/, "");
  if (trimmed === "") {
    return basePath
      ? [basePath, `${basePath}?*`, `${basePath}/`, `${basePath}/?*`]
      : ["/", "/?*"];
  }
  return [`${basePath}${trimmed}*`];
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

/** Whether CloudFront counts this path against the wildcard quota. */
function isWildcardPath(path: string): boolean {
  return path.includes("*");
}

/**
 * The most wildcard paths one `revalidateTag` sends before collapsing to a single
 * app-wide wildcard, and the most paths of any kind.
 *
 * CloudFront's wildcard quota is per *distribution*, not per request: the
 * invalidations it has in progress share it, so splitting an oversized set into
 * back-to-back requests is what gets the later ones rejected
 * (`TooManyInvalidationsInProgress`, or a throttle under the newer rate-based
 * quotas) - and a rejected request is a page that stays stale at the edge. So
 * everything goes out as one request, and a set that would not fit in one is
 * answered with `/*` instead: a worse hit rate, and a strictly correct answer.
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-invalidations
 */
const MAX_WILDCARD_PATHS_PER_INVALIDATION = 15;
const MAX_PATHS_PER_INVALIDATION = 3000;

/**
 * How many 1 MB Query pages of one tag's mapping rows to walk. A ceiling rather
 * than a real limit: it bounds a runaway tag instead of paginating a whole table
 * on a request path. A tag cut off here invalidates the whole app, because the
 * rows it never read are pages whose edge copy would otherwise stay stale.
 */
const MAX_TAG_QUERY_PAGES = 20;

/** DynamoDB's cap on keys in one `BatchGetItem`. */
const BATCH_GET_MAX_KEYS = 100;

/**
 * Next.js's in-process tag manifest, which `IncrementalCache.get` consults to
 * decide whether an entry is stale - or `undefined` when it cannot be found
 * unambiguously.
 *
 * `revalidateTag(tag, profile)` asks for stale-while-revalidate: the entry is
 * served once more while a background render replaces it. A cache handler has
 * no field to say "stale" in - `lastModified: -1` means expired, which blocks -
 * so this sets the tag's `stale` timestamp where Next.js already looks for it,
 * which is exactly what its own `FileSystemCache.revalidateTag` does. The module
 * is read from the loaded-module cache rather than `require`d: the handler is
 * bundled apart from the app, and resolving `next` from here could reach a
 * different copy than the server loaded, whose manifest nothing reads. A stale
 * mark written there would serve the entry as fresh, so without exactly one
 * loaded copy the caller falls back to expiring the entry outright.
 */
const TAGS_MANIFEST_MODULE =
  "/next/dist/server/lib/incremental-cache/tags-manifest.external.js";
function nextTagsManifest():
  Map<string, { stale?: number; expired?: number }> | undefined {
  const cache = createRequire(join(process.cwd(), "index.js")).cache;
  const loaded = Object.keys(cache).filter((path) =>
    path.replace(/\\/g, "/").endsWith(TAGS_MANIFEST_MODULE),
  );
  if (loaded.length !== 1) {
    return undefined;
  }
  const manifest = cache[loaded[0]]?.exports?.tagsManifest;
  return manifest instanceof Map ? manifest : undefined;
}

/**
 * The `durations` Next.js 16 passes `revalidateTag` for a profile:
 * `revalidateTag("posts", "max")` arrives as `{ expire: <the profile's expire> }`.
 * Absent for `updateTag` and a bare `revalidateTag`, which expire immediately.
 */
interface RevalidateDurations {
  expire?: number;
}

/** A DynamoDB number attribute as a number, or `undefined` when absent. */
function numberAttribute(
  value: AttributeValue | undefined,
): number | undefined {
  return value?.N === undefined ? undefined : Number(value.N);
}

/**
 * The marker-row update for a tag revalidated at `now`.
 *
 * Without `durations` - `updateTag`, or `revalidateTag` with no profile - the
 * tag's entries expire immediately (`revalidatedAt`). With them the entries go
 * stale now and expire after the profile's `expire`, the same pair of
 * timestamps Next.js's `FileSystemCache.revalidateTag` records.
 */
function markerUpdate(
  now: number,
  durations: RevalidateDurations | undefined,
): Pick<
  ConstructorParameters<typeof UpdateItemCommand>[0],
  "UpdateExpression" | "ExpressionAttributeValues"
> {
  if (!durations) {
    return {
      UpdateExpression: "SET revalidatedAt = :timestamp",
      ExpressionAttributeValues: { ":timestamp": { N: String(now) } },
    };
  }
  if (durations.expire === undefined) {
    return {
      UpdateExpression: "SET staleAt = :stale",
      ExpressionAttributeValues: { ":stale": { N: String(now) } },
    };
  }
  return {
    UpdateExpression: "SET staleAt = :stale, expiredAt = :expired",
    ExpressionAttributeValues: {
      ":stale": { N: String(now) },
      ":expired": { N: String(now + durations.expire * 1000) },
    },
  };
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
   * @see cdnInvalidationPaths
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

        if (await this.isRevalidated(parsedValue, ctx)) {
          this.debug(`S3 CACHE INVALIDATED BY TAG: ${cacheKey}`);
          // A revalidated `fetch` entry has to read as a miss so the request
          // refetches instead of reusing the body - the same thing Next.js's
          // own `FileSystemCache` does with `revalidatedTags`. Only a
          // *response* entry gets handed back expired, because for those a
          // miss is worse than stale: see `EXPIRED_LAST_MODIFIED`.
          //
          // Neither is deleted. The refetch or re-render this provokes
          // overwrites the object through `set`, with a `lastModified` past the
          // tag's marker; deleting it here as well raced that write, and a
          // concurrent request's fresh entry could be the one removed. Keeping
          // a response entry also means a render that fails is answered from
          // the last good copy rather than from a shell.
          return isFetchCacheKind(ctx.kind)
            ? null
            : { lastModified: EXPIRED_LAST_MODIFIED, value: cacheValue.value };
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

  /**
   * Whether a tag revalidation has expired `entry`, for a `get` with `ctx`.
   *
   * Public because the in-memory layer in front of this handler has to ask too:
   * a memory hit never reaches {@link get}, and without this check an instance
   * other than the one that ran `revalidateTag` kept answering from memory for
   * the whole memory TTL - long enough for CloudFront to cache the stale page
   * again after the invalidation.
   *
   * Which tags to check depends on the kind, and Next.js's own
   * `FileSystemCache.get` splits the same two ways: a response entry is checked
   * against the tags *it* was stored with, but a `fetch` entry is checked
   * against `[...ctx.tags, ...ctx.softTags]` — the tags of the request asking
   * for it. That distinction is load-bearing, because a `fetch` entry is only
   * ever stored with its *explicit* `cache: { tags }` and never with the
   * implicit `_N_T_/<path>` chain, which arrives only as `ctx.softTags`.
   * Reading the stored tags for a `fetch` too meant an untagged `force-cache`
   * fetch had `[]`, skipped the check entirely, and no `revalidatePath` could
   * ever evict it: a `force-dynamic` page whose data comes from such a fetch
   * re-rendered on every request and still served the same body forever.
   * Measured against next.js's `test/e2e/app-dir/revalidate-path-with-rewrites`.
   */
  async isRevalidated(
    entry: { lastModified?: number; tags?: string[]; value?: unknown },
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
  ): Promise<boolean> {
    if (!this.dynamoConfig.tableName) {
      return false;
    }
    const checkTags = isFetchCacheGet(ctx)
      ? [...(ctx.tags ?? []), ...(ctx.softTags ?? [])]
      : entryTags(entry);
    if (checkTags.length === 0) {
      return false;
    }
    return this.checkIfRevalidated(entry.lastModified ?? 0, checkTags);
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

        // Read the entry's tags before the object is gone: they are the only
        // way to name its mapping rows, whose sort key is `tag#s3Key` and so
        // cannot be queried from the key side. See `storedEntryTags`.
        const tags = await this.storedEntryTags(s3Key, ctx);

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

        await this.deleteDynamoDBTagMappings(s3Key, tags);
        return;
      }

      // `entryTags`, not `getTags(ctx)` alone: for a page or route response
      // `ctx` carries only `{ cacheControl, isRoutePPREnabled, isFallback }` —
      // `ResponseCache.set` builds it that way and `IncrementalCache.set`
      // forwards it unchanged — so the tags live in the render's
      // `x-next-cache-tags` header and nowhere else. Reading only `ctx` meant no
      // runtime-rendered page ever got a mapping row, and a page that is not in
      // the build manifest has none from `seedTagMappings` either: a later
      // `revalidateTag` found nothing to invalidate and CloudFront kept serving
      // the stale HTML and RSC payload for the whole `s-maxage`. Same source the
      // read path above already falls back to.
      const tags = entryTags({ tags: getTags(ctx), value: data });
      this.debug(
        `S3 CACHE SET: Key: ${cacheKey}, tags: ${tags.length ? tags : "none"}`,
      );

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
      if (tags.length > 0 && this.mapsTagsToPaths) {
        this.debug(`STORING TAGS: ${cacheKey} -> [${tags.join(", ")}]`);
        await this.storeDynamoDBTagMappings(s3Key, tags);
      }
    } catch (error) {
      console.error("Error storing cache to S3:", error);
    }
  }

  async revalidateTag(
    tag: string | string[],
    durations?: RevalidateDurations,
  ): Promise<void> {
    const tags = Array.isArray(tag) ? tag : [tag];
    this.debug(`REVALIDATING TAGS: [${tags.join(", ")}]`);

    if (!this.dynamoConfig.tableName) {
      return;
    }

    // Settled rather than `all`: one tag's throttled write must not drop the
    // CloudFront paths every other tag resolved.
    const results = await Promise.allSettled(
      tags.map((t) => this.revalidateSingleTag(t, durations)),
    );
    const routes: string[] = [];
    let wholeApp = false;
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Error updating revalidation metadata:", result.reason);
        continue;
      }
      routes.push(...result.value.routes);
      wholeApp ||= result.value.truncated;
    }

    // Invalidate the CDN edge cache so CloudFront-fronted deployments don't
    // keep serving stale responses until the cache policy's TTL naturally
    // expires. One request for every tag at once: see
    // `MAX_WILDCARD_PATHS_PER_INVALIDATION` for why never several.
    if (this.cloudFrontConfig.distributionIdParameterName) {
      const { basePath } = this.cloudFrontConfig;
      await this.invalidateCloudFrontPaths(
        wholeApp
          ? [`${basePath}/*`]
          : routes.flatMap((route) => cdnInvalidationPaths(route, basePath)),
      );
    }
  }

  /**
   * Record `tag`'s revalidation, and return the routes CloudFront could be
   * holding a response for it under - `truncated` when there were more than
   * {@link MAX_TAG_QUERY_PAGES} could name.
   */
  private async revalidateSingleTag(
    tag: string,
    durations: RevalidateDurations | undefined,
  ): Promise<{ routes: string[]; truncated: boolean }> {
    // Record the revalidation against the tag itself, not only against the cache
    // keys already mapped to it. The mapping rows only exist for entries some
    // runtime `set` wrote; a build-time prerender has none, so without this
    // marker `revalidateTag` would have nothing to act on for a static page.
    // See `checkIfRevalidated`, which reads it.
    const now = Date.now();
    await this.dynamoClient.send(
      new UpdateItemCommand({
        TableName: this.dynamoConfig.tableName,
        Key: {
          pk: { S: this.dynamoConfig.buildId },
          sk: { S: tag },
        },
        ...markerUpdate(now, durations),
      }),
    );

    if (!this.mapsTagsToPaths) {
      return { routes: [], truncated: false };
    }

    const { items, truncated } = await this.queryTagMappings(tag);
    // Extract S3 keys from sort keys (format: "tag#s3Key"). Split at the tag's
    // own length rather than at the first "#": a tag is app-defined and may
    // contain one, and `revalidateTag("user#42")` then yielded
    // "42#<buildId>/account.json" — whose invalidation path
    // ("/42#<buildId>/account") names nothing CloudFront cached, so the edge
    // kept serving the stale page.
    //
    // The same `#` makes `begins_with(sk, "user#")` match rows that are not
    // `user`'s at all: the marker row of tag `user#42` (sk `user#42`) and every
    // mapping row of it (`user#42#<buildId>/…`). What is left after the prefix
    // is an S3 key only if it starts with the build's own prefix, which is how
    // `buildS3Key` writes every one.
    const prefixLength = tag.length + 1;
    const keyPrefix = this.dynamoConfig.buildId
      ? `${this.dynamoConfig.buildId}/`
      : "";
    const s3Keys = items
      .map((item) => item.sk?.S?.slice(prefixLength))
      .filter((s3Key): s3Key is string =>
        Boolean(s3Key && s3Key.startsWith(keyPrefix)),
      );

    this.debug(
      `TAG ${tag}: Found ${s3Keys.length} cache entries to invalidate`,
    );

    // The mapping rows themselves are deliberately left alone. Stamping
    // `revalidatedAt` on each `tag#cacheKey` row is what this used to do, and
    // nothing has read that attribute since `checkIfRevalidated` began reading
    // the bare-tag marker row written above — so the writes were dead, and they
    // were dead *in front of* the invalidation. One throttled `UpdateItem`
    // rejected the batch, the CloudFront invalidation never ran, and the only
    // trace was a `console.error` while the edge kept serving the stale page.
    //
    // Deliberately not deleting the tag's S3 objects either. The marker row
    // above is what invalidates them: `get` compares it against each entry's
    // own `lastModified` and hands the entry back expired, which is the signal
    // that makes Next.js re-render *this* route and store the result (see
    // `EXPIRED_LAST_MODIFIED`). Deleting the object instead turned the next
    // request into a hard miss, and a hard miss on a PPR route is answered from
    // the route's fallback shell — uncacheable, and never upgraded back into a
    // concrete entry, so one `revalidateTag` left the page resuming
    // dynamically for good.
    const routes = s3Keys
      .map((s3Key) => this.s3KeyToInvalidationPath(s3Key))
      .filter((route): route is string => route !== undefined);
    // A `revalidatePath` names its path in the tag itself, which is the only
    // way to reach a build-time prerender's CDN copy when it has no mapping
    // row.
    routes.push(...implicitTagPaths(tag));
    return { routes, truncated };
  }

  /**
   * Every mapping row for `tag`, following `LastEvaluatedKey`, and whether
   * {@link MAX_TAG_QUERY_PAGES} cut the walk short.
   *
   * DynamoDB caps a Query at 1 MB of items regardless of how many match, and
   * there is one row per tagged entry — a build-time seed writes one for every
   * tagged prerender, so a large site passes 1 MB on a common tag. Stopping at the
   * first page invalidates only that page's entries while still reporting
   * success, which is indistinguishable from revalidation having worked.
   */
  private async queryTagMappings(
    tag: string,
  ): Promise<{ items: Record<string, AttributeValue>[]; truncated: boolean }> {
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

    const truncated = exclusiveStartKey !== undefined;
    if (truncated) {
      console.warn(
        `Stopped paginating tag "${tag}" after ${pages} pages ` +
          `(${items.length} entries); invalidating the whole app instead.`,
      );
    }
    return { items, truncated };
  }

  /**
   * Reverses `buildS3Key` to recover the route the response was cached for, for
   * {@link cdnInvalidationPaths} to turn into the URIs CloudFront holds it under, or
   * `undefined` for a key that names no cached URI.
   *
   * Two kinds of mapping row do not: a dynamic route template (`blog/[slug].json`,
   * which the adapter's seeded entries include), and a fetch-cache entry, whose
   * key is an opaque hash rather than a route. Both would invalidate a URI that
   * cannot exist, and each one costs one of the fifteen wildcard paths an
   * invalidation may carry — so they are dropped here rather than crowding out
   * the real ones.
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
   * Invalidate `paths` in a single request, or the whole app with one wildcard
   * when they would not fit in one. See {@link MAX_WILDCARD_PATHS_PER_INVALIDATION}.
   */
  private async invalidateCloudFrontPaths(paths: string[]): Promise<void> {
    let batch = Array.from(new Set(paths));
    if (batch.length === 0) {
      return;
    }

    const distributionId = await this.getDistributionId().catch((error) => {
      console.warn("Could not resolve the distribution to invalidate:", error);
      return null;
    });
    if (!distributionId) {
      return;
    }

    const wildcards = batch.filter(isWildcardPath).length;
    if (
      wildcards > MAX_WILDCARD_PATHS_PER_INVALIDATION ||
      batch.length > MAX_PATHS_PER_INVALIDATION
    ) {
      const wholeApp = `${this.cloudFrontConfig.basePath}/*`;
      this.debug(
        `CLOUDFRONT INVALIDATION: ${batch.length} paths (${wildcards} ` +
          `wildcards) do not fit one request, collapsing to ${wholeApp}`,
      );
      batch = [wholeApp];
    }

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
      console.warn(
        `Failed to create CloudFront invalidation for [${batch.join(", ")}]:`,
        error,
      );
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

  /**
   * Whether this deployment keeps `tag#s3Key` mapping rows at all.
   *
   * Their one reader is `revalidateTag`'s CloudFront invalidation, which needs
   * the entries' paths - tag revalidation itself runs on the bare-tag marker
   * rows. A deployment with no distribution (the Regional constructs) would pay
   * a DynamoDB write per tag on every `set`, a Query per `revalidateTag`, and an
   * extra S3 read before every delete, for rows nothing ever reads.
   */
  private get mapsTagsToPaths(): boolean {
    return Boolean(
      this.dynamoConfig.tableName &&
      this.cloudFrontConfig.distributionIdParameterName,
    );
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
   * Drop the `tag#s3Key` mapping rows for an entry that no longer exists.
   *
   * The counterpart of {@link storeDynamoDBTagMappings}, and the reason its
   * caller has to know the entry's tags: a mapping row's sort key starts with
   * the tag, so the rows belonging to one cache key cannot be queried for - only
   * a full scan of the build's partition would find them.
   *
   * Left behind, a row still resolves to a cache key on the next
   * `revalidateTag`, which spends one of CloudFront's fifteen wildcard paths
   * invalidating a URI whose entry was deleted - crowding out the paths that do
   * need it, and past {@link MAX_WILDCARD_PATHS_PER_INVALIDATION} collapsing the
   * whole app into one wildcard. The rows also count against the 1 MB a tag's Query returns, so
   * enough of them push live entries onto a page
   * {@link MAX_TAG_QUERY_PAGES} may not reach.
   *
   * Only the mapping rows: the bare-`tag` marker row `revalidateSingleTag`
   * writes belongs to the tag rather than to any entry, and `checkIfRevalidated`
   * reads it for every *other* entry carrying that tag.
   *
   * Deliberately no CloudFront invalidation for the deleted path. The edge copy
   * does outlive the object, but this runs on every revalidated `fetch` entry as
   * well, where the key names no URI, and an invalidation request per deleted
   * entry is a cost the TTL already bounds.
   */
  private async deleteDynamoDBTagMappings(
    s3Key: string,
    tags: string[],
  ): Promise<void> {
    if (!this.mapsTagsToPaths || tags.length === 0) {
      return;
    }
    try {
      await Promise.all(
        // A page's tags can repeat - `ctx.tags` and the render's header are both
        // read - and one delete per tag is enough.
        Array.from(new Set(tags)).map(async (tag) => {
          await this.dynamoClient.send(
            new DeleteItemCommand({
              TableName: this.dynamoConfig.tableName,
              Key: {
                pk: { S: this.dynamoConfig.buildId },
                sk: { S: `${tag}#${s3Key}` },
              },
            }),
          );
        }),
      );
      this.debug(`DELETED TAG MAPPINGS: ${s3Key} -> [${tags.join(", ")}]`);
    } catch (error) {
      // Log but don't fail: the entry itself is already gone, and a stale
      // mapping row costs an invalidation path rather than a wrong response.
      console.error("Error deleting DynamoDB tag mappings:", error);
    }
  }

  /**
   * The tags an entry about to be deleted was stored with.
   *
   * `ctx` carries them for a `fetch` delete, but a response delete arrives as
   * `{ cacheControl, isRoutePPREnabled, isFallback }` - `ResponseCache.set`
   * builds it that way - so the entry itself is the only source, and it has to
   * be read before it is removed. That is one extra GET on a path that runs when
   * a cached route starts answering `notFound()`: `IncrementalCache.set`
   * forwards `ResponseCache`'s null value through to here.
   *
   * A page is also the case worth paying it for, since it carries the whole
   * implicit `_N_T_/…` chain and therefore the most rows.
   */
  private async storedEntryTags(
    s3Key: string,
    ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
  ): Promise<string[]> {
    const ctxTags = getTags(ctx);
    if (ctxTags?.length) {
      return ctxTags;
    }
    if (!this.s3Config.bucketName || !this.mapsTagsToPaths) {
      return [];
    }
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.s3Config.bucketName,
          Key: s3Key,
        }),
      );
      if (!response.Body) {
        return [];
      }
      const bodyString = await response.Body.transformToString("utf-8");
      return entryTags(parseCacheValue(bodyString));
    } catch (error) {
      if (!(error instanceof NoSuchKey)) {
        console.warn(`Failed to read tags of ${s3Key} before deleting:`, error);
      }
      return [];
    }
  }

  /**
   * Whether any of `tags` was revalidated after this entry was stored.
   *
   * Reads the per-tag marker rows `revalidateSingleTag` writes, by primary key.
   * Scanning the tag's mapping rows instead would answer the wrong question:
   * those rows exist per cache *key*, so which one a `Limit: 1` query returned
   * depended on sort order, and an entry could be judged against another
   * entry's timestamp.
   *
   * A tag revalidated with a profile only makes the entry *stale*: that is
   * reported to Next.js through its tag manifest (see {@link nextTagsManifest})
   * and answered `false` here, so the entry is served while a background render
   * replaces it. When the manifest cannot be reached a stale entry is reported
   * expired instead - a blocking render, never a stale page presented as fresh.
   */
  private async checkIfRevalidated(
    cacheLastModified: number,
    tags: string[],
  ): Promise<boolean> {
    try {
      const markers = await this.readTagMarkers(tags);
      const now = Date.now();
      const staleTags: [string, number][] = [];

      for (const [tag, marker] of markers) {
        const revalidatedAt = numberAttribute(marker.revalidatedAt);
        const expiredAt = numberAttribute(marker.expiredAt);
        const staleAt = numberAttribute(marker.staleAt);
        // `expiredAt` in the future is a profile's `expire` that has not come
        // yet, compared the way Next.js's `areTagsExpired` does.
        if (
          (revalidatedAt !== undefined && revalidatedAt > cacheLastModified) ||
          (expiredAt !== undefined &&
            expiredAt <= now &&
            expiredAt > cacheLastModified)
        ) {
          this.debug(
            `Tag ${tag} expired entry created at ${cacheLastModified}`,
          );
          return true;
        }
        if (staleAt !== undefined && staleAt > cacheLastModified) {
          staleTags.push([tag, staleAt]);
        }
      }

      if (staleTags.length === 0) {
        return false;
      }
      const manifest = nextTagsManifest();
      if (!manifest) {
        this.debug(
          `Tags [${staleTags.map(([tag]) => tag)}] are stale and Next.js's tag ` +
            `manifest is unreachable, expiring the entry instead`,
        );
        return true;
      }
      for (const [tag, staleAt] of staleTags) {
        const existing = manifest.get(tag);
        if ((existing?.stale ?? 0) < staleAt) {
          manifest.set(tag, { ...existing, stale: staleAt });
        }
      }
      return false;
    } catch (error) {
      console.error("Error checking cache revalidation:", error);
      // On error, assume cache is valid to avoid unnecessary cache misses
      return false;
    }
  }

  /**
   * The marker rows for `tags` that exist, by tag, in one `BatchGetItem` per
   * {@link BATCH_GET_MAX_KEYS} tags rather than a `GetItem` each: a page
   * carries its whole implicit `_N_T_/…` chain plus the app's own tags, a
   * page with a few fetches checks each of them too, and every one is on the
   * request path.
   */
  private async readTagMarkers(
    tags: string[],
  ): Promise<Map<string, Record<string, AttributeValue>>> {
    const { tableName, buildId } = this.dynamoConfig;
    const unique = Array.from(new Set(tags));
    const markers = new Map<string, Record<string, AttributeValue>>();

    for (let i = 0; i < unique.length; i += BATCH_GET_MAX_KEYS) {
      let keys: Record<string, AttributeValue>[] | undefined = unique
        .slice(i, i + BATCH_GET_MAX_KEYS)
        .map((tag) => ({ pk: { S: buildId }, sk: { S: tag } }));
      // `UnprocessedKeys` is DynamoDB declining part of the batch under load;
      // a marker left unread is a revalidation missed, so it is asked again.
      for (let attempt = 0; keys?.length && attempt < 3; attempt++) {
        const response: BatchGetItemCommandOutput =
          await this.dynamoClient.send(
            new BatchGetItemCommand({
              RequestItems: {
                [tableName]: {
                  Keys: keys,
                  ProjectionExpression: "sk, revalidatedAt, staleAt, expiredAt",
                },
              },
            }),
          );
        for (const item of response.Responses?.[tableName] ?? []) {
          const tag = item.sk?.S;
          if (tag !== undefined) {
            markers.set(tag, item);
          }
        }
        keys = response.UnprocessedKeys?.[tableName]?.Keys;
      }
      if (keys?.length) {
        throw new Error(
          `DynamoDB left ${keys.length} tag markers unread after retrying`,
        );
      }
    }
    return markers;
  }
}
