/*
  This file is compiled as defined in .projenrc.ts to be used as Next.js
  Custom Cache Handler. See: https://nextjs.org/docs/app/api-reference/next-config-js/incrementalCacheHandlerPath
*/
// eslint-disable-next-line import/no-extraneous-dependencies
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
// eslint-disable-next-line import/no-extraneous-dependencies
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";

type RevalidateTagResponse = ReturnType<FileSystemCache["revalidateTag"]>;

const sqsClient = new SQSClient();

export default class CacheHandler extends FileSystemCache {
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
