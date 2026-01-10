// eslint-disable-next-line import/no-extraneous-dependencies
import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  ScanCommandInput,
} from "@aws-sdk/client-dynamodb";
import { debug } from "../utils";

const dynamoClient = new DynamoDBClient();

interface PruneRevalidationTableProps {
  tableName: string;
  currentBuildId: string;
}

/**
 * Given `tableName` and `currentBuildId`, scan the DynamoDB table
 * and delete any entries that have BUILD_ID prefixes that don't match the current build ID.
 * Revalidation entries use the pattern {buildId}#{tag} as the partition key.
 */
export async function pruneRevalidationTable(
  props: PruneRevalidationTableProps,
) {
  const { tableName, currentBuildId } = props;

  const itemsToDelete: Array<{ tag: { S: string }; cacheKey: { S: string } }> =
    [];
  let lastEvaluatedKey: Record<string, any> | undefined = undefined;
  let scanCount = 0;

  do {
    // Scan the table to find all items
    const scanInput: ScanCommandInput = {
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey,
    };
    const scanResponse = await dynamoClient.send(new ScanCommand(scanInput));

    if (!scanResponse.Items || scanResponse.Items.length === 0) {
      break;
    }

    // Filter items that have old BUILD_ID prefixes
    const oldRevalidationItems = scanResponse.Items.filter((item) => {
      const tagValue = item.tag?.S;
      if (!tagValue) return false;

      // Check if the tag starts with a BUILD_ID prefix pattern
      // Expected pattern: {buildId}#{tag}
      const buildIdMatch = tagValue.match(/^([^#]+)#/);
      if (buildIdMatch) {
        const itemBuildId = buildIdMatch[1];
        // Delete if it's not the current build ID
        return itemBuildId !== currentBuildId;
      }

      // Also delete items that don't follow the BUILD_ID prefix pattern
      // These might be legacy revalidation entries
      return true;
    });

    debug(
      `Found ${oldRevalidationItems.length} revalidation entries with old BUILD_ID prefixes to delete`,
    );

    // Add items to delete list
    for (const item of oldRevalidationItems) {
      if (item.tag?.S && item.cacheKey?.S) {
        itemsToDelete.push({
          tag: { S: item.tag.S },
          cacheKey: { S: item.cacheKey.S },
        });
      }
    }

    lastEvaluatedKey = scanResponse.LastEvaluatedKey;
    scanCount++;
    // Limit scan operations to prevent excessive costs
  } while (lastEvaluatedKey && scanCount <= 100);

  // Delete items in batches (respecting DynamoDB's 25 items per batch limit)
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
            `Deleting revalidation entries: ${batch.map((b) => `${b.tag.S}/${b.cacheKey.S}`)} from ${tableName}`,
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

  debug(
    `Revalidation table pruning complete. Deleted ${itemsToDelete.length} entries from ${tableName}`,
  );
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
