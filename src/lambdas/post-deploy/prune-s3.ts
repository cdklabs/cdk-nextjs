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

interface PruneS3Props {
  bucketName: string;
  currentBuildId: string;
  /**
   * Time to live in milliseconds.
   */
  msTtl: number;
}

/**
 * Given `bucketName`, `currentBuildId`, and `msOldToPrune`, list all objects
 * in the bucket and delete any that 1/ do not have a metadata key of "next-build-id"
 * and value of `currentBuildId` and 2/ were created more than `msOldToPrune` ago
 */
export async function pruneS3(props: PruneS3Props) {
  const { bucketName, currentBuildId, msTtl } = props;

  const cutoffDate = new Date(Date.now() - msTtl);
  const objectsToDelete: { Key: string }[] = [];

  let continuationToken: string | undefined = undefined;

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

    // Check each object
    for (const object of listResponse.Contents) {
      if (!object.Key) continue;

      // Get object metadata
      const headCommand = new HeadObjectCommand({
        Bucket: bucketName,
        Key: object.Key,
      });

      try {
        const headResponse = await s3Client.send(headCommand);
        const objectBuildId = headResponse.Metadata?.["next-build-id"];
        const lastModified = headResponse.LastModified || new Date();

        // Delete if not current build ID and older than cutoff
        if (objectBuildId !== currentBuildId && lastModified < cutoffDate) {
          objectsToDelete.push({ Key: object.Key });
        }
      } catch (error) {
        console.error(`Error checking object ${object.Key}:`, error);
      }
    }

    if (listResponse.NextContinuationToken) {
      continuationToken = listResponse.NextContinuationToken;
    }
  } while (continuationToken);

  // Delete objects in batches of 1000 (S3 limit)
  if (objectsToDelete.length > 0) {
    for (let i = 0; i < objectsToDelete.length; i += 1000) {
      const batch = objectsToDelete.slice(i, i + 1000);

      const deleteCommand = new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: batch },
      });

      try {
        await s3Client.send(deleteCommand);
        debug(`Deleted ${batch.length} objects from ${bucketName}`);
      } catch (error) {
        console.error("Error deleting objects:", error);
      }
    }
  }

  debug(
    `Pruning complete. Deleted ${objectsToDelete.length} objects from ${bucketName}`,
  );
}
