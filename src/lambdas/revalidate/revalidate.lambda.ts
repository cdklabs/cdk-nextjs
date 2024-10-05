// eslint-disable-next-line import/no-extraneous-dependencies
import { SQSBatchItemFailure, SQSHandler } from "aws-lambda";

export const handler: SQSHandler = async (event, context) => {
  console.log({ event });
  context;
  const batchItemFailures: SQSBatchItemFailure[] = [];
  try {
    for (const record of event.Records) {
      const url = record.body;
      const previewModeId = process.env.PREVIEW_MODE_ID;
      if (!url) throw new Error("Missing url");
      if (!previewModeId) throw new Error("Missing previewModeId");
      // see: https://github.com/sst/open-next/blob/ab844db7a21a056155992ccf0bdf9b835362cd19/packages/open-next/src/adapters/revalidate.ts#L43
      // Make a HEAD request to the page to revalidate it.
      // - HEAD request is used b/c it's not necessary to make a GET request
      //   and have CloudFront cache the request. This is because the request
      //   does not have real life headers and the cache won't be used anyway.
      // - "previewModeId" is used to ensure the page is revalidated in a
      //   blocking way in lambda
      //   https://github.com/vercel/next.js/blob/1088b3f682cbe411be2d1edc502f8a090e36dee4/packages/next/src/server/api-utils/node.ts#L353
      try {
        const res = await fetch(url, {
          method: "HEAD",
          headers: {
            "x-prerender-revalidate": previewModeId,
            "x-isr": "1",
          },
        });
        const xNextjsCacheHeader = res.headers.get("x-nextjs-cache");
        if (!res.ok || xNextjsCacheHeader !== "REVALIDATED") {
          throw new Error(
            `Response code: ${res.status}, x-nextjs-cache: ${xNextjsCacheHeader}`,
          );
        }
      } catch (err) {
        batchItemFailures.push({
          itemIdentifier: record.messageId,
        });
      }
    }
  } catch (err) {
    console.error(err);
    throw err;
  }
  return {
    batchItemFailures,
  };
};
