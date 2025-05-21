/*
  This file is compiled as defined in .projenrc.ts to be used as Next.js
  Custom Cache Handler. See: https://nextjs.org/docs/app/api-reference/next-config-js/incrementalCacheHandlerPath
*/
// eslint-disable-next-line import/no-extraneous-dependencies
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
// eslint-disable-next-line import/no-extraneous-dependencies
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
import { CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME } from "../common";

type RevalidateTagResponse = ReturnType<FileSystemCache["revalidateTag"]>;

const sqsClient = new SQSClient();

export default class CacheHandler extends FileSystemCache {
  constructor(options: ConstructorParameters<typeof FileSystemCache>[0]) {
    /**
     * @example `/mnt/cdk-nextjs/{relativePathToPackage}/.next/server`
     * This allows us to tell Next.js `FileSystemCache` to write .next/cache/fetch-cache
     * data and .next/server/app/*.{html,rsc,meta,body} data to our EFS shared
     * file system. Note, we cannot control where optimized images are cached
     * through public Next.js APIs so we must symlink.
     *
     * Note, the `serverDistDir` defaults to current directory of the Next.js
     * app but we cannot use this because 1/ we want to share cache between
     * mutiple functions or containers via EFS mount 2/ lambda cannot write
     * to disk (unless /tmp or EFS mount)
     */
    const cdkNextjsServerDistDir =
      process.env[CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME];
    if (!cdkNextjsServerDistDir) {
      throw new Error(
        `${CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME} environment variable not set`,
      );
    }
    super({ ...options, serverDistDir: cdkNextjsServerDistDir });
  }
  async revalidateTag(tag: string): RevalidateTagResponse {
    console.log({ tag });
    console.log({ this: this });
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: process.env.CDK_NEXTJS_QUEUE_URL,
        MessageBody: tag,
        // MessageGroupId: "", // do i need this?
      }),
    );
    // put message in sqs queue if for full route cache
    return super.revalidateTag(tag);
  }
}
