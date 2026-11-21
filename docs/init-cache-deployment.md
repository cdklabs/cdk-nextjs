# Init Cache Deployment

Pre-deployment of Next.js build cache files to S3 has been successfully implemented using a local file-based approach during build time.

## How It Works

### Build Time

1. During `next build`, the cache handler detects it's running in build mode via `NEXT_PHASE === "phase-production-build"`
2. Instead of writing to S3/DynamoDB (which don't have credentials yet), it writes cache entries to local files
3. Files are stored in `.next/cdk-nextjs-init-cache/{cacheKey}.json`
4. Each file contains the full cache structure with tags, timestamps, and serialized data

### Deployment Time

1. The `NextjsCache` construct checks `.next/cdk-nextjs-init-cache` for files
2. If it holds any, the directory becomes a CDK file asset, a zip in the bootstrap bucket, as it is: its paths are the keys under `{buildId}/`
3. `NextjsCache.cacheSeed`, a custom resource, downloads the zip into its Lambda's `/tmp` and writes each file to `{buildId}/{cacheKey}.json`, the prefix the cache handler uses
4. The compute (each Lambda function, or the ECS service) and `NextjsPostDeploy` depend on `cacheSeed`, so a new build only takes traffic once its cache is seeded

### Seeding once per build

The seed is never just uploaded into `{buildId}/`, because of CloudFormation
rollbacks ([#343](https://github.com/cdklabs/cdk-nextjs/issues/343)). A rollback
sends the previous build's resources an Update with their old properties. When
that was a `BucketDeployment` into the live prefix, it copied its files again,
and every entry the app had regenerated since (`res.revalidate()`, an expired
`revalidate`) or deleted went back to its build-time version.

`cacheSeed` writes the init cache at most once per build:

- Once `{buildId}/.seeded` exists it writes nothing, and doesn't download the
  zip, so a rollback or a re-deploy of the same build leaves the live entries
  alone.
- Each put is conditional on the key not existing yet (`If-None-Match: *`), so an
  entry the app has already written wins (S3 answers 412), and a retry after a
  partial seed only fills in what is missing. A 409, another conditional write
  to the key still in flight, is retried with backoff.
- The marker is written last, and only once every file has been written or
  skipped. A failed seed fails the deployment without it.

The first deployment after upgrading to 0.8.0 isn't protected on rollback: the
previous build's `BucketDeployment` was synthesized to upload straight into
`{buildId}/`, and a rollback re-runs it as it was. Every deployment after that
one rolls back to a build that seeds through `cacheSeed`. Likewise, if that
first deployment keeps the running build's ID, there is no `{buildId}/.seeded`
marker yet, so the seed is written once more: it fills in only keys that don't
exist, but an entry the app deleted comes back.

"Once per build" is keyed on the build ID alone. A deployment that changes the
init cache but not the build ID (a `generateBuildId` that returns a constant or a
commit SHA, rebuilt with different build-time data) is never seeded again: the
live prefix keeps the entries it has.

### Using `NextjsCache` without a root construct

The four root constructs make their compute wait for the seed. If you compose
`NextjsCache` with compute of your own, do the same, or a request the new build
serves before the seed lands renders on demand and that render then wins over
the seed, since the seed never overwrites a key:

```ts
if (cache.cacheSeed) {
  myService.node.addDependency(cache.cacheSeed);
}
```

### `cdk deploy --hotswap`

A hotswap seeds the cache too. CloudFormation never sees a hotswap, and the CDK
CLI skips custom resources, except those of type `Custom::CDKBucketDeployment`,
`BucketDeployment`'s: it invokes their Lambda directly, with an Update event whose
`ResponseURL` is the placeholder `required-to-be-present-by-cfn`. `cacheSeed` has
that type for this reason, and its Lambda recognizes the placeholder, seeds, and
answers no one.

Two things follow from the CLI handling it:

- The CLI doesn't read the result. A seed that fails during a hotswap is in the
  seeder's log (`/aws/lambda/...CacheSeedFn...`), and the deploy still reports
  success; the next full deployment seeds what is missing.
- It's the CLI's behavior, not a documented contract. If a CDK release stops
  hotswapping that type by name, hotswapped stacks serve their new build from an
  unseeded cache until the next full deployment: every entry renders on demand
  the first time it's requested, and for a `cacheComponents` app that render is
  the postponed shell, not the prerender. A test pins the type
  (`src/nextjs-cache.test.ts`).

The seeder's grants are on whole buckets for the same reason: the CLI skips,
rather than applies, a policy change on a role only `Custom::CDKBucketDeployment`
Lambdas use, so a grant naming this build's asset or prefix would deny the
invoke that follows.

### Runtime

1. Lambda/containers have the cache handler configured with S3/DynamoDB credentials
2. On first request, the pre-deployed cache files are already in S3
3. Cache hits happen immediately without a cold start penalty
4. Tag-based revalidation works because tags are stored in the cached files

## Previous Concerns - Addressed

### 1. Format Mismatch ✅ SOLVED

**Solution:** The `LocalFileCacheHandler` writes files in the EXACT same format as `S3CacheHandler`, including:

- JSON structure with `lastModified`, `value`, and `tags`
- Proper serialization of Maps and Buffers
- Correct path structure

### 2. Path Structure Mismatch ✅ SOLVED

**Solution:** Local files are stored as `{cacheKey}.json`, zipped as they are into the init cache asset, and written by `NextjsCache.cacheSeed` to the final S3 path:

```
{buildId}/{cacheKey}.json
```

### 3. Missing Critical Metadata ✅ SOLVED

**Solution:** Local files include:

- Tag associations for `revalidateTag()` functionality
- Timestamps for revalidation checking
- Proper JSON serialization with special handling for Map/Buffer

## Sizing

The seeder downloads the init cache's zip into `/tmp` and reads it from there,
entry by entry, so it needs room for the zip, and Lambda gives a function
512 MiB of ephemeral storage by default. An app with many large prerenders
outgrows that: 60 pages carrying ~1 MB of RSC each produce a 664 MiB init cache.

`NextjsCache` therefore sizes the seeder from the init cache directory. The zip's
size isn't known at synth time, so it budgets the worst case, a zip as large as
the directory, plus 128 MiB of headroom, rounded up to a power-of-two step
(512 MiB, 1 GiB, 2 GiB...) and capped at Lambda's 10 GiB. The steps keep the
seeder's configuration, which a hotswap can't change, the same while the cache
grows by a little. Memory is 512 MB, and 1024 MB past 256 MiB of cache. Above
the 10 GiB ceiling it warns: unless the zip compresses well the seed fails, and
the way out is fewer build-time prerenders (return fewer params from
`generateStaticParams` and let the rest render on demand).
`overrides.nextjsCache.cacheSeed.functionProps` wins over all of it.

Cache entries themselves serialize Buffers as base64 (`serializeCacheValue` in
`src/adapter/cache-utils.ts`). That matters for size _and_ for read latency:
the integer-array format `Buffer.toJSON()` produces is ~3 bytes of JSON per byte
of payload and makes `JSON.parse`'s reviver run once per element, which cost 4.8s
of Lambda time to answer a single 1 MiB segment prefetch before it was changed.
Both integer-array spellings are still accepted on read.

## Implementation Details

### Modified Files

1. **`cache-handler.ts`** - Detects build vs runtime and routes to appropriate handler
2. **`local-file-cache-handler.ts`** (NEW) - Writes cache files during build
3. **`nextjs-cache.ts`** - Packages the init cache as an asset and creates the `cacheSeed` custom resource and its Lambda
4. **`lambdas/cache-seed/`** - Writes the init cache into `{buildId}/` once per build
5. **`nextjs-build.ts`** - Sets `BUILD_OUTPUT_PATH` and `CDK_NEXTJS_BUILD_ID` env vars
6. **`nextjs-base-construct.ts`** - Passes `buildDirectory` to NextjsCache, and makes the compute wait for the seed

### Environment Variables

During `next build`:

- `NEXT_PHASE=phase-production-build` - Detected automatically by Next.js
- `BUILD_OUTPUT_PATH` - Set by CDK to the build directory
- `CDK_NEXTJS_BUILD_ID` - Set by CDK for cache isolation

### Cache Handler Behavior

**Build Time (`NEXT_PHASE === "phase-production-build"`):**

```typescript
if (isBuildTime && localFileHandler && data) {
  await localFileHandler.set(cacheKey, data, tags);
}
```

**Runtime (deployed Lambda/container):**

```typescript
else {
  await super.set(cacheKey, data, ctx); // Memory + S3/DynamoDB
}
```

## Benefits

1. **Instant Cache Hits** - First request already has cached content
2. **No Cold Start Penalty** - Pre-warmed cache in S3
3. **Proper Format** - Uses exact same structure as runtime caching
4. **Tag Support** - Full `revalidateTag()` functionality preserved
5. **Simple & Reliable** - No format conversion, no reconciliation needed
