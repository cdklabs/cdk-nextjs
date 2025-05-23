// eslint-disable-next-line import/no-extraneous-dependencies
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { PostDeployCustomResourceProperties } from "../../nextjs-post-deploy";

const cfClient = new CloudFrontClient();

export async function createInvalidation(
  input: NonNullable<
    PostDeployCustomResourceProperties["createInvalidationCommandInput"]
  >,
) {
  return cfClient.send(
    new CreateInvalidationCommand({
      DistributionId: input.distributionId,
      InvalidationBatch: {
        CallerReference: input.invalidationBatch.callerReference,
        Paths: {
          Quantity: input.invalidationBatch.paths.quantity,
          Items: input.invalidationBatch.paths.items,
        },
      },
    }),
  );
}
