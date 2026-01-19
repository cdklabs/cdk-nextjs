// eslint-disable-next-line import/no-extraneous-dependencies
import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import getDebug from "debug";

const debug = getDebug("cdk-nextjs:post-deploy:prune-revalidation-table");

const dynamoClient = new DynamoDBClient();

interface PruneRevalidationTableProps {
  tableName: string;
  currentBuildId: string;
}

/**
 * Given `tableName` and `currentBuildId`, query the previous build's revalidation entries
 * and delete them efficiently. Uses metadata entry to track current build ID.
 *
 * Schema:
 * - Revalidation entries: pk=buildId, sk=tag#cacheKey
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

  // 2. Query all items for previous build ID (efficient partition query)
  const itemsToDelete: Array<{ pk: { S: string }; sk: { S: string } }> = [];
  let lastEvaluatedKey: Record<string, any> | undefined = undefined;

  do {
    const queryCommand: QueryCommand = new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: previousBuildId },
      },
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const response = await dynamoClient.send(queryCommand);

    if (response.Items && response.Items.length > 0) {
      for (const item of response.Items) {
        if (item.pk?.S && item.sk?.S) {
          itemsToDelete.push({
            pk: { S: item.pk.S },
            sk: { S: item.sk.S },
          });
        }
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

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
        try {
          const deleteRequests = batch.map((item) => ({
            DeleteRequest: {
              Key: item,
            },
          }));

          debug(
            `Deleting revalidation entries: ${batch.map((b) => `${b.pk.S}/${b.sk.S}`).join(", ")} from ${tableName}`,
          );

          await dynamoClient.send(
            new BatchWriteItemCommand({
              RequestItems: {
                [tableName]: deleteRequests,
              },
            }),
          );

          debug(
            `Deleted ${batch.length} revalidation entries from ${tableName}`,
          );
        } catch (error) {
          console.error("Error deleting revalidation entries:", error);
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

/**
 * Process items in batches to avoid overwhelming the system
 */
async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  processFn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);
  }

  return results;
}
