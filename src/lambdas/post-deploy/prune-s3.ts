// eslint-disable-next-line import/no-extraneous-dependencies
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2CommandInput,
} from "@aws-sdk/client-s3";
import { debug } from "../utils";

const s3Client = new S3Client();
// Maximum number of concurrent operations
const MAX_CONCURRENT_OPERATIONS = 50;

interface PruneS3Props {
  bucketName: string;
  currentBuildId: string;
  /**
   * Time to live in milliseconds.
   */
  msTtl: number;
}

/**
 * Given `bucketName`, `currentBuildId`, and `msTtl`, list all objects
 * in the bucket and delete any that 1/ do not have a metadata key of "next-build-id"
 * and value of `currentBuildId` and 2/ were created more than `msTtl` ago
 */
export async function pruneS3(props: PruneS3Props) {
  const { bucketName, currentBuildId, msTtl } = props;

  const cutoffDate = new Date(Date.now() - msTtl);
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

    // Filter out objects without keys
    const oldObjects = listResponse.Contents.filter((obj) => {
      const lastModified = obj.LastModified || new Date();
      return obj.Key && lastModified < cutoffDate;
    });
    debug(
      `Checking old objects metadata to determine pruning: ${oldObjects.map((o) => o.Key)}`,
    );

    // Process objects in parallel with controlled concurrency
    const checkResults = await processBatch(
      oldObjects,
      MAX_CONCURRENT_OPERATIONS,
      async (object) => {
        if (!object.Key) return null;

        try {
          const headResponse = await s3Client.send(
            new HeadObjectCommand({
              Bucket: bucketName,
              Key: object.Key,
            }),
          );

          const objectBuildId = headResponse.Metadata?.["next-build-id"];

          // Return the key if it should be deleted
          if (objectBuildId !== currentBuildId) {
            return { Key: object.Key };
          }
        } catch (error) {
          console.error(`Error checking object ${object.Key}:`, error);
        }

        return null;
      },
    );

    // Add valid objects to delete list
    objectsToDelete.push(
      ...(checkResults.filter(Boolean) as { Key: string }[]),
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
            `Deleting objects: ${batch.map((b) => b.Key)} from ${bucketName}`,
          );
          await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: { Objects: batch },
            }),
          );
          debug(`Deleted ${batch.length} objects from ${bucketName}`);
        } catch (error) {
          console.error("Error deleting objects:", error);
        }
      },
    );
  }

  debug(
    `Pruning complete. Deleted ${objectsToDelete.length} objects from ${bucketName}`,
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
