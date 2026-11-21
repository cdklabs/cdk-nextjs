# Init Cache Deployment

Pre-deployment of Next.js build cache files to S3 has been successfully implemented using a local file-based approach during build time.

## How It Works

### Build Time

1. During `next build`, the cache handler detects it's running in build mode via `NEXT_PHASE === "phase-production-build"`
2. Instead of writing to S3/DynamoDB (which don't have credentials yet), it writes cache entries to local files
3. Files are stored in `.next/cdk-nextjs-init-cache/{cacheKey}.json`
4. Each file contains the full cache structure with tags, timestamps, and serialized data

### Deployment Time

1. The `NextjsCache` construct checks for the `.next/cdk-nextjs-init-cache` directory
2. If found, it copies the directory into a staging directory _under_ a `_seed/{buildId}/` directory and hands that to `BucketDeployment`
3. Files are uploaded to S3 as `_seed/{buildId}/{cacheKey}.json`
4. `NextjsCacheSeed`, a custom resource that runs after the upload, copies them into the live prefix the cache handler uses, `{buildId}/{cacheKey}.json`
5. The compute (each Lambda function, or the ECS service) depends on `NextjsCacheSeed`, so a new build only takes traffic once its cache is seeded

The build ID is in the staged paths rather than in `destinationKeyPrefix` on
purpose: `BucketDeployment` tags its destination bucket with
`aws-cdk:cr-owned:<destinationKeyPrefix>:<hash>`, and an `AWS::S3::Bucket`'s `Tags`
are not hotswappable, so a prefix that changes per build forced a full
CloudFormation deployment every time. See the comment on `createStagingDirectory`
in `src/nextjs-cache.ts`.

### Seeding once per build

The upload goes to `_seed/` rather than straight into `{buildId}/` because of
CloudFormation rollbacks ([#343](https://github.com/cdklabs/cdk-nextjs/issues/343)).
A rollback sends the previous build's `BucketDeployment` an Update with its old
properties, which copies its files again. When those files landed in the live
prefix, every entry the app had regenerated since (`res.revalidate()`, an expired
`revalidate`) or deleted went back to its build-time version.

`NextjsCacheSeed` copies the seed in at most once per build:

- Once `{buildId}/.seeded` exists it copies nothing, so a rollback or a re-deploy of
  the same build leaves the live entries alone.
- Each copy is conditional on the key not existing yet (`If-None-Match: *`), so an
  entry the app has already written wins, and a retry after a partial copy only
  fills in what is missing.
- The marker is written last, and only once every seed object has been copied or
  skipped. A failed seed fails the deployment without it.

Post-deploy prunes every top-level prefix except the current `{buildId}/`, so
`_seed/` is deleted once the build is live; a rollback uploads its seed again.

The first deployment after upgrading to this layout isn't protected on rollback:
the previous build's `BucketDeployment` was synthesized to upload straight into
`{buildId}/`, and a rollback re-runs it as it was. Every deployment after that
one rolls back to a build that seeds through `_seed/`.

### Using `NextjsCache` without a root construct

The four root constructs make their compute wait for the seed. If you compose
`NextjsCache` with compute of your own, do the same, or a request the new build
serves before the seed lands renders on demand and that render then wins over
the seed, since the seed never overwrites a key:

```ts
if (cache.cacheSeed) {
  myService.node.addDependency(cache.cacheSeed.customResource);
}
```

### `cdk deploy --hotswap`

A hotswap uploads the seed, because CDK hotswaps `BucketDeployment`, but it never
runs custom resources, so `NextjsCacheSeed` doesn't copy it in. A hotswapped stack
serves its new build from an unseeded cache: every entry renders on demand the
first time it's requested, until the next full deployment. To seed it without one,
invoke the seeder's Lambda (`nextjsCache.cacheSeed.lambdaFunction`) with
`{ "buildId": "<NextjsBuild.buildId>" }`, as `scripts/e2e-deploy.sh` does for the
harness.

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

**Solution:** Local files are stored as `{cacheKey}.json`, staged under `_seed/{buildId}/` for upload, and copied by `NextjsCacheSeed` to the final S3 path:

```
{buildId}/{cacheKey}.json
```

### 3. Missing Critical Metadata ✅ SOLVED

**Solution:** Local files include:

- Tag associations for `revalidateTag()` functionality
- Timestamps for revalidation checking
- Proper JSON serialization with special handling for Map/Buffer

## Sizing

`BucketDeployment`'s Lambda downloads the asset zip into `/tmp` and extracts it
beside itself, so it needs room for both at once — and CDK gives it 512 MiB of
ephemeral storage and 128 MB of memory by default. An app with many large
prerenders blows through that: 60 pages carrying ~1 MB of RSC each produce a
664 MiB seed directory, and the handler dies with
`OSError: [Errno 28] No space left on device`. Under `cdk deploy --hotswap` that
failure is invisible, because the CLI invokes custom resources with placeholder
response URLs and never reads the status they send — the app comes up serving a
partially seeded cache.

`NextjsCache` therefore sizes that Lambda from the seed directory: twice its size
plus headroom, floored at CDK's 512 MiB and capped at Lambda's 10 GiB, with
`memoryLimit: 1024` past 256 MiB. Above the 10 GiB ceiling it warns; pass
`overrides.bucketDeploymentProps` with `useEfs: true` for a cache that large.

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
3. **`nextjs-cache.ts`** - Uploads pre-built cache files to `_seed/{buildId}/` via BucketDeployment
4. **`nextjs-cache-seed.ts`** / **`lambdas/cache-seed/`** - Copies the seed into `{buildId}/` once per build
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
