// eslint-disable-next-line import/no-extraneous-dependencies
import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import { CACHE_SEED_PREFIX, CACHE_SEEDED_MARKER } from "../../constants";

const debug = getDebug("cdk-nextjs:cache-seed");

const s3Client = new S3Client();

/** Copies in flight at once. Each is a server-side CopyObject, so cheap. */
const COPY_CONCURRENCY = 32;

export interface SeedCacheProps {
  readonly bucketName: string;
  readonly buildId: string;
  /**
   * Epoch ms after which no further copy starts and the seed fails, so a
   * custom resource reports FAILED before its Lambda times out rather than
   * leaving CloudFormation waiting an hour for a response.
   */
  readonly deadline?: number;
}

export interface SeedCacheResult {
  /**
   * - `already-seeded`: `<buildId>/.seeded` exists, nothing was copied.
   * - `no-seed`: `_seed/<buildId>/` is empty or missing, nothing was copied
   *   and no marker was written.
   * - `seeded`: the seed was copied and the marker written.
   */
  readonly status: "already-seeded" | "no-seed" | "seeded";
  /** Objects copied into `<buildId>/`. */
  readonly copied: number;
  /** Objects left alone because `<buildId>/` already had that key. */
  readonly skipped: number;
}

/**
 * Copy the init cache from `_seed/<buildId>/` into `<buildId>/`, once per
 * build, without overwriting anything the app has written there.
 *
 * - If `<buildId>/.seeded` exists, nothing is copied. A CloudFormation rollback
 *   re-runs the previous build's seeding with its old properties, and so does a
 *   re-deploy of the same build; by then the app may have regenerated entries,
 *   or deleted them, and the build-time copy must not come back.
 * - Every copy is conditional on the destination key not existing
 *   (`If-None-Match: *`), so an entry the app wrote first - for a request it
 *   served while a previous attempt was seeding - wins. That also makes a retry
 *   after a partial seed safe: what made it the first time is skipped.
 * - The marker is written last, and only when there was a seed to copy and every
 *   object was either copied or skipped. A failure throws without it, so the
 *   next attempt copies what is still missing.
 */
export async function seedCache(
  props: SeedCacheProps,
): Promise<SeedCacheResult> {
  const { bucketName, buildId, deadline = Infinity } = props;
  const markerKey = `${buildId}/${CACHE_SEEDED_MARKER}`;

  if (await objectExists(bucketName, markerKey)) {
    debug(`${markerKey} exists, skipping seed`);
    return { status: "already-seeded", copied: 0, skipped: 0 };
  }

  const sourcePrefix = `${CACHE_SEED_PREFIX}/${buildId}/`;
  let listed = 0;
  let copied = 0;
  let skipped = 0;
  let continuationToken: string | undefined;
  do {
    checkDeadline(deadline, copied, skipped);
    const page: ListObjectsV2CommandOutput = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: sourcePrefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter(
        (key): key is string => !!key && key.length > sourcePrefix.length,
      );
    listed += keys.length;
    await forEachConcurrently(keys, COPY_CONCURRENCY, async (sourceKey) => {
      checkDeadline(deadline, copied, skipped);
      const destinationKey = `${buildId}/${sourceKey.slice(sourcePrefix.length)}`;
      if (await copyIfAbsent(bucketName, sourceKey, destinationKey, deadline)) {
        copied++;
      } else {
        skipped++;
      }
    });
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  if (listed === 0) {
    console.warn(
      `No init cache under ${sourcePrefix} in ${bucketName}; nothing to seed`,
    );
    return { status: "no-seed", copied, skipped };
  }

  await putMarker(bucketName, markerKey);
  debug(`Seeded ${buildId}: copied ${copied}, skipped ${skipped}`);
  return { status: "seeded", copied, skipped };
}

function checkDeadline(deadline: number, copied: number, skipped: number) {
  if (Date.now() > deadline) {
    throw new Error(
      `Cache seeding ran out of time after copying ${copied} and skipping ${skipped} objects; the next attempt skips what this one copied, though it still asks S3 for each key, so a seed this size may need a longer timeout`,
    );
  }
}

/**
 * Run `fn` over `items`, at most `limit` at a time. Rejects on the first error,
 * after which no worker starts another item.
 */
async function forEachConcurrently<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (!failed && next < items.length) {
        try {
          await fn(items[next++]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Attempts at a copy S3 answers with 409, a conditional write racing it, with
 * exponential backoff from 100 ms between them: about 1.5 s in all.
 */
const CONFLICT_ATTEMPTS = 5;

/**
 * Copy `sourceKey` to `destinationKey` unless the destination exists. Returns
 * whether it copied.
 *
 * 412 is S3 saying the destination exists. 409 is another conditional write to
 * the same key still in progress - the app's, or an overlapping seed's, which
 * may yet fail - so the copy is retried, and a 412 then means that write landed
 * and wins. One that still conflicts, or would retry past `deadline`, throws, so
 * no marker is written and the next attempt fills the key in.
 */
async function copyIfAbsent(
  bucketName: string,
  sourceKey: string,
  destinationKey: string,
  deadline: number,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucketName,
          Key: destinationKey,
          CopySource: `${bucketName}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (error) {
      const status = httpStatus(error);
      if (status === 412) {
        debug(`${destinationKey} already written, skipping`);
        return false;
      }
      const backoff = 100 * 2 ** (attempt - 1);
      if (
        status !== 409 ||
        attempt >= CONFLICT_ATTEMPTS ||
        Date.now() + backoff > deadline
      ) {
        throw error;
      }
      debug(`${destinationKey} has a conflicting write, retrying`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

async function objectExists(bucketName: string, key: string): Promise<boolean> {
  try {
    await s3Client.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: key }),
    );
    return true;
  } catch (error) {
    if (httpStatus(error) === 404) return false;
    throw error;
  }
}

/** Write the marker. One that already exists (412) is just as good. */
async function putMarker(bucketName: string, key: string): Promise<void> {
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: new Date().toISOString(),
        ContentType: "text/plain",
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (httpStatus(error) !== 412) throw error;
  }
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}
