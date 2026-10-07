/* eslint-disable import/no-extraneous-dependencies */
// Only the client is mocked, as in `prune-cache-bucket.test.ts`: the module
// constructs its client at module scope, before the mock variables exist.
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({
    send: (...args: unknown[]) => holder.send(...args),
  })),
}));

import {
  BatchWriteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { pruneRevalidationTable } from "./prune-revalidation-table";

const holder = { send: jest.fn() };

/**
 * A fake table whose metadata names `previousBuildId`; each Query pages
 * `pageSize` rows at a time of the partition asked for.
 */
function stubTable(
  previousBuildId: string,
  rows: Record<string, string[]>,
  pageSize = 2,
): void {
  holder.send.mockImplementation((command: unknown) => {
    if (command instanceof GetItemCommand) {
      return Promise.resolve({ Item: { buildId: { S: previousBuildId } } });
    }
    if (command instanceof QueryCommand) {
      const pk = command.input.ExpressionAttributeValues![":pk"].S!;
      const offset = Number(command.input.ExclusiveStartKey?.offset.N ?? 0);
      const sks = rows[pk] ?? [];
      return Promise.resolve({
        Items: sks
          .slice(offset, offset + pageSize)
          .map((sk) => ({ pk: { S: pk }, sk: { S: sk } })),
        LastEvaluatedKey:
          offset + pageSize < sks.length
            ? { offset: { N: String(offset + pageSize) } }
            : undefined,
      });
    }
    return Promise.resolve({});
  });
}

function sent<T>(type: new (...args: any[]) => T): T[] {
  return holder.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof type);
}

describe("pruneRevalidationTable", () => {
  beforeEach(() => {
    holder.send.mockReset();
  });

  it("deletes the previous build's marker and log rows, then records the current build", async () => {
    stubTable("old", {
      old: ["tag-a", "tag-b", "tag-c"],
      "old#log": ["000000000000001#tag-a", "000000000000002#tag-b"],
      current: ["tag-a"],
      "current#log": ["000000000000003#tag-a"],
    });

    await pruneRevalidationTable({
      tableName: "table",
      currentBuildId: "current",
    });

    const deleted = sent(BatchWriteItemCommand).flatMap((command) =>
      command.input.RequestItems!.table.map(
        (request) =>
          `${request.DeleteRequest!.Key!.pk.S}/${request.DeleteRequest!.Key!.sk.S}`,
      ),
    );
    expect(deleted.sort()).toEqual(
      [
        "old/tag-a",
        "old/tag-b",
        "old/tag-c",
        "old#log/000000000000001#tag-a",
        "old#log/000000000000002#tag-b",
      ].sort(),
    );
    expect(sent(PutItemCommand)[0].input.Item!.buildId.S).toBe("current");
  });

  it("sends the rows DynamoDB left unprocessed again", async () => {
    stubTable("old", { old: ["tag-a", "tag-b"] });
    const stub = holder.send.getMockImplementation()!;
    let writes = 0;
    holder.send.mockImplementation((command: unknown) => {
      if (command instanceof BatchWriteItemCommand && writes++ === 0) {
        const [, second] = command.input.RequestItems!.table;
        return Promise.resolve({ UnprocessedItems: { table: [second] } });
      }
      return stub(command);
    });

    await pruneRevalidationTable({
      tableName: "table",
      currentBuildId: "current",
    });

    const batches = sent(BatchWriteItemCommand).map((command) =>
      command.input.RequestItems!.table.map(
        (request) => request.DeleteRequest!.Key!.sk.S,
      ),
    );
    expect(batches).toEqual([["tag-a", "tag-b"], ["tag-b"]]);
  });
});
