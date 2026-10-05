/*
  S3 and DynamoDB cache handler for Next.js incremental cache
*/
/* eslint-disable import/no-extraneous-dependencies */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  AttributeValue,
  DeleteItemCommand,
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
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
} from "next/dist/server/response-cache";
import {
  AwsCacheConfig,
  buildS3Key,
  CacheBucket,
  markerClock,
  resolveAwsCacheConfig,
  RevalidateDurations,
  RevalidationState,
  s3ObjectKey,
  TrackedTagMarkers,
} from "./aws-cache-store";
import {
  serializeCacheValue,
  parseCacheValue,
  denormalizePagePath,
  getTags,
  GetCacheHandlerContext,
  SetCacheHandlerContext,
  headerTags,
  INIT_CACHE_TAG_MANIFEST,
  ROUTE_CACHE_KEY_PREFIX,
} from "./cache-utils";
import { sharedTagManifest } from "./use-cache-common";
import { REVALIDATED_PAGE_HOOK } from "../runtime/manifest";
import { basePathPrefix, wholeAppInvalidationPaths } from "../utils/base-path";

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
function entryTags(stored: { tags?: string[]; value?: unknown }): string[] {
  return stored.tags?.length ? stored.tags : headerTags(stored.value);
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
 * Whether a `get` is for the `fetch` cache rather than for a route's response,
 * as a narrowing predicate so that `ctx.tags` and `ctx.softTags` — which only
 * {@link GetIncrementalFetchCacheContext} has — are reachable without a cast.
 *
 * `IncrementalCacheKind.FETCH`, compared as its own string value so this file
 * keeps importing no Next.js internals (the enum is `const`, so it has no
 * runtime representation to import anyway).
 */
function isFetchCacheGet(
  ctx: GetCacheHandlerContext,
): ctx is GetIncrementalFetchCacheContext {
  return ctx.kind === "FETCH";
}

/** DynamoDB's limit on a sort key, in UTF-8 bytes. */
const MAX_SORT_KEY_BYTES = 1024;

/** A SHA-256 digest in hex. */
const SHA256_HEX_LENGTH = 64;

/** `NEXT_CACHE_IMPLICIT_TAG_ID`, inlined so this file imports no Next.js internals. */
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
  return [`${basePath}${encodeInvalidationRoute(trimmed)}*`];
}

/**
 * The app's `basePath`, from the `required-server-files.json` every deployment
 * root stages next to `serverDistDir`: Next.js hands the cache handler no
 * other copy.
 */
function appBasePath(serverDistDir: string | undefined): string | undefined {
  if (!serverDistDir) {
    return undefined;
  }
  try {
    const file = join(serverDistDir, "..", "required-server-files.json");
    return JSON.parse(readFileSync(file, "utf8")).config?.basePath;
  } catch (error) {
    console.warn("Could not read basePath for CDN invalidation:", error);
    return undefined;
  }
}

/**
 * `route` as the URI a browser requests it under, which is what CloudFront
 * caches it by.
 *
 * Next.js builds cache keys from the *decoded* pathname (`decodePathParams` in
 * `route-module.js`), so `/blog/héllo` or `/blog/hello world` reach here raw,
 * while CloudFront holds `/blog/h%C3%A9llo`, and an invalidation path matches
 * the encoded form only - AWS requires non-ASCII and unsafe characters to be
 * percent-encoded, and nothing else. Each segment is encoded the way
 * `encodeURI` does, which leaves the characters a browser sends raw in a path
 * (`@`, `:`, `,`, `;`, ...) alone. A `%` that already starts an escape is kept:
 * `decodePathParams` re-escapes path delimiters (`%2F`, `%3F`, `%23`, `%5C`),
 * and a `revalidatePath` tag may name the encoded path itself. `?` and `#` can
 * only be in a decoded segment as data, so they are encoded too.
 */
function encodeInvalidationRoute(route: string): string {
  return route
    .split("/")
    .map((segment) =>
      segment
        .split(/(%[0-9A-Fa-f]{2})/)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : encodeURI(part).replace(
                /[?#]/g,
                (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
              ),
        )
        .join(""),
    )
    .join("/");
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
 * answered with the whole app (`/*`, see `wholeAppInvalidationPaths`) instead:
 * a worse hit rate, and a strictly correct answer.
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-invalidations
 */
const MAX_WILDCARD_PATHS_PER_INVALIDATION = 15;

const MAX_PATHS_PER_INVALIDATION = 3000;

/**
 * Retries of an invalidation CloudFront rejected for its in-progress quota, and
 * the delay before the first; each later one waits twice as long.
 *
 * Sizing a request against the quota cannot see the invalidations other
 * instances already have in flight, so two `revalidateTag`s close together can
 * each fit on their own and still be rejected together. Dropping the rejected
 * one left its pages stale at the edge for the whole `s-maxage`. The retry asks
 * for the whole app instead, which is one wildcard - the least of the quota any
 * request can take - at the cost of a colder edge.
 */
const INVALIDATION_RETRIES = 2;
const INVALIDATION_RETRY_DELAY_MS = 1000;

/** The errors that mean "the quota is full right now", not "this is wrong". */
function isInvalidationQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TooManyInvalidationsInProgress" || name === "Throttling";
}

/**
 * The most cache keys to remember as served stale while awaiting their
 * regeneration. A background render that fails never calls `set`, so without a
 * bound its key would stay behind for the life of the instance.
 * @see S3CacheHandler.softRevalidatedKeys
 */
const MAX_SOFT_REVALIDATED_KEYS = 1000;

/**
 * How many 1 MB Query pages of one tag's mapping rows to walk. A ceiling rather
 * than a real limit: it bounds a runaway tag instead of paginating a whole table
 * on a request path. A tag cut off here invalidates the whole app, because the
 * rows it never read are pages whose edge copy would otherwise stay stale.
 */
const MAX_TAG_QUERY_PAGES = 20;

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

interface CloudFrontInvalidationConfig {
  /**
   * The distribution ID, when the compute's environment can carry it
   * (`NextjsGlobalContainers`).
   */
  distributionId: string;
  /**
   * Otherwise, the name (not value) of the SSM Parameter holding it.
   *
   * On `NextjsGlobalFunctions` the distribution's origin is the function's
   * URL, so the function's environment naming the distribution back would be
   * a circular CloudFormation dependency. The parameter *name* is static and
   * known at synth time; only its *value* depends on the distribution.
   */
  distributionIdParameterName: string;
  /**
   * The app's `basePath`, as the URI prefix CloudFront cached the responses
   * under.
   * @see cdnInvalidationPaths
   */
  basePath: string;
}

export interface S3CacheHandlerOptions {
  context: CacheHandlerContext;
  /**
   * The app's `basePath`, for tests: read from `required-server-files.json`
   * otherwise.
   */
  basePath?: string;
}

export class S3CacheHandler implements CacheHandler {
  private s3Client: S3Client;
  private dynamoClient: DynamoDBClient;
  private cloudFrontClient: CloudFrontClient;
  private ssmClient: SSMClient;
  private bucket: CacheBucket;
  private tags: TrackedTagMarkers;
  private config: AwsCacheConfig;
  private cloudFrontConfig: CloudFrontInvalidationConfig;
  private debug = getDebug("cdk-nextjs:cache-handler:s3");

  // Cached for the lifetime of this instance (i.e. the compute instance) once
  // resolved, since a deployment's distribution ID never changes at runtime.
  private cachedDistributionId: string | null = null;

  /**
   * Cache keys this instance served stale because of a soft `revalidateTag`,
   * whose regenerated entry `set` has yet to write.
   *
   * `revalidateTag(tag, profile)` invalidates CloudFront at once, but the next
   * request is answered from the stale entry - stale-while-revalidate - and that
   * response carries the entry's original `s-maxage`, so the edge caches the
   * stale body again. The background render that replaces it runs in this same
   * process, so `set` checks this set and invalidates the key's paths a second
   * time once the fresh entry is in S3. Without that, the edge kept serving the
   * pre-revalidation page for the whole `s-maxage`.
   *
   * Expiring soft-revalidated entries outright instead would also keep the edge
   * right, but it turns every `revalidateTag(tag, "max")` into a blocking render
   * at the origin, which is the thing a profile asks not to happen.
   */
  private softRevalidatedKeys = new Set<string>();

  /** @see buildTagManifest */
  private buildTags: Promise<Map<string, string[]>> | undefined;

  constructor(options: S3CacheHandlerOptions) {
    this.config = resolveAwsCacheConfig();

    // Only set for CloudFront-fronted deployments (NextjsGlobalFunctions/Containers).
    // When unset, on-demand revalidation skips CDN invalidation and relies on the
    // distribution's cache policy TTL (driven by the origin's Cache-Control header)
    // to eventually pick up fresh content.
    this.cloudFrontConfig = {
      distributionId: process.env.CDK_NEXTJS_DISTRIBUTION_ID || "",
      distributionIdParameterName:
        process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME || "",
      basePath: basePathPrefix(options.basePath),
    };
    // Only invalidation needs it, so only a handler behind a distribution reads
    // it, and a missing file there is worth a warning.
    if (this.invalidatesCdn && options.basePath === undefined) {
      this.cloudFrontConfig.basePath = basePathPrefix(
        appBasePath(options.context.serverDistDir),
      );
    }

    // Initialize AWS clients
    const { region } = this.config;
    this.s3Client = new S3Client({ region });
    this.dynamoClient = new DynamoDBClient({ region });
    this.cloudFrontClient = new CloudFrontClient({ region });
    this.ssmClient = new SSMClient({ region });
    this.bucket = new CacheBucket(this.s3Client, this.config.bucketName);
    // The process's one copy of the tag markers, shared with the `'use cache'`
    // handlers: one `revalidateTag` writes each tag's rows once, and one log
    // `Query` per interval serves every handler.
    this.tags = sharedTagManifest();

    // `res.revalidate()` regenerates a page without going through
    // `revalidateTag`, so the runtime asks for the CDN copies itself, through
    // this hook (`invalidateRevalidatedPage` in `src/runtime/core.ts`). A global
    // because the runtime and this handler are separate bundles in one process.
    // Every instance registers the same thing, so the latest one winning is fine.
    if (this.invalidatesCdn) {
      (globalThis as Record<symbol, unknown>)[REVALIDATED_PAGE_HOOK] = (
        routes: readonly string[],
      ): Promise<void> => {
        const { basePath } = this.cloudFrontConfig;
        return this.invalidateCloudFrontPaths(
          routes.flatMap((route) => cdnInvalidationPaths(route, basePath)),
        );
      };
    }

    if (!this.config.bucketName) {
      console.warn(
        "CDK_NEXTJS_CACHE_BUCKET_NAME environment variable not set, S3 cache disabled",
      );
    }

    if (!this.config.tableName) {
      console.warn(
        "CDK_NEXTJS_REVALIDATION_TABLE_NAME environment variable not set, revalidation tracking disabled",
      );
    }

    if (!process.env.CDK_NEXTJS_BUILD_ID) {
      console.warn(
        "CDK_NEXTJS_BUILD_ID environment variable not set, cache isolation may not work correctly",
      );
    }
  }

  async get(
    cacheKey: string,
    ctx: GetCacheHandlerContext,
  ): Promise<CacheHandlerValue | null> {
    try {
      if (!this.config.bucketName) {
        return null;
      }

      const objectKey = this.s3ObjectKey(cacheKey);

      const response = await this.bucket.get(objectKey);

      if (!response) {
        this.debug(`S3 CACHE MISS: ${cacheKey}`);
        return null;
      }

      // Every object is JSON (`putJson`, and the seeded `.json` files); one
      // that does not parse is a miss, through the `catch` below.
      const parsedValue = parseCacheValue(response);

      if (await this.isRevalidated(parsedValue, ctx, cacheKey)) {
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
        return isFetchCacheGet(ctx)
          ? null
          : { lastModified: EXPIRED_LAST_MODIFIED, value: parsedValue.value };
      }

      this.debug(`S3 CACHE HIT: ${cacheKey} (${objectKey})`);

      // Without the stored tags.
      return {
        lastModified: parsedValue.lastModified,
        value: parsedValue.value,
      };
    } catch (error) {
      // Log actual errors (a cache miss is not one: see `CacheBucket.get`)
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
   *
   * `cacheKey` is the key the entry was read under. A response entry found
   * stale is remembered by it, for `set` to invalidate CloudFront again once
   * its regeneration lands: see {@link softRevalidatedKeys}.
   */
  async isRevalidated(
    entry: { lastModified?: number; tags?: string[]; value?: unknown },
    ctx: GetCacheHandlerContext,
    cacheKey: string,
  ): Promise<boolean> {
    if (!this.config.tableName) {
      return false;
    }
    const checkTags = isFetchCacheGet(ctx)
      ? [...(ctx.tags ?? []), ...(ctx.softTags ?? [])]
      : entryTags(entry);
    if (checkTags.length === 0) {
      return false;
    }
    const state = await this.checkIfRevalidated(
      entry.lastModified ?? 0,
      checkTags,
    );
    if (state === "stale" && !isFetchCacheGet(ctx)) {
      this.noteSoftRevalidated(cacheKey);
    }
    return state === "expired";
  }

  /**
   * Remember that `cacheKey` was served stale, when there is a distribution
   * whose copy of it will need invalidating again. See
   * {@link softRevalidatedKeys}.
   */
  private noteSoftRevalidated(cacheKey: string): void {
    if (!this.invalidatesCdn) {
      return;
    }
    this.softRevalidatedKeys.delete(cacheKey);
    if (this.softRevalidatedKeys.size >= MAX_SOFT_REVALIDATED_KEYS) {
      // Insertion order: the first key is the one waiting longest.
      const oldest = this.softRevalidatedKeys.values().next().value;
      if (oldest !== undefined) {
        this.softRevalidatedKeys.delete(oldest);
      }
    }
    this.softRevalidatedKeys.add(cacheKey);
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: SetCacheHandlerContext,
  ): Promise<void> {
    try {
      if (!data) {
        // Delete from S3 and DynamoDB
        this.debug(`S3 CACHE DELETE: ${cacheKey}`);

        if (!this.config.bucketName) {
          return;
        }

        // The entry is gone, so there is no regeneration left to wait for.
        this.softRevalidatedKeys.delete(cacheKey);

        // Build S3 key without needing to know the kind
        const s3Key = this.buildS3Key(cacheKey);
        const objectKey = this.s3ObjectKey(cacheKey);

        // Read the entry's tags before the object is gone: they are the only
        // way to name its mapping rows, whose sort key is `tag#s3Key` and so
        // cannot be queried from the key side. See `storedEntryTags`.
        const tags = await this.storedEntryTags(objectKey, ctx);

        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucketName,
            Key: objectKey,
          }),
        );
        this.debug(`S3 CACHE DELETED: ${objectKey}`);

        await this.deleteDynamoDBTagMappings(s3Key, tags);
        return;
      }

      // `entryTags`, not `getTags(ctx)` alone: for a page or route response
      // `ctx` carries only `{ cacheControl, isRoutePPREnabled, isFallback }` —
      // `ResponseCache.set` builds it that way and `IncrementalCache.set`
      // forwards it unchanged — so the tags live in the render's
      // `x-next-cache-tags` header and nowhere else. Reading only `ctx` meant no
      // runtime-rendered page ever got a mapping row, and a page that is not in
      // the build's tag manifest names none either: a later
      // `revalidateTag` found nothing to invalidate and CloudFront kept serving
      // the stale HTML and RSC payload for the whole `s-maxage`. Same source the
      // read path above already falls back to.
      const tags = entryTags({ tags: getTags(ctx), value: data });
      this.debug(
        `S3 CACHE SET: Key: ${cacheKey}, tags: ${tags.length ? tags : "none"}`,
      );

      if (!this.config.bucketName) {
        return;
      }

      const s3Key = this.buildS3Key(cacheKey);

      // Create CacheHandlerValue structure for S3 storage with tags
      const cacheHandlerValue: CacheHandlerValue = {
        // On the marker clock, since that is what it is compared with.
        lastModified: markerClock(),
        value: data,
      };

      // Store tags with the cache entry for revalidation checking
      const cacheEntryWithTags = {
        ...cacheHandlerValue,
        tags,
      };

      // Serialize with custom handling for Map and Buffer objects
      const body = serializeCacheValue(cacheEntryWithTags);

      // Always JSON since we store CacheHandlerValue
      await this.bucket.putJson(this.s3ObjectKey(cacheKey), body);

      this.debug(`S3 CACHE STORED: ${cacheKey} (${data.kind})`);

      // The regeneration of an entry served stale: CloudFront may have cached
      // that stale response after `revalidateTag`'s invalidation, so the key's
      // paths go once more now that S3 holds the fresh one.
      if (this.softRevalidatedKeys.delete(cacheKey)) {
        const route = this.s3KeyToInvalidationPath(s3Key);
        if (route !== undefined) {
          this.debug(`SOFT REVALIDATION REGENERATED: ${cacheKey}`);
          await this.invalidateCloudFrontPaths(
            cdnInvalidationPaths(route, this.cloudFrontConfig.basePath),
          );
        }
      }

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

    if (!this.config.tableName) {
      return;
    }

    // Record the revalidation against each tag itself, not only against the
    // cache keys already mapped to it: `checkIfRevalidated` reads these marker
    // rows, and a build-time prerender has no mapping rows at all.
    const recorded = await this.tags.update(tags, durations);

    if (!this.mapsTagsToPaths) {
      return;
    }

    const { basePath } = this.cloudFrontConfig;
    if (!recorded) {
      // Other instances may never learn of this revalidation, so no path list
      // is enough: drop the whole app from CloudFront rather than serve stale
      // pages until their TTL.
      await this.invalidateCloudFrontPaths(wholeAppInvalidationPaths(basePath));
      return;
    }

    // Settled rather than `all`: one tag's throttled Query must not drop the
    // CloudFront paths every other tag resolved.
    const results = await Promise.allSettled(
      tags.map((t) => this.tagRoutes(t)),
    );
    const routes: string[] = [];
    let wholeApp = false;
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Error reading tag mappings:", result.reason);
        // The tag's entries are revalidated at the origin while nothing names
        // their CloudFront paths. The same answer as a tag cut short by
        // `MAX_TAG_QUERY_PAGES`: the whole app, never a stale page.
        wholeApp = true;
        continue;
      }
      routes.push(...result.value.routes);
      wholeApp ||= result.value.truncated;
    }

    // Invalidate the CDN edge cache so CloudFront-fronted deployments don't
    // keep serving stale responses until the cache policy's TTL naturally
    // expires. One request for every tag at once: see
    // `MAX_WILDCARD_PATHS_PER_INVALIDATION` for why never several.
    await this.invalidateCloudFrontPaths(
      wholeApp
        ? wholeAppInvalidationPaths(basePath)
        : routes.flatMap((route) => cdnInvalidationPaths(route, basePath)),
    );
  }

  /**
   * The routes CloudFront could be holding a response for `tag` under -
   * `truncated` when they could not all be named: more mapping rows than
   * {@link MAX_TAG_QUERY_PAGES}, or no build tag manifest to read.
   */
  private async tagRoutes(
    tag: string,
  ): Promise<{ routes: string[]; truncated: boolean }> {
    const [{ items, truncated }, buildTags] = await Promise.all([
      this.queryTagMappings(tag),
      this.buildTagManifest(),
    ]);
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
    //
    // A row whose key would not fit a sort key carries it in `s3Key` instead:
    // see `tagMappingSortKey`. An empty remainder is never one: it is the
    // marker row of a tag one `#` longer.
    const prefixLength = this.tagMappingPrefix(tag).length;
    const keyPrefix = this.config.buildId ? `${this.config.buildId}/` : "";
    const s3Keys = items.flatMap((item) => {
      const rest = item.sk?.S?.slice(prefixLength);
      return rest && rest.startsWith(keyPrefix) ? [item.s3Key?.S ?? rest] : [];
    });
    // The build-time prerenders carrying the tag, which no `set` wrote a row
    // for.
    for (const cacheKey of buildTags?.get(tag) ?? []) {
      s3Keys.push(this.buildS3Key(cacheKey));
    }

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
    return { routes, truncated: truncated || !buildTags };
  }

  /**
   * The build-time prerenders' cache keys by tag ({@link INIT_CACHE_TAG_MANIFEST}),
   * read from the cache bucket once per instance, or `undefined` when that
   * failed, to be read again next time. A prerender is written by the adapter,
   * never through `set`, so this is the only record of which tags name its
   * CloudFront paths, and it is served with a year-long `s-maxage`.
   */
  private buildTagManifest(): Promise<Map<string, string[]> | undefined> {
    this.buildTags ??= this.bucket
      .get(`${this.config.buildId}/${INIT_CACHE_TAG_MANIFEST}`)
      // None is normal: only tagged prerenders write one.
      .then((object) => new Map(Object.entries(JSON.parse(object ?? "{}"))));
    return this.buildTags.catch((error) => {
      this.buildTags = undefined;
      console.warn("Could not read the build's tag manifest:", error);
      return undefined;
    });
  }

  /**
   * Every mapping row for `tag`, following `LastEvaluatedKey`, and whether
   * {@link MAX_TAG_QUERY_PAGES} cut the walk short.
   *
   * DynamoDB caps a Query at 1 MB of items regardless of how many match, and
   * there is one row per tagged entry a runtime `set` wrote, so a large site
   * passes 1 MB on a common tag. Stopping at the
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
          TableName: this.config.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": { S: this.config.buildId },
            ":skPrefix": { S: this.tagMappingPrefix(tag) },
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
    const prefix = `${this.config.buildId}/`;
    const withoutPrefix = s3Key.startsWith(prefix)
      ? s3Key.slice(prefix.length)
      : s3Key;
    const withoutSuffix = withoutPrefix.endsWith(".json")
      ? withoutPrefix.slice(0, -".json".length)
      : withoutPrefix;

    if (withoutSuffix.includes("[") || isFetchCacheKey(withoutSuffix)) {
      return undefined;
    }
    // next >= 16.3.8: `route-cache/<kind>/<hash>/$<pathname>`, the pathname
    // through `normalizePagePath`.
    const routeCacheKey = ROUTE_CACHE_KEY_PREFIX.exec(withoutSuffix);
    if (routeCacheKey) {
      return denormalizePagePath(withoutSuffix.slice(routeCacheKey[0].length));
    }
    return withoutSuffix === "index" ? "/" : `/${withoutSuffix}`;
  }

  /**
   * Invalidate `paths` in a single request, or the whole app
   * ({@link wholeAppInvalidationPaths}) when they would not fit in one. See
   * {@link MAX_WILDCARD_PATHS_PER_INVALIDATION}.
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
      const wholeApp = wholeAppInvalidationPaths(
        this.cloudFrontConfig.basePath,
      );
      this.debug(
        `CLOUDFRONT INVALIDATION: ${batch.length} paths (${wildcards} ` +
          `wildcards) do not fit one request, collapsing to ` +
          `[${wholeApp.join(", ")}]`,
      );
      batch = wholeApp;
    }

    for (let attempt = 0; ; attempt++) {
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
        return;
      } catch (error) {
        if (isInvalidationQuotaError(error) && attempt < INVALIDATION_RETRIES) {
          // See `INVALIDATION_RETRIES`.
          batch = wholeAppInvalidationPaths(this.cloudFrontConfig.basePath);
          await new Promise((resolve) =>
            setTimeout(resolve, INVALIDATION_RETRY_DELAY_MS * 2 ** attempt),
          );
          continue;
        }
        // Log but don't fail - the S3/DynamoDB invalidation already succeeded,
        // and the CloudFront cache policy TTL provides an eventual fallback.
        console.warn(
          `Failed to create CloudFront invalidation for [${batch.join(", ")}]:`,
          error,
        );
        return;
      }
    }
  }

  /**
   * The distribution's physical ID, from the environment or else SSM Parameter
   * Store, cached for the lifetime of this instance. See
   * `CloudFrontInvalidationConfig` for why Functions need the indirection.
   */
  private async getDistributionId(): Promise<string | null> {
    if (this.cloudFrontConfig.distributionId) {
      return this.cloudFrontConfig.distributionId;
    }
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
    return Boolean(this.config.tableName) && this.invalidatesCdn;
  }

  /** Whether there is a distribution to invalidate. */
  private get invalidatesCdn(): boolean {
    return Boolean(
      this.cloudFrontConfig.distributionId ||
      this.cloudFrontConfig.distributionIdParameterName,
    );
  }

  /**
   * `{buildId}/{cacheKey}.json`, the entry's name in tag mappings and the key
   * CloudFront paths are recovered from; see {@link buildS3Key}. Not always
   * where it is stored: see {@link s3ObjectKey}.
   */
  private buildS3Key(cacheKey: string): string {
    return buildS3Key(this.config.buildId, cacheKey);
  }

  /** The S3 object the entry is stored in; see {@link s3ObjectKey}. */
  private s3ObjectKey(cacheKey: string): string {
    return s3ObjectKey(this.config.buildId, cacheKey);
  }

  /**
   * The sort key of `tag`'s mapping row for `s3Key`: `<prefix>s3Key`, or, when
   * that passes DynamoDB's {@link MAX_SORT_KEY_BYTES}, `<prefix><buildId>/#<sha256>`
   * with the key itself in the row's `s3Key` attribute (`hashed`). next
   * 16.3.8's route-scoped keys are ~88 bytes longer than a pathname, enough to
   * push a long tag on a long path over - and a rejected `PutItem` left
   * `revalidateTag` nothing to invalidate, so CloudFront kept the stale page.
   * The prefix is {@link tagMappingPrefix}'s.
   */
  private tagMappingSortKey(
    tag: string,
    s3Key: string,
  ): { sk: string; hashed: boolean } {
    const prefix = this.tagMappingPrefix(tag);
    const sk = `${prefix}${s3Key}`;
    if (Buffer.byteLength(sk) <= MAX_SORT_KEY_BYTES) {
      return { sk, hashed: false };
    }
    const hash = createHash("sha256").update(s3Key).digest("hex");
    return { sk: `${prefix}${this.config.buildId}/#${hash}`, hashed: true };
  }

  /**
   * What every mapping row of `tag` starts with, and so what
   * {@link queryTagMappings} matches: `tag#`, or `#<sha256(tag)>#` for a tag too
   * long to leave a hashed row ({@link tagMappingSortKey}) under the limit. An
   * implicit `_N_T_/…` tag is as long as its path, which nothing caps.
   */
  private tagMappingPrefix(tag: string): string {
    const prefix = `${tag}#`;
    const hashedRowBytes =
      Buffer.byteLength(prefix) +
      Buffer.byteLength(`${this.config.buildId}/#`) +
      SHA256_HEX_LENGTH;
    if (hashedRowBytes <= MAX_SORT_KEY_BYTES) {
      return prefix;
    }
    return `#${createHash("sha256").update(tag).digest("hex")}#`;
  }

  private async storeDynamoDBTagMappings(
    s3Key: string,
    tags: string[],
  ): Promise<void> {
    try {
      const updatePromises = tags.map(async (tag) => {
        const { sk, hashed } = this.tagMappingSortKey(tag, s3Key);
        const updateCommand = new UpdateItemCommand({
          TableName: this.config.tableName,
          Key: {
            pk: { S: this.config.buildId },
            sk: { S: sk },
          },
          // Deliberately no `revalidatedAt`: a mapping row records only that an
          // entry carries the tag. Stamping it at write time made every tagged
          // entry look revalidated one millisecond after it was stored — the
          // row's timestamp is taken after the entry's `lastModified` — so
          // `checkIfRevalidated` deleted healthy entries and the page
          // re-rendered on every request.
          UpdateExpression:
            "SET createdAt = if_not_exists(createdAt, :now)" +
            (hashed ? ", s3Key = :s3Key" : ""),
          ExpressionAttributeValues: {
            ":now": { N: Date.now().toString() },
            ...(hashed && { ":s3Key": { S: s3Key } }),
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
   * Only the mapping rows: the bare-`tag` marker row `revalidateTag`
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
              TableName: this.config.tableName,
              Key: {
                pk: { S: this.config.buildId },
                sk: { S: this.tagMappingSortKey(tag, s3Key).sk },
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
    ctx: SetCacheHandlerContext,
  ): Promise<string[]> {
    const ctxTags = getTags(ctx);
    if (ctxTags?.length) {
      return ctxTags;
    }
    if (!this.mapsTagsToPaths) {
      return [];
    }
    try {
      const response = await this.bucket.get(s3Key);
      if (!response) {
        return [];
      }
      return entryTags(parseCacheValue(response));
    } catch (error) {
      console.warn(`Failed to read tags of ${s3Key} before deleting:`, error);
      return [];
    }
  }

  /**
   * Whether any of `tags` was revalidated after this entry was stored, and how.
   *
   * Reads the per-tag marker rows `revalidateTag` writes, as this instance
   * tracks them: see `TrackedTagMarkers` for when they are read.
   * Scanning the tag's mapping rows instead would answer the wrong question:
   * those rows exist per cache *key*, so which one a `Limit: 1` query returned
   * depended on sort order, and an entry could be judged against another
   * entry's timestamp.
   *
   * A tag revalidated with a profile only makes the entry *stale*: that is
   * reported to Next.js through its tag manifest (see {@link nextTagsManifest})
   * and answered `"stale"` here, so the entry is served while a background
   * render replaces it. When the manifest cannot be reached a stale entry is
   * reported expired instead - a blocking render, never a stale page presented
   * as fresh.
   */
  private async checkIfRevalidated(
    cacheLastModified: number,
    tags: string[],
  ): Promise<RevalidationState> {
    await this.tags.refresh();
    await this.tags.ensure(tags);
    const state = this.tags.state(tags, cacheLastModified);
    if (state !== "stale") {
      if (state === "expired") {
        this.debug(
          `Tags [${tags}] expired entry created at ${cacheLastModified}`,
        );
      }
      return state;
    }

    const manifest = nextTagsManifest();
    if (!manifest) {
      this.debug(
        `Tags [${tags}] are stale and Next.js's tag manifest is ` +
          `unreachable, expiring the entry instead`,
      );
      return "expired";
    }
    for (const tag of tags) {
      const staleAt = this.tags.get(tag)?.staleAt;
      const existing = manifest.get(tag);
      if (
        staleAt !== undefined &&
        staleAt > cacheLastModified &&
        (existing?.stale ?? 0) < staleAt
      ) {
        manifest.set(tag, { ...existing, stale: staleAt });
      }
    }
    return "stale";
  }
}
