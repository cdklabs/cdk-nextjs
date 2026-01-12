// eslint-disable-next-line import/no-extraneous-dependencies
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  ListObjectsV2CommandInput,
} from "@aws-sdk/client-s3";
import { debug } from "../utils";

const s3Client = new S3Client();

interface PruneCacheBucketProps {
  bucketName: string;
  currentBuildId: string;
}

/**
 * Given `bucketName` and `currentBuildId`, list all objects in the cache bucket
 * and delete any that have BUILD_ID prefixes that don't match the current build ID.
 * Cache objects are prefixed with {buildId}/ pattern (no leading slash).
 */
export async function pruneCacheBucket(props: PruneCacheBucketProps) {
  const { bucketName, currentBuildId } = props;

  const objectsToDelete: { Key: string }[] = [];
  let continuationToken: string | undefined = undefined;
  let listObjectsCount = 0;

  do {
    // List objects in the bucket
    const listObjectsV2Input: ListObjectsV2CommandInput = {
      Bucket: bucketName,
      ContinuationToken: continuationToken,
    };
    const listResponse = await s3Client.send(
      new ListObjectsV2Command(listObjectsV2Input),
    );

    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      break;
    }

    // Filter objects that have old BUILD_ID prefixes
    const oldCacheObjects = listResponse.Contents.filter((obj) => {
      if (!obj.Key) return false;

      // Check if the object key starts with a BUILD_ID prefix pattern
      // Expected pattern: {buildId}/* (buildId followed by slash, no leading slash)
      // Regex /^([^\/]+)\// matches: BUILD_ID/... and captures BUILD_ID in group 1
      // Example: "abc123def456/pages/index.html" captures "abc123def456"
      const buildIdMatch = obj.Key.match(/^([^\/]+)\//);
      if (buildIdMatch) {
        const objectBuildId = buildIdMatch[1]; // Extract BUILD_ID from capture group
        // Delete if it's not the current build ID
        return objectBuildId !== currentBuildId;
      }

      // Also delete objects that don't follow the BUILD_ID prefix pattern
      // These might be legacy cache objects or objects with leading slashes
      return true;
    });

    debug(
      `Found ${oldCacheObjects.length} cache objects with old BUILD_ID prefixes to delete`,
    );

    // Add objects to delete list
    objectsToDelete.push(
      ...oldCacheObjects
        .filter((obj) => obj.Key)
        .map((obj) => ({ Key: obj.Key! })),
    );

    if (listResponse.NextContinuationToken) {
      continuationToken = listResponse.NextContinuationToken;
    }
    listObjectsCount++;
    // assume less than 100K objects (100 * 1K objects per ListObjectsV2Command = 100K)
  } while (continuationToken && listObjectsCount <= 100);

  // Delete objects in parallel batches (respecting S3's 1000 objects per request limit)
  if (objectsToDelete.length > 0) {
    const deleteBatches = [];

    for (let i = 0; i < objectsToDelete.length; i += 1000) {
      const batch = objectsToDelete.slice(i, i + 1000);
      deleteBatches.push(batch);
    }

    await processBatch(
      deleteBatches,
      5, // Process up to 5 delete batches in parallel
      async (batch) => {
        try {
          debug(
            `Deleting cache objects: ${batch.map((b) => b.Key)} from ${bucketName}`,
          );
          await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: { Objects: batch },
            }),
          );
          debug(`Deleted ${batch.length} cache objects from ${bucketName}`);
        } catch (error) {
          console.error("Error deleting cache objects:", error);
        }
      },
    );
  }

  debug(
    `Cache bucket pruning complete. Deleted ${objectsToDelete.length} objects from ${bucketName}`,
  );
}

/**
 * Process objects in batches to avoid overwhelming the system
 */
async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  processFn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);
  }

  return results;
}
