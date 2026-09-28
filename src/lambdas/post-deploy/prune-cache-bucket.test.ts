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
 * A fake bucket: ListObjectsV2 honours `Prefix` and `Delimiter`, and pages
 * `pageSize` keys at a time via the token `<offset>`; the last page carries no
 * NextContinuationToken, as S3 returns it.
 */
function stubBucket(keys: string[], pageSize = 2): void {
  holder.send.mockImplementation((command: unknown) => {
    if (!(command instanceof ListObjectsV2Command)) return Promise.resolve({});
    const { Prefix = "", Delimiter, ContinuationToken } = command.input;
    const entries: { key?: string; prefix?: string }[] = [];
    for (const key of keys.filter((k) => k.startsWith(Prefix))) {
      const cut = Delimiter ? key.indexOf(Delimiter, Prefix.length) : -1;
      if (cut < 0) {
        entries.push({ key });
      } else {
        const prefix = key.slice(0, cut + 1);
        if (!entries.some((entry) => entry.prefix === prefix)) {
          entries.push({ prefix });
        }
      }
    }
    const offset = Number(ContinuationToken ?? 0);
    const page = entries.slice(offset, offset + pageSize);
    return Promise.resolve({
      Contents: page.filter((e) => e.key).map((e) => ({ Key: e.key })),
      CommonPrefixes: page
        .filter((e) => e.prefix)
        .map((e) => ({ Prefix: e.prefix })),
      NextContinuationToken:
        offset + pageSize < entries.length
          ? String(offset + pageSize)
          : undefined,
    });
  });
}

function sent<T>(type: new (...args: any[]) => T): T[] {
  return holder.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof type);
}

function deletedKeys(): (string | undefined)[] {
  return sent(DeleteObjectsCommand).flatMap((command) =>
    command.input.Delete!.Objects!.map((object) => object.Key),
  );
}

describe("pruneCacheBucket", () => {
  beforeEach(() => {
    holder.send.mockReset();
  });

  it("deletes every old build prefix across pages, and loose keys", async () => {
    stubBucket([
      "current/a.json",
      "current/_use-cache/1.entry",
      "old1/a.json",
      "old1/_use-cache/1.entry",
      "old1/_use-cache/2.entry",
      "old2/a.json",
      "loose.json",
      "/leading-slash.json",
    ]);

    await pruneCacheBucket({ bucketName: "cache", currentBuildId: "current" });

    expect(deletedKeys().sort()).toEqual(
      [
        "/leading-slash.json",
        "loose.json",
        "old1/_use-cache/1.entry",
        "old1/_use-cache/2.entry",
        "old1/a.json",
        "old2/a.json",
      ].sort(),
    );
  });

  // The current build can hold unbounded 'use cache: remote' entries, so it
  // must never be walked: the delimited top-level listing only names it.
  it("never lists inside the current build", async () => {
    stubBucket([
      ...Array.from({ length: 10 }, (_, i) => `current/_use-cache/${i}.entry`),
      "old/a.json",
    ]);

    await pruneCacheBucket({ bucketName: "cache", currentBuildId: "current" });

    expect(
      sent(ListObjectsV2Command).map(
        ({ input }) => input.Delimiter ?? input.Prefix,
      ),
    ).toEqual(["/", "old/"]);
    expect(deletedKeys()).toEqual(["old/a.json"]);
  });

  // A huge old build must not run the Lambda into its timeout, which would
  // leave CloudFormation waiting on the custom resource.
  it("stops at its time budget and leaves the rest for the next deploy", async () => {
    stubBucket(["old/a.json", "old/b.json", "old/c.json"], 1);
    let clock = 0;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => clock);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    holder.send.mockImplementation(
      ((stub) => (command: unknown) => {
        if (command instanceof DeleteObjectsCommand) clock += 2 * 60_000;
        return stub(command);
      })(holder.send.getMockImplementation()!),
    );

    await pruneCacheBucket({ bucketName: "cache", currentBuildId: "current" });

    expect(deletedKeys()).toEqual(["old/a.json", "old/b.json"]);
    expect(warnSpy).toHaveBeenCalled();
    nowSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
