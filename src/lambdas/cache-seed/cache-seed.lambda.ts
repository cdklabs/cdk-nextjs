import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import { seedCache, SeedCacheResult } from "./seed-cache";
import { openZipSeed } from "./zip-seed";
import { cfnResponse, CfnResponseStatus } from "../utils";

const debug = getDebug("cdk-nextjs:cache-seed");

/**
 * Stop starting puts this long before the Lambda would time out: a tenth of
 * the time left, at least 5 s for the puts in flight, the marker and the
 * response to CloudFormation, and at most 30 s. The 5 s floor is itself capped
 * at half the time left, so even a very short timeout override leaves time to
 * seed.
 */
const DEADLINE_MARGIN_MS = 30_000;
const MIN_DEADLINE_MARGIN_MS = 5_000;

/**
 * The `ResponseURL` (and the other request fields) `cdk deploy --hotswap` sends
 * when it invokes a `Custom::CDKBucketDeployment`'s ServiceToken directly,
 * which is what this resource's type is for: see `NextjsCache`. There is no
 * CloudFormation request to answer then.
 */
export const HOTSWAP_RESPONSE_URL = "required-to-be-present-by-cfn";

/**
 * The custom resource's properties, PascalCase as `BucketDeployment`'s are:
 * the hotswap names the change after `DestinationBucketName`. CloudFormation
 * sends every value as a string, and so does the hotswap, which stringifies
 * each one.
 */
export interface CacheSeedResourceProperties {
  /**
   * Build whose `<buildId>/` prefix is seeded. Changes every build, so the
   * resource runs on every deploy.
   */
  readonly BuildId: string;
  readonly DestinationBucketName: string;
  /** The init cache's CDK file asset: a zip. */
  readonly SourceBucketName: string;
  readonly SourceObjectKey: string;
}

/**
 * Seeds a build's `<buildId>/` prefix from its init cache once: see
 * `seedCache`. Runs on Create and Update; Delete leaves the cache alone, since
 * post-deploy prunes old builds.
 *
 * Invoked by CloudFormation, or by `cdk deploy --hotswap` with
 * {@link HOTSWAP_RESPONSE_URL}, which ignores the result: the seed's failure
 * then fails the invoke, for the log, and nothing else.
 */
export async function handler(
  event: CloudFormationCustomResourceEvent,
  context: Context,
): Promise<SeedCacheResult | undefined> {
  // Never `ResponseURL`: it is presigned, and anyone who can read the logs
  // could answer CloudFormation for this resource with it.
  const { ResponseURL, ...loggable } = event;
  debug({ event: loggable });
  const hotswap = ResponseURL === HOTSWAP_RESPONSE_URL;
  const remaining = context.getRemainingTimeInMillis();
  const deadline =
    Date.now() +
    remaining -
    Math.min(
      DEADLINE_MARGIN_MS,
      Math.max(Math.min(MIN_DEADLINE_MARGIN_MS, remaining / 2), remaining / 10),
    );

  let result: SeedCacheResult | undefined;
  let error: unknown;
  try {
    if (event.RequestType === "Create" || event.RequestType === "Update") {
      const properties = readProperties(event.ResourceProperties);
      result = await seedCache({
        bucketName: properties.DestinationBucketName,
        buildId: properties.BuildId,
        deadline,
        openSeed: () =>
          openZipSeed({
            bucketName: properties.SourceBucketName,
            key: properties.SourceObjectKey,
          }),
      });
      console.log(
        `Cache seed for ${properties.BuildId}${hotswap ? " (hotswap)" : ""}: ${JSON.stringify(result)}`,
      );
    }
  } catch (err) {
    error = err;
    console.error(err);
  }

  if (hotswap) {
    if (error) throw error;
    return result;
  }
  await cfnResponse({
    event,
    context,
    responseStatus: error
      ? CfnResponseStatus.Failed
      : CfnResponseStatus.Success,
    // CloudFormation keeps a few KB of it; the message says what to change
    // (a longer timeout, say) without opening the log.
    reason: error ? String(error).slice(0, 1000) : undefined,
    // Stable, so an Update never reads as a replacement and CloudFormation
    // never sends the old resource a Delete.
    physicalResourceId:
      event.RequestType === "Create"
        ? "nextjs-cache-seed"
        : event.PhysicalResourceId,
  });
  return result;
}

const PROPERTY_NAMES = [
  "BuildId",
  "DestinationBucketName",
  "SourceBucketName",
  "SourceObjectKey",
] as const;

/**
 * Each property, which has to be a non-empty string. A hotswap stringifies
 * whatever the template held, so a missing one would arrive as `undefined`
 * and an object as `"[object Object]"`: both fail here rather than seed the
 * wrong prefix.
 */
function readProperties(
  properties: Record<string, unknown>,
): CacheSeedResourceProperties {
  for (const name of PROPERTY_NAMES) {
    const value = properties[name];
    if (typeof value !== "string" || !value || value === "[object Object]") {
      throw new Error(
        `The cache seed's ${name} property must be a non-empty string, not ${JSON.stringify(value)}`,
      );
    }
  }
  return properties as unknown as CacheSeedResourceProperties;
}
