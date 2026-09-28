// eslint-disable-next-line import/no-extraneous-dependencies
import {
  S3Client,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  DeleteObjectsCommand,
  _Object,
} from "@aws-sdk/client-s3";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";

const debug = getDebug("cdk-nextjs:post-deploy:prune-cache-bucket");

const s3Client = new S3Client();

interface PruneCacheBucketProps {
  bucketName: string;
  currentBuildId: string;
}

/**
 * Given `bucketName` and `currentBuildId`, delete every cache object that isn't
 * under the current build's `{buildId}/` prefix (no leading slash).
 *
 * The top level is listed with a delimiter, so the current build, which can
 * hold any number of `'use cache: remote'` entries, is never walked. Each old
 * build prefix is then listed and deleted page by page. Top-level keys outside
 * any build prefix (legacy objects) are deleted too.
 */
export async function pruneCacheBucket(props: PruneCacheBucketProps) {
  const { bucketName, currentBuildId } = props;

  const oldPrefixes: string[] = [];
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const page: ListObjectsV2CommandOutput = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Delimiter: "/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const { Prefix } of page.CommonPrefixes ?? []) {
      if (Prefix && Prefix !== `${currentBuildId}/`) oldPrefixes.push(Prefix);
    }
    deleted += await deleteObjects(bucketName, page.Contents);
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  debug(`Found ${oldPrefixes.length} old build prefixes to delete`);

  for (const prefix of oldPrefixes) {
    continuationToken = undefined;
    do {
      const page: ListObjectsV2CommandOutput = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      deleted += await deleteObjects(bucketName, page.Contents);
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  }

  debug(
    `Cache bucket pruning complete. Deleted ${deleted} objects from ${bucketName}`,
  );
}

/**
 * Delete one listed page of objects. ListObjectsV2 returns at most 1000 keys a
 * page, which is also the DeleteObjects limit, so a page is one request.
 * Returns how many objects were sent for deletion.
 */
async function deleteObjects(bucketName: string, contents: _Object[] = []) {
  const objects = contents
    .filter((obj) => obj.Key)
    .map((obj) => ({ Key: obj.Key! }));
  if (objects.length === 0) return 0;
  try {
    debug(
      `Deleting cache objects: ${objects.map((o) => o.Key)} from ${bucketName}`,
    );
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: objects },
      }),
    );
  } catch (error) {
    console.error("Error deleting cache objects:", error);
  }
  return objects.length;
}
