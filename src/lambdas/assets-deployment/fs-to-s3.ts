import { createReadStream } from "node:fs";
import { join, relative } from "node:path";
// eslint-disable-next-line import/no-extraneous-dependencies
import { PutObjectCommandInput } from "@aws-sdk/client-s3";
// eslint-disable-next-line import/no-extraneous-dependencies
import { Upload } from "@aws-sdk/lib-storage";
// eslint-disable-next-line import/no-extraneous-dependencies
import * as mime from "mime-types";
import { chunkArray, listFilePaths } from "./common";
import { s3 } from "./s3";
import { debug } from "./utils";
import type { FsToS3Action } from "../../nextjs-assets-deployment";

export async function fsToS3(props: FsToS3Action) {
  const { destinationBucketName, destinationKeyPrefix, sourcePath } = props;
  const sourceFilePaths = listFilePaths(sourcePath);
  for await (const filePathChunk of chunkArray(sourceFilePaths, 100)) {
    const putObjectInputs: PutObjectCommandInput[] = filePathChunk.map(
      (path) => {
        const contentType = mime.lookup(path) || undefined;
        const key = createS3Key({
          keyPrefix: destinationKeyPrefix,
          path,
          basePath: sourcePath,
        });
        return {
          Body: createReadStream(path),
          Bucket: destinationBucketName,
          ContentType: contentType,
          Key: key,
        };
      },
    );
    debug({ putObjectInputs });
    await Promise.all(
      putObjectInputs.map((input) =>
        new Upload({ client: s3, params: input }).done(),
      ),
    );
  }
}

interface CreateS3KeyProps {
  keyPrefix?: string;
  path: string;
  basePath: string;
}
/**
 * Create S3 Key given local path
 */
function createS3Key({ keyPrefix, path, basePath }: CreateS3KeyProps) {
  const objectKeyParts: string[] = [];
  if (keyPrefix) objectKeyParts.push(keyPrefix);
  objectKeyParts.push(relative(basePath, path));
  return join(...objectKeyParts);
}
