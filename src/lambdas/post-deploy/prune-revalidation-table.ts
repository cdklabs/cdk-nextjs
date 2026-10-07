// eslint-disable-next-line import/no-extraneous-dependencies
import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  BatchWriteItemCommand,
  WriteRequest,
} from "@aws-sdk/client-dynamodb";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import { processBatch } from "./prune-s3";

const debug = getDebug("cdk-nextjs:post-deploy:prune-revalidation-table");

const dynamoClient = new DynamoDBClient();

/** How many times a delete batch is sent, counting the first. */
const DELETE_ATTEMPTS = 4;
/** The pause before the first resend; it doubles for each one after. */
const DELETE_RETRY_BASE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PruneRevalidationTableProps {
  tableName: string;
  currentBuildId: string;
}

/**
 * Given `tableName` and `currentBuildId`, query the previous build's revalidation entries
 * and delete them efficiently. Uses metadata entry to track current build ID.
 *
 * Schema:
 * - Tag marker rows: pk=buildId, sk=tag (hashed past a length limit)
 * - Tag mapping rows: pk=buildId, sk=tag#s3Key
 * - Revalidation log rows: pk=buildId#log, sk=timestamp#tag
 * - Metadata entry: pk="METADATA", sk="CURRENT_BUILD", buildId=currentBuildId
 */
export async function pruneRevalidationTable(
  props: PruneRevalidationTableProps,
) {
  const { tableName, currentBuildId } = props;

  // 1. Read metadata to get previous build ID
  const getCommand = new GetItemCommand({
    TableName: tableName,
    Key: {
      pk: { S: "METADATA" },
      sk: { S: "CURRENT_BUILD" },
    },
  });

  let previousBuildId: string | undefined;
  try {
    const metadataResponse = await dynamoClient.send(getCommand);
    previousBuildId = metadataResponse.Item?.buildId?.S;
  } catch (error) {
    debug("No metadata entry found, this may be the first deployment");
  }

  if (!previousBuildId) {
    debug("No previous build to prune");
    // Update metadata with current build ID for next deployment
    await updateMetadata(tableName, currentBuildId);
    return;
  }

  if (previousBuildId === currentBuildId) {
    debug(
      `Previous build ID matches current build ID (${currentBuildId}), nothing to prune`,
    );
    return;
  }

  debug(`Pruning revalidation entries for previous build: ${previousBuildId}`);

  // 2. Query all items for previous build ID (efficient partition queries):
  // its marker rows, and its revalidation log rows, which a table without TTL
  // would otherwise keep forever.
  const itemsToDelete: Array<{ pk: { S: string }; sk: { S: string } }> = [];

  for (const pk of [previousBuildId, `${previousBuildId}#log`]) {
    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    do {
      const queryCommand: QueryCommand = new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: pk },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      });

      const response = await dynamoClient.send(queryCommand);

      for (const item of response.Items ?? []) {
        if (item.pk?.S && item.sk?.S) {
          itemsToDelete.push({
            pk: { S: item.pk.S },
            sk: { S: item.sk.S },
          });
        }
      }

      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  }

  debug(
    `Found ${itemsToDelete.length} revalidation entries to delete for build ${previousBuildId}`,
  );

  // 3. Delete items in batches (respecting DynamoDB's 25 items per batch limit)
  if (itemsToDelete.length > 0) {
    const deleteBatches = [];

    for (let i = 0; i < itemsToDelete.length; i += 25) {
      const batch = itemsToDelete.slice(i, i + 25);
      deleteBatches.push(batch);
    }

    await processBatch(
      deleteBatches,
      5, // Process up to 5 delete batches in parallel
      async (batch) => {
        let requests: WriteRequest[] | undefined = batch.map((item) => ({
          DeleteRequest: {
            Key: item,
          },
        }));
        try {
          debug(
            `Deleting revalidation entries: ${batch.map((b) => `${b.pk.S}/${b.sk.S}`).join(", ")} from ${tableName}`,
          );

          // `UnprocessedItems` is DynamoDB declining part of the batch under
          // load, so those are sent again after a pause.
          for (
            let attempt = 0;
            requests?.length && attempt < DELETE_ATTEMPTS;
            attempt++
          ) {
            if (attempt > 0) {
              await sleep(DELETE_RETRY_BASE_MS * 2 ** (attempt - 1));
            }
            const response = await dynamoClient.send(
              new BatchWriteItemCommand({
                RequestItems: {
                  [tableName]: requests,
                },
              }),
            );
            requests = response.UnprocessedItems?.[tableName];
          }
        } catch (error) {
          console.error("Error deleting revalidation entries:", error);
          return;
        }

        if (requests?.length) {
          console.error(
            `DynamoDB left ${requests.length} revalidation entries undeleted after retrying`,
          );
        } else {
          debug(
            `Deleted ${batch.length} revalidation entries from ${tableName}`,
          );
        }
      },
    );
  }

  // 4. Update metadata with new build ID
  await updateMetadata(tableName, currentBuildId);

  debug(
    `Revalidation table pruning complete. Deleted ${itemsToDelete.length} entries from ${tableName}`,
  );
}

/**
 * Update the metadata entry with the current build ID
 */
async function updateMetadata(
  tableName: string,
  currentBuildId: string,
): Promise<void> {
  const putCommand = new PutItemCommand({
    TableName: tableName,
    Item: {
      pk: { S: "METADATA" },
      sk: { S: "CURRENT_BUILD" },
      buildId: { S: currentBuildId },
      updatedAt: { N: Date.now().toString() },
    },
  });

  await dynamoClient.send(putCommand);
  debug(`Updated metadata with current build ID: ${currentBuildId}`);
}
