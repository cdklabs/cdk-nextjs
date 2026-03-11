# Next.js Pruning Guide for cdk-nextjs

This guide explains how cdk-nextjs automatically manages and cleans up cache data and static assets across deployments to optimize costs and prevent storage bloat.

## Overview

cdk-nextjs implements automatic pruning mechanisms to clean up old cache data and static assets after each deployment. This prevents unlimited storage growth while maintaining deployment isolation and safety during rollouts.

## Deployment Isolation and Pruning

### BUILD_ID Isolation

Every deployment gets a unique BUILD_ID that isolates cache data:

- **S3 Cache Keys**: `/{buildId}/{cacheKey}`
- **DynamoDB Revalidation**: Partition key is `buildId`, sort key is `{tag}#{cacheKey}`
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
// 1. Read metadata entry (pk="METADATA", sk="CURRENT_BUILD") to get previous buildId
// 2. Query all entries for previous buildId (efficient partition query)
// 3. Batch delete old entries
// 4. Update metadata with current buildId
// Cost: Only reads previous build's partition, not full table scan
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

## Pruning Process Details

### Cache Bucket Pruning Process

1. **Identify Current BUILD_ID**: Extract from deployment metadata
2. **List S3 Objects**: Scan cache bucket for objects with old BUILD_ID prefixes
3. **Batch Delete**: Remove objects in batches of 1000 (S3 limit)
4. **Preserve Current**: Keep all objects matching current BUILD_ID
5. **Log Results**: Report pruned object count and storage freed

### Static Assets Pruning Process

1. **Query by Metadata**: Find objects with `next-build-id` metadata
2. **Check Age**: Compare object creation time against TTL (default: 30 days)
3. **Version Check**: Only delete if BUILD_ID differs from current
4. **Gradual Cleanup**: Allows time for users with cached pages to transition
5. **Preserve Recent**: Keep recent assets even if BUILD_ID differs

### DynamoDB Pruning Process

1. **Read Metadata**: Get previous BUILD_ID from metadata entry (pk="METADATA", sk="CURRENT_BUILD")
2. **Query Previous Build**: Efficiently query all items where pk=previousBuildId (single partition query)
3. **Batch Delete**: Remove items in batches of 25 (DynamoDB limit)
4. **Update Metadata**: Store current BUILD_ID in metadata entry for next deployment
5. **Log Results**: Report pruned item count

**Cost Efficiency**: Uses Query instead of Scan, only reading items from previous build's partition. Cost scales with previous deployment size, not total table size.

## Pruning Configuration

### Default Settings

```typescript
// Automatic pruning enabled by default
new NextjsGlobalFunctions(this, "NextjsApp", {
  buildDirectory: "./my-nextjs-app",
  // Pruning happens automatically via NextjsPostDeploy
});
```

### Custom TTL for Static Assets

The TTL (Time To Live) for static assets is configurable via the `msTtl` property in custom resource properties:

```typescript
new NextjsGlobalFunctions(this, "NextjsApp", {
  buildDirectory: "./my-nextjs-app",
  overrides: {
    nextjsPostDeploy: {
      customResourceProperties: {
        msTtl: (7 * 24 * 60 * 60 * 1000).toString(), // 7 days (must be string)
      },
    },
  },
});
```

**Note**: The `msTtl` value must be a string due to CloudFormation Custom Resource limitations. The default is 30 days: `(1000 * 60 * 60 * 24 * 30).toString()`.

## Pruning Safety Mechanisms

### Deployment Isolation

- **BUILD_ID Prefixing**: Ensures current deployment data is never deleted
- **Atomic Operations**: Pruning only starts after successful deployment
- **Rollback Protection**: Previous deployment data preserved during rollout window

### Error Handling

- **Partial Failures**: Continue pruning even if some objects fail to delete
- **Retry Logic**: Automatic retries for transient failures
- **Logging**: Detailed logs for troubleshooting pruning issues
- **Graceful Degradation**: Application continues working if pruning fails

## Monitoring Pruning

### CloudWatch Logs

Pruning operations are logged with detailed information when debug mode is enabled:

```
Found 1234 cache objects with old BUILD_ID prefixes to delete
Deleting cache objects: ["/old-build-123/index.html", "/old-build-123/about.rsc"] from my-cache-bucket
Deleted 1234 cache objects from my-cache-bucket
Cache bucket pruning complete. Deleted 1234 objects from my-cache-bucket

Checking old objects metadata to determine pruning: ["/static/js/main.js", "/static/css/app.css"]
Deleting objects: ["/static/js/main.js", "/static/css/app.css"] from my-static-assets-bucket
Deleted 56 objects from my-static-assets-bucket
Pruning complete. Deleted 56 objects from my-static-assets-bucket

Pruning revalidation entries for previous build: old-build-123
Found 789 revalidation entries to delete for build old-build-123
Deleting revalidation entries: user-profile#api-users-123, ... from my-revalidation-table
Deleted 789 revalidation entries from my-revalidation-table
Updated metadata with current build ID: new-build-456
Revalidation table pruning complete. Deleted 789 entries from my-revalidation-table
```

**Note**: Debug logging is enabled by default but can be disabled by setting `debug: false` in NextjsPostDeploy props.

## Cost Impact

### Storage Cost Reduction

- **Cache Bucket**: Prevents unlimited growth of cache data
- **Static Assets**: Removes old build artifacts after TTL
- **DynamoDB**: Keeps revalidation table size manageable

### Request Cost Optimization

- **Fewer Objects**: Reduces S3 LIST operation costs
- **Smaller Scans**: DynamoDB scans process fewer items
- **Batch Operations**: Efficient bulk delete operations

### Example Cost Savings

For a typical application with daily deployments, pruning prevents unlimited storage growth:

- **Without Pruning**: Cache data accumulates indefinitely
- **With Pruning**: Cache data is cleaned up after each deployment
- **Storage Savings**: Varies based on application cache usage patterns

The actual cost savings depend on your application's caching patterns, deployment frequency, and data volume.

## Troubleshooting Pruning

### Pruning Not Running

1. Check NextjsPostDeploy Lambda function logs
2. Verify Lambda has S3 and DynamoDB permissions
3. Ensure deployment completed successfully
4. Check for environment variable configuration

### Incomplete Pruning

1. Review CloudWatch logs for partial failures
2. Check S3 bucket permissions for delete operations
3. Verify DynamoDB table permissions
4. Monitor for throttling or rate limiting

### Performance Issues

1. Monitor pruning duration in CloudWatch
2. Check for large numbers of objects to prune
3. Consider adjusting batch sizes for large datasets
4. Review Lambda timeout settings

### Storage Still Growing

1. Verify BUILD_ID is changing between deployments
2. Check that pruning is not disabled
3. Monitor for failed pruning operations
4. Review static assets TTL configuration

## Best Practices

### Deployment Strategy

1. **Monitor First Deploy**: Watch pruning logs on initial deployment
2. **Gradual Rollout**: Test pruning with staging environments first
3. **Backup Strategy**: Consider S3 versioning for critical data
4. **Regular Monitoring**: Set up alarms for pruning failures

### Performance Optimization

1. **Batch Size Tuning**: Adjust for your object count patterns
2. **Concurrent Operations**: Prune different resources in parallel
3. **Timing Optimization**: Run pruning during low-traffic periods
4. **Resource Limits**: Monitor Lambda memory and timeout settings

### Cost Management

1. **TTL Tuning**: Balance safety vs storage costs
2. **Monitoring Setup**: Track storage usage trends
3. **Regular Reviews**: Periodically audit pruning effectiveness
4. **Lifecycle Policies**: Consider S3 lifecycle rules as backup

This comprehensive pruning system ensures your Next.js application maintains optimal performance and cost efficiency across all deployments while providing safety mechanisms to prevent data loss.
