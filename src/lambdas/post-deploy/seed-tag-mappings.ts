// eslint-disable-next-line import/no-extraneous-dependencies
import {
  BatchWriteItemCommand,
  DynamoDBClient,
  WriteRequest,
} from "@aws-sdk/client-dynamodb";
// eslint-disable-next-line import/no-extraneous-dependencies
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import {
  INIT_CACHE_TAG_MANIFEST,
  InitCacheTagManifest,
} from "../../adapter/cache-utils";

const debug = getDebug("cdk-nextjs:post-deploy:seed-tag-mappings");

const dynamoClient = new DynamoDBClient();
const s3Client = new S3Client();

/** DynamoDB's hard limit on a `BatchWriteItem` request. */
const BATCH_SIZE = 25;
/** How many batches to keep in flight. */
const CONCURRENCY = 4;

interface SeedTagMappingsProps {
  bucketName: string;
  tableName: string;
  buildId: string;
}

/**
 * Give the build-time prerenders the same `tag#cacheKey` rows a runtime `set`
 * writes, from the manifest the adapter left in the init cache.
 *
 * `revalidateTag` uses those rows for two things a static page otherwise misses:
 * deleting the entry's S3 object, and deriving the CloudFront paths to
 * invalidate. A prerendered response is served with `s-maxage=31536000`, so
 * without the invalidation the CDN keeps answering with the old HTML (and the
 * old RSC payload) for a year no matter what the origin does - measured against
 * next.js's `test/e2e/app-dir/trailingslash`, whose revalidation cases fail on a
 * CloudFront-fronted deployment while passing against the origin.
 *
 * Absent manifest is normal: an app with no tagged prerenders writes none.
 */
export async function seedTagMappings(props: SeedTagMappingsProps) {
  const { bucketName, tableName, buildId } = props;
  const key = `${buildId}/${INIT_CACHE_TAG_MANIFEST}`;

  let manifest: InitCacheTagManifest;
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: key }),
    );
    const body = await response.Body?.transformToString();
    if (!body) {
      debug(`No body for s3://${bucketName}/${key}, nothing to seed`);
      return;
    }
    manifest = JSON.parse(body) as InitCacheTagManifest;
  } catch (error) {
    // A missing manifest is the common case, not a failure: only prerenders
    // that carry tags produce one.
    if (error instanceof NoSuchKey) {
      debug(`No tag manifest at s3://${bucketName}/${key}`);
      return;
    }
    // Anything else is a real failure that happens to look identical from the
    // outside: `AccessDenied` or a truncated body seeds nothing, and the symptom
    // — `revalidateTag` never invalidating the CDN — is the bug this function
    // exists to prevent. Warned rather than thrown, because failing the custom
    // resource would roll back an otherwise healthy deployment over a
    // best-effort optimization.
    console.warn(
      `Could not read the tag manifest at s3://${bucketName}/${key}, so no tag ` +
        `mappings were seeded: on-demand revalidation of build-time prerenders ` +
        `will not invalidate CloudFront. ${error}`,
    );
    return;
  }

  const createdAt = { N: Date.now().toString() };
  const requests: WriteRequest[] = [];
  for (const [tag, cacheKeys] of Object.entries(manifest)) {
    for (const cacheKey of cacheKeys) {
      requests.push({
        PutRequest: {
          Item: {
            pk: { S: buildId },
            // Same shape the cache handler's `storeDynamoDBTagMappings` writes,
            // including the `.json` suffix `buildS3Key` adds, because
            // `revalidateTag` reads the S3 key straight back out of the sort key.
            sk: { S: `${tag}#${buildId}/${cacheKey}.json` },
            createdAt,
          },
        },
      });
    }
  }

  if (requests.length === 0) {
    return;
  }

  const batches: WriteRequest[][] = [];
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    batches.push(requests.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `Seeding ${requests.length} tag mappings for ${Object.keys(manifest).length} tags into ${tableName}`,
  );

  let next = 0;
  let unseeded = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) })
    .fill(null)
    .map(async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        unseeded += await writeBatch(tableName, batch);
      }
    });
  await Promise.all(workers);

  if (unseeded === requests.length) {
    // Every batch failing is not "a lost row": it means no prerender is reachable
    // by `revalidateTag` at all, which is the failure this whole function exists
    // to prevent, and it is otherwise indistinguishable from an app that has no
    // tagged prerenders.
    console.warn(
      `None of the ${requests.length} tag mappings could be seeded into ` +
        `${tableName}: on-demand revalidation of build-time prerenders will not ` +
        `invalidate CloudFront.`,
    );
  } else if (unseeded > 0) {
    console.warn(
      `${unseeded} of ${requests.length} tag mappings were unseeded`,
    );
  }
  debug(`Seeded ${requests.length - unseeded} tag mappings`);
}

/**
 * One `BatchWriteItem`, returning how many of its rows were left unwritten.
 *
 * Retries both of the ways it can come back short — items DynamoDB declined
 * (`UnprocessedItems`) and a thrown error, which for a throttle or a brief
 * network fault is the same situation. Bailing out on the first exception meant a
 * transient error dropped a batch of 25 rows that a second attempt would have
 * written.
 *
 * Seeding stays best-effort: a lost row costs a CloudFront invalidation on the
 * next revalidation of that tag, not correctness, so exhausted retries are counted
 * and reported rather than failing the deployment.
 */
async function writeBatch(
  tableName: string,
  batch: WriteRequest[],
): Promise<number> {
  let pending = batch;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
    try {
      const response = await dynamoClient.send(
        new BatchWriteItemCommand({ RequestItems: { [tableName]: pending } }),
      );
      pending = response.UnprocessedItems?.[tableName] ?? [];
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    console.warn(`Failed to seed a batch of tag mappings: ${lastError}`);
  }
  return pending.length;
}
