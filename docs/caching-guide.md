# Next.js Caching Guide for cdk-nextjs

This guide explains how cdk-nextjs enables and optimizes the different types of Next.js caching mechanisms using cloud-native AWS services.

## Overview

Next.js uses multiple caching layers to improve performance and reduce costs. cdk-nextjs provides cloud-native implementations for these caching mechanisms using S3, DynamoDB, and CloudFront, eliminating the need for expensive VPC/NAT Gateway configurations while maintaining optimal performance.

## Next.js Caching Mechanisms

### 1. Request Memoization

**What**: Automatic deduplication of fetch requests with the same URL and options within a single React component tree render.
**Where**: Server (during rendering)
**Duration**: Per-request lifecycle
**cdk-nextjs Implementation**: Handled natively by Next.js - no additional infrastructure needed.

### 2. Data Cache (Fetch Cache)

**What**: Persistent cache for data fetched using the `fetch()` API or third-party libraries.
**Where**: Server
**Duration**: Persistent (can be revalidated)
**cdk-nextjs Implementation**:

- **Storage**: S3 bucket with BUILD_ID prefixing (`/{buildId}/fetch-cache/`)
- **Custom Cache Handler**: S3CacheHandler manages read/write operations
- **Revalidation**: DynamoDB table tracks tag-based revalidation metadata

### 3. Full Route Cache (App Router Cache)

**What**: Cached HTML and React Server Component (RSC) payloads for statically rendered routes.
**Where**: Server
**Duration**: Persistent (can be revalidated)
**cdk-nextjs Implementation**:

- **Storage**: S3 bucket with BUILD_ID prefixing (`/{buildId}/pages/`, `/{buildId}/app/`)
- **File Types**: `.html`, `.rsc`, `.body`, `.meta` files
- **ISR Support**: Files updated during Incremental Static Regeneration
- **Revalidation**: Tag-based invalidation via DynamoDB tracking

### 4. Router Cache (Client-side)

**What**: Client-side cache of RSC payloads to reduce server requests during navigation.
**Where**: Client browser
**Duration**: User session or time-based
**cdk-nextjs Implementation**: Handled natively by Next.js client - no server infrastructure needed.

## cdk-nextjs Cache Architecture

### S3 Cache Storage

cdk-nextjs uses a dedicated S3 bucket for cache storage with BUILD_ID prefixing for deployment isolation:

```
Cache Bucket Structure:
/{buildId}/
├── {nextjs-generated-cache-keys}  # Next.js determines the cache key structure
│   ├── fetch-cache/               # Data Cache (fetch requests)
│   │   └── {hash}                # Cached fetch responses
│   ├── app/                      # App Router cache files
│   │   └── {route-path}/
│   │       ├── page.html
│   │       ├── page.rsc
│   │       ├── page.body
│   │       └── page.meta
│   └── pages/                    # Pages Router cache files
│       └── {route-path}.html
```

**Note**: The exact cache key structure is determined by Next.js internally. The cache handler receives these keys from Next.js and adds BUILD_ID prefixing for deployment isolation.

### DynamoDB Revalidation Tracking

A DynamoDB table tracks tag-to-cache-key mappings for efficient revalidation:

```typescript
interface RevalidationItem {
  tag: string; // Partition Key: "{buildId}#{tag}"
  cacheKey: string; // Sort Key: cache identifier
  createdAt: number; // Creation timestamp
  revalidatedAt: number; // Last revalidation timestamp
}
```

**Example Data**:

```
PK: "build-abc123#user-profile"    SK: "/api/users/123"
PK: "build-abc123#user-profile"    SK: "/users/profile"
PK: "build-abc123#product-data"    SK: "/products/electronics"
```

### Custom Cache Handler

The S3CacheHandler implements Next.js's cache interface:

```typescript
export default class S3CacheHandler {
  async get(cacheKey: string): Promise<CacheHandlerValue | null>;
  async set(
    cacheKey: string,
    data: IncrementalCacheValue,
    ctx: { tags: string[] },
  ): Promise<void>;
  async revalidateTag(tag: string): Promise<void>;
  async resetRequestCache(): Promise<void>;
}
```

**Example `data` Values**

```json
{
  "kind": "IMAGE",
  "buffer": {
    "type": "Buffer",
    "data": [
      255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 72, 0, 72, 0,
      ...
    ]
  },
  "etag": "Vy8iOGRmMC0xOWJhZmFlMjA1OCI",
  "extension": "jpeg",
  "upstreamEtag": "Vy8iOGRmMC0xOWJhZmFlMjA1OCI",
  "revalidate": 14400
}
```

**Key Features**:

- **BUILD_ID Isolation**: All cache keys prefixed with `/{buildId}/`
- **Next.js Cache Key Passthrough**: Preserves Next.js internal cache key structure
- **Circuit Breaker**: Graceful degradation when S3/DynamoDB unavailable
- **In-Memory Fallback**: Local cache when cloud services fail
- **Tag-based Revalidation**: Efficient cache invalidation using DynamoDB

## Static Assets vs Cache Assets

### Static Assets (NextjsStaticAssets)

**Purpose**: Serve unchanging build artifacts via CloudFront CDN
**Storage**: Dedicated S3 bucket
**Content**:

- `public/` folder contents
- `.next/static/` build artifacts (JS, CSS, images)
- BUILD_ID metadata for pruning

**CloudFront Integration**:

- Requests to `/_next/static/*` → S3 bucket
- Requests to `/public/*` → S3 bucket
- Long-term caching headers for performance

### Cache Assets (S3CacheHandler)

**Purpose**: Store dynamic cache data that changes during runtime
**Storage**: Separate S3 cache bucket
**Content**:

- Data Cache (fetch responses)
- Full Route Cache (HTML, RSC payloads)
- ISR-generated content

## Revalidation and Cache Invalidation

### On-Demand Revalidation

When `revalidateTag("user-profile")` is called:

1. **Query DynamoDB**: Find all cache keys tagged with `{buildId}#user-profile`
2. **Delete S3 Objects**: Remove corresponding cache files from S3
3. **Update Timestamps**: Mark revalidation time in DynamoDB
4. **Clear Memory**: Remove entries from in-memory cache

### Time-based Revalidation

For routes with `revalidate: 3600`:

- Next.js checks cache age before serving
- Triggers background regeneration when expired
- Updates cache files in S3 automatically

### Tag-based Revalidation

```typescript
// In your API route or Server Action
import { revalidateTag } from "next/cache";

export async function updateUser(userId: string) {
  // Update user data
  await updateUserInDatabase(userId);

  // Invalidate all cache entries tagged with this user
  revalidateTag(`user-${userId}`);
  revalidateTag("user-list");
}
```

## Deployment Isolation and Pruning

### BUILD_ID Isolation

Every deployment gets a unique BUILD_ID that isolates cache data:

- **S3 Cache Keys**: `/{buildId}/cache/{cacheKey}`
- **DynamoDB Tags**: `{buildId}#{tag}`
- **Static Assets**: Metadata includes `next-build-id: {buildId}`

### Automatic Pruning (NextjsPostDeploy)

After each successful deployment, old cache data is cleaned up:

#### S3 Cache Bucket Pruning

```typescript
// Remove objects with old BUILD_ID prefixes
// Pattern: /{oldBuildId}/* → DELETE
// Keep: /{currentBuildId}/* → RETAIN
```

#### DynamoDB Revalidation Pruning

```typescript
// Remove entries with old BUILD_ID prefixes
// Pattern: {oldBuildId}#{tag} → DELETE
// Keep: {currentBuildId}#{tag} → RETAIN
```

#### Static Assets Pruning

```typescript
// Remove objects older than msTtl (default: 30 days)
// with different next-build-id metadata
// Prevents version skew while allowing gradual cleanup
```

### Pruning Benefits

1. **Cost Optimization**: Removes unused cache data
2. **Deployment Safety**: Isolates deployments during rollout
3. **Version Skew Protection**: Keeps recent static assets for users with stale tabs
4. **Storage Management**: Prevents unlimited cache growth

## Performance Characteristics

### S3 Cache Operations

- **Read Latency**: ~10-50ms (regional S3)
- **Write Latency**: ~20-100ms (with DynamoDB update)
- **Throughput**: Scales automatically with demand
- **Cost**: Pay-per-request, no minimum charges

### DynamoDB Revalidation

- **Query Latency**: ~1-5ms (single partition key lookup)
- **Scalability**: Handles millions of cache entries
- **Cost**: Minimal - only pays for actual reads/writes
- **Consistency**: Eventually consistent (sufficient for cache invalidation)

### Circuit Breaker Protection

- **S3 Failures**: Falls back to in-memory cache
- **DynamoDB Failures**: Continues without revalidation tracking
- **Automatic Recovery**: Resets after successful operations
- **Monitoring**: Detailed error categorization and logging

## Configuration Examples

### Basic Setup

```typescript
import { NextjsGlobalFunctions } from "cdk-nextjs";

new NextjsGlobalFunctions(this, "NextjsApp", {
  buildDirectory: "./my-nextjs-app",
  // Cache infrastructure created automatically
});
```

### Environment Variables (Set Automatically)

```bash
CDK_NEXTJS_CACHE_BUCKET_NAME=my-app-cache-bucket
CDK_NEXTJS_REVALIDATION_TABLE_NAME=my-app-revalidation-table
CDK_NEXTJS_BUILD_ID=abc123def456
AWS_REGION=us-east-1
```

### Custom Cache Configuration

```typescript
// In your Next.js app
export async function generateStaticParams() {
  const posts = await fetch("https://api.example.com/posts", {
    next: {
      revalidate: 3600, // Time-based revalidation
      tags: ["blog-posts"], // Tag-based revalidation
    },
  });
  return posts.json();
}
```

## Best Practices

### Cache Strategy

1. **Use Tags Liberally**: Enable fine-grained invalidation
2. **Appropriate Revalidation**: Balance freshness vs performance
3. **Monitor Cache Hit Rates**: Optimize cache effectiveness
4. **Test Revalidation**: Verify cache invalidation works correctly

### Performance Optimization

1. **Minimize Cache Misses**: Use consistent cache keys
2. **Batch Revalidations**: Group related tag invalidations
3. **Monitor Latency**: Track S3/DynamoDB response times
4. **Use CDN Effectively**: Leverage CloudFront for static assets

### Cost Management

1. **Regular Pruning**: Ensure old cache data is cleaned up
2. **Monitor Storage**: Track S3 bucket growth
3. **Optimize Requests**: Minimize unnecessary cache operations
4. **Use Lifecycle Policies**: Automate old data cleanup

## Troubleshooting

### Cache Not Working

1. Check environment variables are set correctly
2. Verify S3 bucket and DynamoDB table exist
3. Check Lambda/container permissions
4. Review CloudWatch logs for errors

### Revalidation Issues

1. Verify tags are set correctly in fetch requests
2. Check DynamoDB for tag-to-cache-key mappings
3. Ensure revalidateTag() calls are working
4. Monitor S3 object deletions

### Performance Problems

1. Check S3 request latency in CloudWatch
2. Monitor DynamoDB throttling
3. Review circuit breaker status
4. Verify regional S3 bucket placement

This comprehensive caching system provides the performance benefits of Next.js caching while leveraging AWS's scalable, cost-effective infrastructure.
