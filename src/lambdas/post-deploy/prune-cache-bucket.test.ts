/* eslint-disable import/no-extraneous-dependencies */
// Only the client is mocked, as in `prune-s3.test.ts`: `prune-cache-bucket`
// constructs its client at module scope, before the mock variables exist.
jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn(() => ({
    send: (...args: unknown[]) => holder.send(...args),
  })),
}));

import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { pruneCacheBucket } from "./prune-cache-bucket";

const holder = { send: jest.fn() };

/**
 * Pages of listed keys, each asked for by the token `page-<index>`; the last
 * carries no NextContinuationToken, as S3 returns it.
 */
function stubPages(pages: string[][]): void {
  holder.send.mockImplementation((command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      const token = command.input.ContinuationToken;
      const index = token ? Number(token.replace("page-", "")) : 0;
      return Promise.resolve({
        Contents: pages[index].map((Key) => ({ Key })),
        NextContinuationToken:
          index + 1 < pages.length ? `page-${index + 1}` : undefined,
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

describe("pruneCacheBucket", () => {
  beforeEach(() => {
    holder.send.mockReset();
  });

  // Keeping the previous page's token re-listed the last page until the
  // 100-page guard tripped, deleting its keys 100 times over.
  it("stops listing once a page returns no continuation token", async () => {
    stubPages([
      ["old/a.json", "current/a.json"],
      ["old/b.json", "current/b.json"],
    ]);

    await pruneCacheBucket({ bucketName: "cache", currentBuildId: "current" });

    expect(sent(ListObjectsV2Command)).toHaveLength(2);
    expect(
      sent(DeleteObjectsCommand).flatMap((command) =>
        command.input.Delete!.Objects!.map((object) => object.Key),
      ),
    ).toEqual(["old/a.json", "old/b.json"]);
  });
});
