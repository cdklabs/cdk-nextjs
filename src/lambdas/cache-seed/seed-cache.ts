// eslint-disable-next-line import/no-extraneous-dependencies
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import { CACHE_SEEDED_MARKER } from "../../constants";

const debug = getDebug("cdk-nextjs:cache-seed");

const s3Client = new S3Client();

/** Puts in flight at once. */
const PUT_CONCURRENCY = 32;

/**
 * Bytes of entries read into memory at once. Each is held whole, about twice
 * over while it is read, so this keeps a seed of large entries well inside
 * the seeder's smallest memory size (512 MB), however few of the 32 puts that
 * leaves in flight. An entry larger than this on its own still goes, alone.
 */
const MAX_BYTES_IN_FLIGHT = 128 * 1024 ** 2;

/** One init cache file, keyed relative to `<buildId>/`. */
export interface SeedEntry {
  readonly key: string;
  /** Its size once read, in bytes. */
  readonly size: number;
  read(): Promise<Buffer>;
}

/** The init cache, opened. `close` releases whatever opening it took. */
export interface Seed {
  readonly entries: readonly SeedEntry[];
  close(): Promise<void>;
}

export interface SeedCacheProps {
  readonly bucketName: string;
  readonly buildId: string;
  /**
   * Opens the init cache. Only called once the build is known not to be
   * seeded, so a rollback never downloads it.
   */
  readonly openSeed: () => Promise<Seed>;
  /**
   * Epoch ms after which no further put starts and the seed fails, so a custom
   * resource reports FAILED before its Lambda times out rather than leaving
   * CloudFormation waiting an hour for a response.
   */
  readonly deadline?: number;
}

export interface SeedCacheResult {
  /**
   * - `already-seeded`: `<buildId>/.seeded` exists, nothing was written.
   * - `no-seed`: the init cache is empty, nothing was written and no marker
   *   either.
   * - `seeded`: the init cache was written and the marker after it.
   */
  readonly status: "already-seeded" | "no-seed" | "seeded";
  /** Objects written into `<buildId>/`. */
  readonly written: number;
  /** Objects left alone because `<buildId>/` already had that key. */
  readonly skipped: number;
}

/**
 * Write the init cache into `<buildId>/`, once per build, without overwriting
 * anything the app has written there.
 *
 * - If `<buildId>/.seeded` exists, nothing is written. A CloudFormation
 *   rollback re-runs the previous build's seeding with its old properties, and
 *   so does a re-deploy of the same build; by then the app may have
 *   regenerated entries, or deleted them, and the build-time copy must not come
 *   back (cdklabs/cdk-nextjs#343).
 * - Every put is conditional on the key not existing (`If-None-Match: *`), so
 *   an entry the app wrote first - for a request it served while a previous
 *   attempt was seeding - wins. That also makes a retry after a partial seed
 *   safe: what made it the first time is skipped.
 * - The marker is written last, and only when there was something to seed and
 *   every entry was either written or skipped. A failure throws without it, so
 *   the next attempt writes what is still missing.
 */
export async function seedCache(
  props: SeedCacheProps,
): Promise<SeedCacheResult> {
  const { bucketName, buildId, deadline = Infinity } = props;
  const markerKey = `${buildId}/${CACHE_SEEDED_MARKER}`;

  if (await objectExists(bucketName, markerKey)) {
    debug(`${markerKey} exists, skipping seed`);
    return { status: "already-seeded", written: 0, skipped: 0 };
  }

  checkDeadline(deadline, 0, 0);
  const seed = await props.openSeed();
  let written = 0;
  let skipped = 0;
  try {
    await forEachConcurrently(seed.entries, async (entry) => {
      checkDeadline(deadline, written, skipped);
      const body = await entry.read();
      if (
        await putIfAbsent(
          bucketName,
          `${buildId}/${entry.key}`,
          // Every init cache file is JSON, `.long` ones included
          // (`cacheObjectName`); the cache handler writes the same type.
          { body, contentType: "application/json" },
          deadline,
        )
      ) {
        written++;
      } else {
        skipped++;
      }
    });
  } finally {
    await seed.close();
  }

  if (seed.entries.length === 0) {
    console.warn(`The init cache for ${buildId} is empty; nothing to seed`);
    return { status: "no-seed", written, skipped };
  }

  // Conditional too, and retried on a 409 like the entries: an overlapping
  // seed of the same build (a hotswap's and CloudFormation's) may be writing
  // it, and either marker is as good as the other.
  await putIfAbsent(
    bucketName,
    markerKey,
    { body: new Date().toISOString(), contentType: "text/plain" },
    deadline,
  );
  debug(`Seeded ${buildId}: wrote ${written}, skipped ${skipped}`);
  return { status: "seeded", written, skipped };
}

function checkDeadline(deadline: number, written: number, skipped: number) {
  if (Date.now() > deadline) {
    throw new Error(
      `Cache seeding ran out of time after writing ${written} and skipping ${skipped} objects; the next attempt skips what this one wrote, though it still asks S3 for each key, so a seed this size may need a longer timeout`,
    );
  }
}

/**
 * Run `fn` over `entries`, at most {@link PUT_CONCURRENCY} at a time and
 * {@link MAX_BYTES_IN_FLIGHT} bytes of them at once. Rejects with the first
 * error, after which nothing new starts; but only once every call in flight
 * has settled, so the caller doesn't close the seed under them, nor report a
 * failure while their puts are still landing.
 */
async function forEachConcurrently(
  entries: readonly SeedEntry[],
  fn: (entry: SeedEntry) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  let bytesInFlight = 0;
  let waiting: Array<() => void> = [];
  const worker = async () => {
    while (!failed && next < entries.length) {
      const entry = entries[next++];
      while (
        bytesInFlight > 0 &&
        bytesInFlight + entry.size > MAX_BYTES_IN_FLIGHT
      ) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      if (failed) return;
      bytesInFlight += entry.size;
      try {
        await fn(entry);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      } finally {
        bytesInFlight -= entry.size;
        const woken = waiting;
        waiting = [];
        woken.forEach((resolve) => resolve());
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PUT_CONCURRENCY, entries.length) }, worker),
  );
  if (failed) throw firstError;
}

/**
 * Attempts at a put S3 answers with 409, a conditional write racing it, with
 * exponential backoff from 100 ms between them: about 1.5 s in all.
 */
const CONFLICT_ATTEMPTS = 5;

/**
 * Put `object` at `key` unless the key exists. Returns whether it wrote.
 *
 * 412 is S3 saying the key exists. 409 is another conditional write to the
 * same key still in progress - the app's, or an overlapping seed's, which may
 * yet fail - so the put is retried, and a 412 then means that write landed and
 * wins. One that still conflicts, or would retry past `deadline`, throws, so
 * no marker is written and the next attempt fills the key in.
 */
async function putIfAbsent(
  bucketName: string,
  key: string,
  object: { body: Buffer | string; contentType: string },
  deadline: number,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: object.body,
          ContentType: object.contentType,
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (error) {
      const status = httpStatus(error);
      if (status === 412) {
        debug(`${key} already written, skipping`);
        return false;
      }
      if (status !== 409 || attempt >= CONFLICT_ATTEMPTS) throw error;
      const backoff = 100 * 2 ** (attempt - 1);
      if (Date.now() + backoff > deadline) {
        // Out of time, not a lasting conflict: say so, as `checkDeadline` does.
        throw new Error(
          `Cache seeding ran out of time retrying a conflicting write to ${key}; the next attempt fills it in`,
          { cause: error },
        );
      }
      debug(`${key} has a conflicting write, retrying`);
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

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}
