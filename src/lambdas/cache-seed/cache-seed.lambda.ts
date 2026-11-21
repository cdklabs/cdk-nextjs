import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import { seedCache, SeedCacheResult } from "./seed-cache";
import { CacheSeedCustomResourceProperties } from "../../nextjs-cache-seed";
import { cfnResponse, CfnResponseStatus } from "../utils";

const debug = getDebug("cdk-nextjs:cache-seed");

/**
 * Stop starting copies this long before the Lambda would time out: a tenth of
 * the time left, at least 5 s for the copies in flight, the marker and the
 * response to CloudFormation, and at most 30 s. The 5 s floor is itself capped
 * at half the time left, so even a very short timeout override leaves time to
 * copy.
 */
const DEADLINE_MARGIN_MS = 30_000;
const MIN_DEADLINE_MARGIN_MS = 5_000;

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
  // Never `ResponseURL`: it is presigned, and anyone who can read the logs
  // could answer CloudFormation for this resource with it.
  const { ResponseURL: _, ...loggable } = event as { ResponseURL?: string };
  debug({ event: loggable });
  const remaining = context.getRemainingTimeInMillis();
  const deadline =
    Date.now() +
    remaining -
    Math.min(
      DEADLINE_MARGIN_MS,
      Math.max(Math.min(MIN_DEADLINE_MARGIN_MS, remaining / 2), remaining / 10),
    );
  if (!("RequestType" in event)) {
    // Without it the seed would look under `_seed/undefined/`, find nothing and
    // report `no-seed`, which reads as success.
    if (typeof event.buildId !== "string" || !event.buildId) {
      throw new Error('Invoke the cache seeder with { "buildId": "..." }');
    }
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
