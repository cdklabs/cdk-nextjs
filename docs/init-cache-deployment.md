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
2. If found, it uses `BucketDeployment` with a `{buildId}/` prefix to upload all pre-built cache files to S3
3. Files are deployed to S3 with the path structure: `{buildId}/{cacheKey}.json`

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

**Solution:** Local files are stored as `{cacheKey}.json`, and BucketDeployment adds the `{buildId}/` prefix during upload, resulting in the final S3 path:

```
{buildId}/{cacheKey}.json
```

### 3. Missing Critical Metadata ✅ SOLVED

**Solution:** Local files include:

- Tag associations for `revalidateTag()` functionality
- Timestamps for revalidation checking
- Proper JSON serialization with special handling for Map/Buffer

## Implementation Details

### Modified Files

1. **`cache-handler.ts`** - Detects build vs runtime and routes to appropriate handler
2. **`local-file-cache-handler.ts`** (NEW) - Writes cache files during build
3. **`nextjs-cache.ts`** - Deploys pre-built cache files via BucketDeployment
4. **`nextjs-build.ts`** - Sets `BUILD_OUTPUT_PATH` and `CDK_NEXTJS_BUILD_ID` env vars
5. **`nextjs-base-construct.ts`** - Passes `buildOutputPath` to NextjsCache

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
