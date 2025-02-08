// eslint-disable-next-line import/no-extraneous-dependencies
import { S3Client } from "@aws-sdk/client-s3";
import { join, relative } from "node:path";

export const s3 = new S3Client({});

interface CreateS3KeyProps {
  keyPrefix?: string;
  path: string;
  basePath: string;
}
/**
 * Create S3 Key given local path
 */
export function createS3Key({ keyPrefix, path, basePath }: CreateS3KeyProps) {
  const objectKeyParts: string[] = [];
  if (keyPrefix) objectKeyParts.push(keyPrefix);
  objectKeyParts.push(relative(basePath, path));
  return join(...objectKeyParts);
}
