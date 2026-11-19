import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import { seedCache, SeedCacheResult } from "./seed-cache";
import { CacheSeedCustomResourceProperties } from "../../nextjs-cache-seed";
import { cfnResponse, CfnResponseStatus } from "../utils";

const debug = getDebug("cdk-nextjs:cache-seed");

/** Stop starting copies this long before the Lambda would time out. */
const DEADLINE_MARGIN_MS = 30_000;

/**
 * Direct invocation, outside CloudFormation: `{ "buildId": "..." }`. A
 * `cdk deploy --hotswap` never runs custom resources, so this is how a
 * hotswapped stack gets seeded (`scripts/e2e-deploy.sh` does it for the
 * harness). Returns the result; failures throw, so the caller sees a
 * FunctionError.
 */
export interface DirectSeedEvent {
  readonly buildId: string;
  /** @default the `CACHE_BUCKET_NAME` environment variable */
  readonly cacheBucketName?: string;
}

type ResourceProps = CacheSeedCustomResourceProperties & {
  ServiceToken: string;
};

/**
 * Copies a build's init cache into its live `<buildId>/` prefix once: see
 * `seedCache`. Runs on Create and Update; Delete leaves the cache alone, since
 * post-deploy prunes old builds.
 */
export async function handler(
  event: CloudFormationCustomResourceEvent | DirectSeedEvent,
  context: Context,
): Promise<SeedCacheResult | void> {
  debug({ event });
  const deadline =
    Date.now() + context.getRemainingTimeInMillis() - DEADLINE_MARGIN_MS;
  if (!("RequestType" in event)) {
    return seedCache({
      bucketName: event.cacheBucketName ?? process.env.CACHE_BUCKET_NAME!,
      buildId: event.buildId,
      deadline,
    });
  }

  let responseStatus = CfnResponseStatus.Failed;
  try {
    if (event.RequestType === "Create" || event.RequestType === "Update") {
      const { buildId, cacheBucketName } =
        event.ResourceProperties as ResourceProps;
      const result = await seedCache({
        bucketName: cacheBucketName,
        buildId,
        deadline,
      });
      console.log(`Cache seed for ${buildId}: ${JSON.stringify(result)}`);
    }
    responseStatus = CfnResponseStatus.Success;
  } catch (err) {
    console.error(err);
  } finally {
    await cfnResponse({
      event,
      context,
      responseStatus,
      // Stable, so an Update never reads as a replacement and CloudFormation
      // never sends the old resource a Delete.
      physicalResourceId:
        event.RequestType === "Create"
          ? "nextjs-cache-seed"
          : event.PhysicalResourceId,
    });
  }
}
