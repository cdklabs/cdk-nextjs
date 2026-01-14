# Why Pre-Build Cache Deployment Was Not Implemented

## Summary

Pre-deployment of Next.js build cache files to S3 was explored but ultimately not implemented due to fundamental format incompatibilities between Next.js's build output and the custom S3/DynamoDB cache handler.

## Technical Issues

### 1. Format Mismatch

**Next.js Build Output:**
- Creates files like `page.html`, `page.rsc`, `page.body`, `page.meta`
- Files are in Next.js's internal format
- No tags or metadata for cache invalidation

**S3 Cache Handler (`s3-dynamo-cache-handler.ts`):**
- Stores files as `{buildId}/{kind}/{cacheKey}.json`
- Wraps everything in a JSON structure with timestamps and tags:
  ```json
  {
    "lastModified": 1234567890,
    "value": { "kind": "APP_PAGE", "data": {...} },
    "tags": ["tag1", "tag2"]
  }
  ```
- Uses this metadata for tag-based revalidation

### 2. Path Structure Mismatch

**Build files:**
```
.next/server/app/about/page.html
.next/server/app/about/page.rsc
```

**Cache handler expects:**
```
{buildId}/app_page/about.json
```

### 3. Missing Critical Metadata

Build-time files lack:
- Tag associations for `revalidateTag()` functionality
- Timestamps for revalidation checking
- DynamoDB entries for tag-to-cache-key mappings
- Proper JSON serialization format

## Why Runtime Caching is Better

### 1. Correct Format
The cache handler creates entries in the exact format it expects to read, with proper serialization of Maps, Buffers, and complex objects.

### 2. Tag Support
Runtime caching properly stores tag associations in DynamoDB, enabling `revalidateTag()` to work correctly.

### 3. Simplicity
No need to transform, convert, or reconcile different file formats between build and runtime.

### 4. Fast Enough
First request creates the cache entry. Subsequent requests are instant. The slight delay on first request is acceptable and normal for serverless architectures.

## Conclusion

Runtime-only caching through the S3/DynamoDB cache handler is the correct approach. It ensures format consistency, enables proper tag-based revalidation, and keeps the implementation simple and reliable.
