// eslint-disable-next-line import/no-extraneous-dependencies
import {
  ListObjectsV2Command,
  ListObjectsV2CommandInput,
} from "@aws-sdk/client-s3";
import { s3 } from "./s3";
import type { PruneS3Action } from "../../nextjs-assets-deployment";

/**
 * Safely removes assets that were deployed > 1 deployment ago AND were deployed
 * greater than a month ago. Those values should be configurable.
 */
export async function pruneS3(props: PruneS3Action) {
  props;
}

interface ListObjectKeysProps {
  bucketName: string;
  keyPrefix?: string;
}

/**
 * List all object keys in bucket
 */
export async function listObjectKeys({
  bucketName,
  keyPrefix,
}: ListObjectKeysProps): Promise<string[]> {
  const oldObjectKeys: string[] = [];
  let nextToken: string | undefined = undefined;
  do {
    const cmd: ListObjectsV2CommandInput = {
      Bucket: bucketName,
      Prefix: keyPrefix,
    };
    if (nextToken) {
      cmd.ContinuationToken = nextToken;
    }
    const res = await s3.send(new ListObjectsV2Command(cmd));
    const contents = res.Contents;
    nextToken = res.NextContinuationToken;
    if (contents?.length) {
      for (const { Key: key } of contents) {
        if (key) {
          oldObjectKeys.push(key);
        }
      }
    }
  } while (nextToken);
  return oldObjectKeys;
}
